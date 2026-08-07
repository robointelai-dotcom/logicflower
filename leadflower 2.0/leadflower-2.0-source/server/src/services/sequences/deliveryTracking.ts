import Organization from '../../models/Organization'
import SendRecord from '../../models/SendRecord'

/**
 * Delivery tracking, and the switch that turns the invasive part of it off.
 *
 * Delivery and bounce state is operational: without it the engine cannot
 * suppress, cannot retry correctly and cannot tell an operator whether anything
 * arrived. Open and click tracking is different in kind — it records a person's
 * behaviour, needs a tracking pixel and a rewritten link, and in several
 * jurisdictions needs a lawful basis the operator may not have. So the two are
 * separated: delivery state is always recorded, engagement tracking is per
 * organisation and defaults to off.
 */

const TRACKING_CACHE_MS = 30_000
const cache = new Map<string, { enabled: boolean; readAt: number }>()

/** Test seam. */
export function resetTrackingCache(): void {
  cache.clear()
}

/**
 * Is engagement tracking permitted for this organisation?
 *
 * Fails closed: an organisation whose record cannot be read is treated as
 * tracking-disabled. Recording someone's behaviour because a lookup failed is
 * the wrong way round.
 */
export async function trackingEnabledFor(organizationId: string): Promise<boolean> {
  const cached = cache.get(organizationId)
  if (cached && Date.now() - cached.readAt < TRACKING_CACHE_MS) return cached.enabled
  try {
    const organization: any = await Organization.findOne({ _id: organizationId }).select('engagementTrackingEnabled').lean()
    const enabled = Boolean(organization?.engagementTrackingEnabled)
    cache.set(organizationId, { enabled, readAt: Date.now() })
    return enabled
  } catch {
    return false
  }
}

export interface DeliverySummary {
  queued: number
  sent: number
  delivered: number
  opened: number
  clicked: number
  bounced: number
  failed: number
  suppressed: number
  outcomeUnknown: number
}

const EMPTY_SUMMARY: DeliverySummary = {
  queued: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0, suppressed: 0, outcomeUnknown: 0,
}

/**
 * Aggregate send state.
 *
 * `outcomeUnknown` is reported as its own figure and never folded into
 * `failed`. They call for opposite responses: a failure can be retried, an
 * unknown outcome must not be.
 */
export async function deliverySummary(input: { organizationId: string; sequenceId?: string; enrolmentId?: string }): Promise<DeliverySummary> {
  const match: Record<string, unknown> = {}
  match.organizationId = input.organizationId
  if (input.sequenceId) match.sequenceId = input.sequenceId
  if (input.enrolmentId) match.enrolmentId = input.enrolmentId

  const rows: any[] = await SendRecord.aggregate([
    { $match: { organizationId: input.organizationId, ...match } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ])

  const summary: DeliverySummary = { ...EMPTY_SUMMARY }
  for (const row of rows) {
    const key = String(row._id) === 'outcome_unknown' ? 'outcomeUnknown' : String(row._id)
    if (key in summary) (summary as unknown as Record<string, number>)[key] = Number(row.count || 0)
  }
  return summary
}
