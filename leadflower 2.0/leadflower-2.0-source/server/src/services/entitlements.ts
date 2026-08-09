import mongoose, { ClientSession } from 'mongoose'
import { HttpError, problemType} from '../http/problem'
import Subscription from '../models/Subscription'
import UsageCounter, { QuotaMetric, quotaMetrics } from '../models/UsageCounter'
import UsageRecord from '../models/UsageRecord'
import { evaluateUsageThresholds, overageCents, overageUnits } from './usageAlerts'
import { packageForSubscription, resolveLimits } from './packages'
// PLAN_LIMITS is re-exported below for existing importers but not used here.
import { subscriptionPlans, SubscriptionPlan } from './planLimits'

// Re-exported so every existing importer of these names keeps working; they
// now live in `planLimits.ts` so `packages.ts` can depend on them without a
// cycle back through this module.
export { PLAN_LIMITS, subscriptionPlans } from './planLimits'
export type { SubscriptionPlan } from './planLimits'

export interface PlanEntitlement {
  organizationId: string
  plan: SubscriptionPlan
  subscriptionStatus: string
  eligible: boolean
  blockedReason?: 'subscription_inactive' | 'stripe_link_missing' | 'billing_period_invalid'
  periodSource: 'calendar_month' | 'stripe_period' | 'calendar_fallback'
  periodStart: Date
  periodEnd: Date
  limits: Readonly<Record<QuotaMetric, number>>
}

export interface UsageLedgerEntry {
  metric: QuotaMetric
  quantity: number
  idempotencyKey: string
  plan: SubscriptionPlan
  periodStart: Date
  periodEnd: Date
  counterUsed: number
  counterLimit: number
}

export interface UsageReservationResult extends UsageLedgerEntry {
  remaining: number
  duplicate: boolean
}

interface ReservationInput {
  organizationId: string
  metric: QuotaMetric
  quantity: number
  idempotencyKey: string
  source?: string
  occurredAt?: Date
  metadata?: Record<string, unknown>
}

export interface UsageReservationTransaction {
  findLedger(input: ReservationInput): Promise<UsageLedgerEntry | null>
  resolveEntitlement(organizationId: string, at: Date): Promise<PlanEntitlement>
  incrementWithinLimit(entitlement: PlanEntitlement, metric: QuotaMetric, quantity: number): Promise<number | null>
  insertLedger(input: ReservationInput, entitlement: PlanEntitlement, counterUsed: number): Promise<void>
}

export interface UsageReservationStore {
  transaction<T>(work: (transaction: UsageReservationTransaction) => Promise<T>): Promise<T>
}

export class EntitlementError extends HttpError {
  constructor(
    public code: 'SUBSCRIPTION_PAYMENT_REQUIRED' | 'USAGE_QUOTA_EXCEEDED',
    status: 402 | 429,
    title: string,
    detail: string,
    public entitlement: PlanEntitlement,
    public metric?: QuotaMetric,
  ) {
    super(status, title, detail, problemType(code), false)
    this.name = 'EntitlementError'
  }
}

export function isUsageGateError(error: unknown): boolean {
  return error instanceof EntitlementError || (error instanceof HttpError && error.type === problemType('usage-enforcement-unavailable'))
}

function utcMonth(at: Date) {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))
  return { start, end }
}

function isPlan(value: unknown): value is SubscriptionPlan {
  return subscriptionPlans.includes(String(value) as SubscriptionPlan)
}

function validStripePeriod(start: unknown, end: unknown, at: Date): start is Date {
  return start instanceof Date && end instanceof Date && Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start < end && start <= at && at < end
}

/**
 * Turn a subscription into an entitlement.
 *
 * `packageDocument` is optional and defaults to null, which reproduces exactly
 * the behaviour every existing customer has today: limits come from the
 * built-in tier defaults. When a package IS supplied its quotas take effect,
 * and a per-customer override on the subscription beats both. Nothing about
 * eligibility, period selection or Stripe linkage changes — a package decides
 * how much you get, never whether you are entitled to it.
 */
