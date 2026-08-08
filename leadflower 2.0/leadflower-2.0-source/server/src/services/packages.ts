import Package from '../models/Package'
import { QuotaMetric, quotaMetrics } from '../models/UsageCounter'
import { PLAN_LIMITS, SubscriptionPlan } from './planLimits'

/**
 * Turning a subscription into the limits it actually gets.
 *
 * The resolution order, most specific first:
 *
 *   1. A per-customer quota override that has not expired.
 *   2. The package the subscription is pinned to.
 *   3. The built-in limits for the tier.
 *
 * Step 3 is the important one. Package management is new; every existing
 * customer has `packageId: null` and must keep receiving exactly the limits
 * they have today. A resolution path that returned zero — or threw — for an
 * unmigrated customer would take a working product off the air for everybody
 * the moment this shipped. So the built-ins remain the floor and the package is
 * an override on top, not a replacement underneath.
 */

export interface ResolvedLimits {
  limits: Record<QuotaMetric, number>
  /** Where each metric's number came from, for the admin screen and support. */
  sources: Record<QuotaMetric, 'override' | 'package' | 'tier_default'>
  packageCode: string | null
  packageVersion: number | null
}

/** A limit meaning "no ceiling". Large and finite so arithmetic stays safe. */
export const UNLIMITED = Number.MAX_SAFE_INTEGER

function tierDefaults(plan: SubscriptionPlan): Record<QuotaMetric, number> {
  const defaults = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free
  return { ...defaults }
}

function activeOverride(subscription: any, metric: QuotaMetric, at: Date) {
  const overrides: any[] = Array.isArray(subscription?.quotaOverrides) ? subscription.quotaOverrides : []
  // Last matching override wins, so raising a limit twice does what it looks
  // like it does rather than silently keeping the first.
  let found: any = null
  for (const override of overrides) {
    if (String(override?.metric) !== metric) continue
    if (override?.expiresAt && new Date(override.expiresAt) <= at) continue
    found = override
  }
  return found
}

/**
 * Resolve the limits for one subscription.
 *
 * Takes the already-loaded package rather than fetching it, so a caller inside
 * a usage-reservation transaction does not issue a second query per reservation
 * on the hot path.
 */
export function resolveLimits(input: {
  plan: SubscriptionPlan
  subscription: any
  packageDocument?: any | null
  at?: Date
}): ResolvedLimits {
  const at = input.at ?? new Date()
  const limits = tierDefaults(input.plan)
  const sources = {} as Record<QuotaMetric, 'override' | 'package' | 'tier_default'>

  for (const metric of quotaMetrics) {
    sources[metric] = 'tier_default'

    const packageQuota = Array.isArray(input.packageDocument?.quotas)
      ? input.packageDocument.quotas.find((quota: any) => String(quota?.metric) === metric)
      : null
    if (packageQuota) {
      limits[metric] = packageQuota.unlimited ? UNLIMITED : Number(packageQuota.included)
      sources[metric] = 'package'
    }

    const override = activeOverride(input.subscription, metric, at)
    if (override) {
      limits[metric] = override.unlimited ? UNLIMITED : Number(override.included)
      sources[metric] = 'override'
    }

    // A malformed package or override must never produce NaN or a negative
    // limit: both would compare falsely against usage and hand out free work.
    if (!Number.isFinite(limits[metric]) || limits[metric] < 0) {
      limits[metric] = tierDefaults(input.plan)[metric]
      sources[metric] = 'tier_default'
    }
  }

  return {
    limits,
    sources,
    packageCode: input.packageDocument?.code ?? null,
    packageVersion: input.packageDocument?.version ?? null,
  }
}

/** Load the package a subscription is pinned to, if any. */
export async function packageForSubscription(subscription: any): Promise<any | null> {
  if (!subscription?.packageId) return null
  const pinnedVersion = subscription.packageVersion
  const found: any = await Package.findOne({ _id: subscription.packageId }).lean()
  if (!found) return null
  // The pin is on (code, version). If the subscription names a version and the
  // referenced document is a different one, the pin is what counts — otherwise
  // publishing a revision would reprice customers who were promised it would
  // not.
  if (pinnedVersion && found.version !== pinnedVersion) {
    return await Package.findOne({ code: found.code, version: pinnedVersion }).lean() ?? found
  }
  return found
}

/**
 * The next version number for a product line.
 *
 * Read-then-write, guarded by the unique index on (code, version): two
 * administrators publishing at once means one write fails and retries rather
 * than two packages claiming the same version.
 */
export async function nextPackageVersion(code: string): Promise<number> {
  const latest: any = await Package.findOne({ code }).sort({ version: -1 }).select('version').lean()
  return (Number(latest?.version) || 0) + 1
}

/** Validate a quota list submitted by an administrator. */
export function normaliseQuotas(input: unknown): Array<{ metric: QuotaMetric; included: number; unlimited: boolean; overageMinorUnits: number | null }> {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error('quotas must be an array')
  const seen = new Set<string>()
  return input.map((raw: any) => {
    const metric = String(raw?.metric || '')
    if (!quotaMetrics.includes(metric as QuotaMetric)) throw new Error(`Unknown quota metric: ${metric}`)
    if (seen.has(metric)) throw new Error(`Duplicate quota for metric: ${metric}`)
    seen.add(metric)
    const unlimited = Boolean(raw?.unlimited)
    const included = unlimited ? 0 : Number(raw?.included)
    if (!unlimited && (!Number.isFinite(included) || included < 0)) {
      throw new Error(`Quota for ${metric} must be a non-negative number`)
    }
    const overage = raw?.overageMinorUnits === null || raw?.overageMinorUnits === undefined
      ? null
      : Number(raw.overageMinorUnits)
    if (overage !== null && (!Number.isFinite(overage) || overage < 0)) {
      throw new Error(`Overage price for ${metric} must be a non-negative number of minor units`)
    }
    return { metric: metric as QuotaMetric, included, unlimited, overageMinorUnits: overage }
  })
}
