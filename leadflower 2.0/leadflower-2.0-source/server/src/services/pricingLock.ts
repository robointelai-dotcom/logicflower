import Organization from '../models/Organization'
import { PLAN_LIMITS, SubscriptionPlan } from './entitlements'

/**
 * Grandfathered pricing.
 *
 * Report section 24.5, rule 5: "Grandfather early customers permanently. The
 * first hundred customers of a product in a tight community are worth more as
 * advocates than as revenue."
 *
 * A promise like that is only real if the system can keep it without anyone
 * remembering to. The lock therefore lives on the organisation record, and
 * every price-migration path must consult it rather than relying on an operator
 * excluding accounts by hand.
 *
 * Two properties matter and are separately enforced:
 *
 *  1. A locked organisation never has its price changed by a migration.
 *  2. A locked organisation still receives the *entitlements* of the tier it
 *     pays for. Grandfathering is a price guarantee, not a feature freeze —
 *     locking someone out of later improvements turns a loyalty reward into a
 *     penalty, and is the usual way this feature is implemented badly.
 */

export interface PriceLock {
  priceLocked: boolean
  legacyPlanId: string | null
  lockedAt?: Date
  lockedReason?: string
}

export interface MigrationDecision {
  organizationId: string
  applied: boolean
  reason: 'price_locked' | 'no_change' | 'migrated'
  fromPriceId: string | null
  toPriceId: string | null
}

/**
 * Decide whether a price migration may touch an organisation.
 *
 * Returns the decision rather than performing it, so the caller can render a
 * dry-run of a repricing campaign before any Stripe call is made.
 */
export function evaluatePriceMigration(input: {
  organizationId: string
  lock: PriceLock
  currentPriceId: string | null
  targetPriceId: string | null
}): MigrationDecision {
  if (input.lock.priceLocked) {
    return {
      organizationId: input.organizationId,
      applied: false,
      reason: 'price_locked',
      fromPriceId: input.currentPriceId,
      // A locked organisation stays on its legacy price where one is recorded.
      toPriceId: input.lock.legacyPlanId || input.currentPriceId,
    }
  }
  if (!input.targetPriceId || input.targetPriceId === input.currentPriceId) {
    return { organizationId: input.organizationId, applied: false, reason: 'no_change', fromPriceId: input.currentPriceId, toPriceId: input.currentPriceId }
  }
  return { organizationId: input.organizationId, applied: true, reason: 'migrated', fromPriceId: input.currentPriceId, toPriceId: input.targetPriceId }
}

/**
 * Entitlement limits for a plan, unaffected by a price lock.
 *
 * Explicit because the tempting shortcut — resolving limits from the legacy
 * price identifier — would freeze a grandfathered customer out of every
 * subsequent allowance increase.
 */
export function limitsForLockedPlan(plan: SubscriptionPlan) {
  return PLAN_LIMITS[plan]
}

export async function readPriceLock(organizationId: string): Promise<PriceLock> {
  const row: any = await Organization.findById(organizationId).select('+priceLocked +legacyPlanId +priceLockedAt +priceLockReason').lean()
  return {
    priceLocked: Boolean(row?.priceLocked),
    legacyPlanId: row?.legacyPlanId ?? null,
    lockedAt: row?.priceLockedAt,
    lockedReason: row?.priceLockReason,
  }
}

/**
 * Apply a permanent price lock.
 *
 * Deliberately has no expiry parameter. "Permanently" in the report means
 * permanently, and an optional duration would make it trivially easy to ship a
 * lock that quietly lapses.
 */
export async function lockPrice(input: {
  organizationId: string
  legacyPlanId: string | null
  reason: string
}): Promise<PriceLock> {
  await Organization.updateOne({ _id: input.organizationId }, {
    $set: {
      priceLocked: true,
      legacyPlanId: input.legacyPlanId,
      priceLockedAt: new Date(),
      priceLockReason: String(input.reason).slice(0, 300),
    },
  })
  return readPriceLock(input.organizationId)
}

/**
 * Dry-run a repricing campaign across many organisations.
 *
 * Returns what would happen without performing it, matching the report's
 * mandatory preview rule for any operation with commercial consequences.
 */
export async function previewPriceMigration(input: {
  organizationIds: string[]
  currentPriceIdByOrganization: Record<string, string | null>
  targetPriceId: string
}): Promise<{ decisions: MigrationDecision[]; summary: { migrated: number; locked: number; unchanged: number } }> {
  const decisions: MigrationDecision[] = []
  for (const organizationId of input.organizationIds) {
    const lock = await readPriceLock(organizationId)
    decisions.push(evaluatePriceMigration({
      organizationId,
      lock,
      currentPriceId: input.currentPriceIdByOrganization[organizationId] ?? null,
      targetPriceId: input.targetPriceId,
    }))
  }
  return {
    decisions,
    summary: {
      migrated: decisions.filter((decision) => decision.reason === 'migrated').length,
      locked: decisions.filter((decision) => decision.reason === 'price_locked').length,
      unchanged: decisions.filter((decision) => decision.reason === 'no_change').length,
    },
  }
}