export function entitlementFromSubscription(
  organizationId: string,
  subscription: any,
  at = new Date(),
  packageDocument: any | null = null,
): PlanEntitlement {
  const calendar = utcMonth(at)
  const plan: SubscriptionPlan = isPlan(subscription?.plan) ? subscription.plan : 'free'
  const status = String(subscription?.status || 'inactive')
  const resolved = resolveLimits({ plan, subscription, packageDocument, at })
  if (plan === 'free') {
    return {
      organizationId, plan, subscriptionStatus: status, eligible: true,
      periodSource: 'calendar_month', periodStart: calendar.start, periodEnd: calendar.end,
      limits: resolved.limits,
    }
  }
  const linked = typeof subscription?.stripeSubscriptionId === 'string' && subscription.stripeSubscriptionId.startsWith('sub_')
  const active = status === 'active' || status === 'trialing'
  const periodValid = validStripePeriod(subscription?.currentPeriodStart, subscription?.currentPeriodEnd, at)
  const eligible = active && linked && periodValid
  const blockedReason = !active ? 'subscription_inactive' : !linked ? 'stripe_link_missing' : !periodValid ? 'billing_period_invalid' : undefined
  return {
    organizationId, plan, subscriptionStatus: status, eligible, blockedReason,
    periodSource: periodValid ? 'stripe_period' : 'calendar_fallback',
    periodStart: periodValid ? subscription.currentPeriodStart : calendar.start,
    periodEnd: periodValid ? subscription.currentPeriodEnd : calendar.end,
    limits: resolved.limits,
  }
}

function assertEligible(entitlement: PlanEntitlement): void {
  if (entitlement.eligible) return
  throw new EntitlementError(
    'SUBSCRIPTION_PAYMENT_REQUIRED',
    402,
    'Subscription payment required',
    `The ${entitlement.plan} plan is not currently entitled to run billable work (${entitlement.blockedReason || 'inactive'}).`,
    entitlement,
  )
}

function usageResult(entry: UsageLedgerEntry, duplicate: boolean): UsageReservationResult {
  return { ...entry, remaining: Math.max(0, entry.counterLimit - entry.counterUsed), duplicate }
}

function sameReservation(existing: UsageLedgerEntry, input: ReservationInput): boolean {
  return existing.metric === input.metric && existing.quantity === input.quantity && existing.idempotencyKey === input.idempotencyKey
}

