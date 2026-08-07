import crypto from 'crypto'
import UsageAlert from '../models/UsageAlert'
import NotificationChannel from '../models/NotificationChannel'
import Alert from '../models/Alert'

/**
 * Usage threshold alerting and overage accounting.
 *
 * The feasibility report states two pricing rules that the codebase did not
 * implement: "overage never surprises — warn at 80% and 100%, allow a hard
 * stop, and never bill silently past an allowance", and an overage rate per
 * 10,000 records that the revenue model depends on.
 *
 * Previously the only behaviour at a plan limit was a 429. That satisfies "hard
 * stop" and nothing else: the customer discovers the limit by having work fail.
 */

export const USAGE_THRESHOLDS = [80, 100] as const
export type UsageThreshold = (typeof USAGE_THRESHOLDS)[number]

/** Overage price in cents per 10,000 records, per report section 24.4. */
export const OVERAGE_CENTS_PER_10K: Record<string, number> = {
  starter: 600,
  agency: 500,
  scale: 400,
}

export const OVERAGE_BLOCK_SIZE = 10_000

export interface ThresholdCrossing {
  threshold: UsageThreshold
  metric: string
  used: number
  limit: number
  percentUsed: number
  periodStart: Date
  periodEnd: Date
}

/**
 * Determine which thresholds a reservation crossed.
 *
 * Crossings are computed from the before/after counter values rather than from
 * the after value alone, so a single large batch that jumps from 10% to 100%
 * raises both the 80% and the 100% notice instead of only the last one.
 */
export function thresholdsCrossed(previousUsed: number, newUsed: number, limit: number): UsageThreshold[] {
  if (!Number.isFinite(limit) || limit <= 0) return []
  const crossed: UsageThreshold[] = []
  for (const threshold of USAGE_THRESHOLDS) {
    const boundary = (limit * threshold) / 100
    if (previousUsed < boundary && newUsed >= boundary) crossed.push(threshold)
  }
  return crossed
}

/**
 * Overage units for a period, in whole 10,000-record blocks, rounded up.
 *
 * Partial blocks bill as a full block, matching the report's per-10,000 pricing
 * table. Returning zero when the plan has no rate means an unpriced plan can
 * never accrue a charge.
 */
export function overageUnits(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0 || used <= limit) return 0
  return Math.ceil((used - limit) / OVERAGE_BLOCK_SIZE)
}

export function overageCents(plan: string, used: number, limit: number): number {
  const rate = OVERAGE_CENTS_PER_10K[String(plan).toLowerCase()]
  if (!rate) return 0
  return overageUnits(used, limit) * rate
}

function fingerprint(organizationId: string, metric: string, threshold: number, periodStart: Date): string {
  return crypto.createHash('sha256')
    .update(`${organizationId}:${metric}:${threshold}:${periodStart.toISOString()}`)
    .digest('hex')
}

/**
 * Record a threshold crossing and route a notification exactly once per
 * organisation, metric, threshold and billing period.
 *
 * Idempotency is enforced by a unique index rather than by a read-then-write,
 * because two workers processing the same batch chunk concurrently will
 * otherwise both decide they are first.
 */
export async function recordThresholdCrossing(input: {
  organizationId: string
  plan: string
  metric: string
  threshold: UsageThreshold
  used: number
  limit: number
  periodStart: Date
  periodEnd: Date
}): Promise<{ created: boolean }> {
  const key = fingerprint(input.organizationId, input.metric, input.threshold, input.periodStart)
  try {
    await UsageAlert.create({
      organizationId: input.organizationId,
      metric: input.metric,
      threshold: input.threshold,
      plan: input.plan,
      used: input.used,
      limit: input.limit,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      fingerprint: key,
      raisedAt: new Date(),
    })
  } catch (error: any) {
    if (error?.code === 11000) return { created: false }
    throw error
  }

  const subject = input.threshold >= 100
    ? `Usage limit reached for ${input.metric}`
    : `Usage at ${input.threshold}% for ${input.metric}`
  const message = input.threshold >= 100
    ? `Your organisation has used ${input.used.toLocaleString()} of ${input.limit.toLocaleString()} included ${input.metric} for the period ending ${input.periodEnd.toISOString().slice(0, 10)}. Further work is paused unless overage is enabled on your plan.`
    : `Your organisation has used ${input.used.toLocaleString()} of ${input.limit.toLocaleString()} included ${input.metric} (${input.threshold}%) for the period ending ${input.periodEnd.toISOString().slice(0, 10)}.`

  const channels: any[] = await NotificationChannel.find({
    organizationId: input.organizationId,
    enabled: true,
    status: 'verified',
    events: { $in: ['usage.threshold', 'incident.created'] },
  })
  for (const channel of channels) {
    await Alert.create({
      organizationId: input.organizationId,
      channelId: channel._id,
      subject,
      message,
      status: 'pending',
      fingerprint: key,
    })
  }
  return { created: true }
}

/**
 * Evaluate thresholds after a usage counter moves. Never throws into the
 * caller's billable path: a failure to send a courtesy warning must not fail
 * the customer's job.
 */
export async function evaluateUsageThresholds(input: {
  organizationId: string
  plan: string
  metric: string
  previousUsed: number
  newUsed: number
  limit: number
  periodStart: Date
  periodEnd: Date
}): Promise<UsageThreshold[]> {
  const crossed = thresholdsCrossed(input.previousUsed, input.newUsed, input.limit)
  for (const threshold of crossed) {
    try {
      await recordThresholdCrossing({
        organizationId: input.organizationId,
        plan: input.plan,
        metric: input.metric,
        threshold,
        used: input.newUsed,
        limit: input.limit,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      })
    } catch {
      // Deliberately swallowed. Alert delivery is retried by the outbox worker.
    }
  }
  return crossed
}