export async function reserveMeteredUsage(
  input: ReservationInput,
  store: UsageReservationStore = mongoUsageReservationStore,
): Promise<UsageReservationResult> {
  if (!input.organizationId) throw new Error('organizationId is required for usage reservation')
  if (!quotaMetrics.includes(input.metric)) throw new Error('Unsupported quota metric')
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) throw new Error('Metered usage quantity must be a positive integer')
  if (!/^[A-Za-z0-9:_-]{8,240}$/.test(input.idempotencyKey)) throw new Error('A safe usage idempotency key is required')
  // Billable reservations always use server time. Allowing a caller to
  // backdate a reservation would let it select an older quota period.
  const reservationInput: ReservationInput = { ...input, occurredAt: new Date() }
  return store.transaction(async (transaction) => {
    const existing = await transaction.findLedger(reservationInput)
    if (existing) {
      if (!sameReservation(existing, reservationInput)) {
        throw new HttpError(409, 'Usage idempotency conflict', 'The usage idempotency key was already used for a different metric or quantity')
      }
      return usageResult(existing, true)
    }
    const entitlement = await transaction.resolveEntitlement(reservationInput.organizationId, reservationInput.occurredAt!)
    assertEligible(entitlement)
    const limit = entitlement.limits[reservationInput.metric]
    const counterUsed = await transaction.incrementWithinLimit(entitlement, reservationInput.metric, reservationInput.quantity)
    if (counterUsed == null) {
      throw new EntitlementError(
        'USAGE_QUOTA_EXCEEDED',
        429,
        'Usage quota exceeded',
        `${reservationInput.metric} usage has reached the ${entitlement.plan} plan limit of ${limit}; the quota resets at ${entitlement.periodEnd.toISOString()}.`,
        entitlement,
        reservationInput.metric,
      )
    }
    await transaction.insertLedger(reservationInput, entitlement, counterUsed)
    // Threshold notices are evaluated from the before/after counter values so a
    // single large job that jumps past both boundaries raises both notices.
    // This runs after the ledger insert and never throws into the billable
    // path: a courtesy warning must not fail a customer's work.
    if (typeof limit === 'number' && limit > 0) {
      void evaluateUsageThresholds({
        organizationId: reservationInput.organizationId,
        plan: entitlement.plan,
        metric: reservationInput.metric,
        previousUsed: counterUsed - reservationInput.quantity,
        newUsed: counterUsed,
        limit,
        periodStart: entitlement.periodStart,
        periodEnd: entitlement.periodEnd,
      }).catch(() => undefined)
    }
    return usageResult({
      metric: reservationInput.metric,
      quantity: reservationInput.quantity,
      idempotencyKey: reservationInput.idempotencyKey,
      plan: entitlement.plan,
      periodStart: entitlement.periodStart,
      periodEnd: entitlement.periodEnd,
      counterUsed,
      counterLimit: limit,
    }, false)
  })
}

async function resolveMongoEntitlement(organizationId: string, at: Date, session: ClientSession): Promise<PlanEntitlement> {
  const subscription = await Subscription.findOne({ organizationId }).session(session).lean()
  // Only queried when the subscription is actually pinned to a package, so an
  // unmigrated customer costs no extra read on the reservation hot path.
  const packageDocument = await packageForSubscription(subscription)
  return entitlementFromSubscription(organizationId, subscription, at, packageDocument)
}

function mongoTransaction(session: ClientSession): UsageReservationTransaction {
  return {
    async findLedger(input) {
      const row: any = await UsageRecord.findOne({ organizationId: input.organizationId, idempotencyKey: input.idempotencyKey }).session(session).lean()
      if (!row) return null
      return {
        metric: row.metric,
        quantity: Number(row.quantity),
        idempotencyKey: row.idempotencyKey,
        plan: row.plan,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        counterUsed: Number(row.counterUsed),
        counterLimit: Number(row.counterLimit),
      }
    },
    resolveEntitlement: (organizationId, at) => resolveMongoEntitlement(organizationId, at, session),
    async incrementWithinLimit(entitlement, metric, quantity) {
      const key = { organizationId: entitlement.organizationId, metric, periodStart: entitlement.periodStart }
      await UsageCounter.updateOne(key, {
        $setOnInsert: { ...key, used: 0 },
        $set: { periodEnd: entitlement.periodEnd, plan: entitlement.plan, limit: entitlement.limits[metric] },
      }, { upsert: true, session })
      const maximumBeforeIncrement = entitlement.limits[metric] - quantity
      if (maximumBeforeIncrement < 0) return null
      const counter: any = await UsageCounter.findOneAndUpdate({ ...key, used: { $lte: maximumBeforeIncrement } }, {
        $inc: { used: quantity },
      }, { new: true, session }).lean()
      return counter ? Number(counter.used) : null
    },
    async insertLedger(input, entitlement, counterUsed) {
      await UsageRecord.create([{
        organizationId: input.organizationId,
        metric: input.metric,
        quantity: input.quantity,
        occurredAt: input.occurredAt || new Date(),
        idempotencyKey: input.idempotencyKey,
        source: input.source,
        metadata: input.metadata || {},
        plan: entitlement.plan,
        periodStart: entitlement.periodStart,
        periodEnd: entitlement.periodEnd,
        counterUsed,
        counterLimit: entitlement.limits[input.metric],
      }], { session })
    },
  }
}

function transactionsUnsupported(error: any): boolean {
  return error?.code === 20 || /Transaction numbers are only allowed|replica set member or mongos/i.test(String(error?.message || ''))
}

export const mongoUsageReservationStore: UsageReservationStore = {
  async transaction<T>(work: (transaction: UsageReservationTransaction) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession()
    let result: T | undefined
    try {
      await session.withTransaction(async () => {
        result = await work(mongoTransaction(session))
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
      return result as T
    } catch (error) {
      if (transactionsUnsupported(error)) {
        throw new HttpError(503, 'Usage enforcement unavailable', 'Billable work is paused because atomic quota enforcement requires a MongoDB replica set', problemType('usage-enforcement-unavailable'), true)
      }
      throw error
    } finally {
      await session.endSession()
    }
  },
}

export async function currentUsageEntitlement(organizationId: string, at = new Date()) {
  const subscription = await Subscription.findOne({ organizationId }).lean()
  const entitlement = entitlementFromSubscription(organizationId, subscription, at, await packageForSubscription(subscription))
  const rows: any[] = await UsageCounter.find({
    organizationId,
    periodStart: entitlement.periodStart,
    metric: { $in: quotaMetrics },
  }).lean()
  const counters = new Map(rows.map((row) => [String(row.metric), Number(row.used || 0)]))
  return {
    plan: entitlement.plan,
    subscriptionStatus: entitlement.subscriptionStatus,
    eligible: entitlement.eligible,
    blockedReason: entitlement.blockedReason || null,
    periodSource: entitlement.periodSource,
    period: { start: entitlement.periodStart, end: entitlement.periodEnd },
    metrics: Object.fromEntries(quotaMetrics.map((metric) => {
      const used = counters.get(metric) || 0
      const limit = entitlement.limits[metric]
      return [metric, { limit, used, remaining: Math.max(0, limit - used) }]
    })),
  }
}

export async function assertUsageAvailable(organizationId: string, metric: QuotaMetric, quantity = 1, at = new Date()): Promise<PlanEntitlement> {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Usage availability quantity must be a positive integer')
  const subscription = await Subscription.findOne({ organizationId }).lean()
  const entitlement = entitlementFromSubscription(organizationId, subscription, at, await packageForSubscription(subscription))
  assertEligible(entitlement)
  const counter: any = await UsageCounter.findOne({ organizationId, metric, periodStart: entitlement.periodStart }).select('used').lean()
  const used = Number(counter?.used || 0)
  if (used + quantity > entitlement.limits[metric]) {
    throw new EntitlementError(
      'USAGE_QUOTA_EXCEEDED',
      429,
      'Usage quota exceeded',
      `${metric} usage has reached the ${entitlement.plan} plan limit of ${entitlement.limits[metric]}; the quota resets at ${entitlement.periodEnd.toISOString()}.`,
      entitlement,
      metric,
    )
  }
  return entitlement
}

/**
 * Overage accrued for an organisation in the current period.
 *
 * Reported rather than charged: this release does not push usage records to
 * Stripe, because metered billing must be reconciled in Stripe test mode before
 * a real invoice can depend on it. Surfacing the figure lets an operator see
 * what would be billed and lets `LIVE_ACCEPTANCE` reconcile it.
 */
export function overageForPeriod(plan: string, metric: QuotaMetric, used: number, limit: number) {
  return {
    plan,
    metric,
    used,
    limit,
    overageUnits: overageUnits(used, limit),
    overageBlockSize: 10_000,
    overageCents: overageCents(plan, used, limit),
    billed: false,
    note: 'Overage is measured and reported. It is not charged until Stripe metered reconciliation is recorded in LIVE_ACCEPTANCE.md.',
  }
}
