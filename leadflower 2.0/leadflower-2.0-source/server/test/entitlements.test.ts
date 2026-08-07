import { describe, expect, it } from 'vitest'
import {
  EntitlementError,
  PLAN_LIMITS,
  PlanEntitlement,
  UsageLedgerEntry,
  UsageReservationStore,
  UsageReservationTransaction,
  entitlementFromSubscription,
  reserveMeteredUsage,
} from '../src/services/entitlements'

class InMemoryUsageStore implements UsageReservationStore {
  readonly ledgers = new Map<string, UsageLedgerEntry>()
  readonly counters = new Map<string, number>()
  private tail: Promise<void> = Promise.resolve()

  constructor(public entitlement: PlanEntitlement) {}

  async transaction<T>(work: (transaction: UsageReservationTransaction) => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.tail
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const transaction: UsageReservationTransaction = {
        findLedger: async (input) => this.ledgers.get(`${input.organizationId}:${input.idempotencyKey}`) || null,
        resolveEntitlement: async () => this.entitlement,
        incrementWithinLimit: async (entitlement, metric, quantity) => {
          const key = `${entitlement.organizationId}:${metric}:${entitlement.periodStart.toISOString()}`
          const used = this.counters.get(key) || 0
          if (used + quantity > entitlement.limits[metric]) return null
          this.counters.set(key, used + quantity)
          return used + quantity
        },
        insertLedger: async (input, entitlement, counterUsed) => {
          this.ledgers.set(`${input.organizationId}:${input.idempotencyKey}`, {
            metric: input.metric,
            quantity: input.quantity,
            idempotencyKey: input.idempotencyKey,
            plan: entitlement.plan,
            periodStart: entitlement.periodStart,
            periodEnd: entitlement.periodEnd,
            counterUsed,
            counterLimit: entitlement.limits[input.metric],
          })
        },
      }
      return await work(transaction)
    } finally {
      release()
    }
  }
}

function entitlement(overrides: Partial<PlanEntitlement> = {}): PlanEntitlement {
  return {
    organizationId: '507f1f77bcf86cd799439011',
    plan: 'free',
    subscriptionStatus: 'inactive',
    eligible: true,
    periodSource: 'calendar_month',
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-09-01T00:00:00.000Z'),
    limits: { workflow_execution: 5, contact_processed: 5 },
    ...overrides,
  }
}

describe('plan entitlement and atomic usage reservations', () => {
  it('defines an explicit free calendar-month entitlement and Stripe periods for active paid plans', () => {
    const at = new Date('2026-08-05T12:00:00.000Z')
    const free = entitlementFromSubscription('507f1f77bcf86cd799439011', null, at)
    expect(free).toMatchObject({ plan: 'free', eligible: true, periodSource: 'calendar_month', limits: PLAN_LIMITS.free })
    expect(free.periodStart.toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(free.periodEnd.toISOString()).toBe('2026-09-01T00:00:00.000Z')

    const paid = entitlementFromSubscription('507f1f77bcf86cd799439011', {
      plan: 'starter', status: 'active', stripeSubscriptionId: 'sub_123',
      currentPeriodStart: new Date('2026-07-20T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-08-20T00:00:00.000Z'),
    }, at)
    expect(paid).toMatchObject({ plan: 'starter', eligible: true, periodSource: 'stripe_period', limits: PLAN_LIMITS.starter })
  })

  it('counts one idempotency key exactly once across concurrent attempts', async () => {
    const store = new InMemoryUsageStore(entitlement())
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveMeteredUsage({
      organizationId: store.entitlement.organizationId,
      metric: 'workflow_execution',
      quantity: 1,
      idempotencyKey: 'workflow:execution-1',
    }, store)))
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1)
    expect(results.filter((result) => result.duplicate)).toHaveLength(19)
    expect(store.ledgers.size).toBe(1)
    expect([...store.counters.values()]).toEqual([1])
  })

  it('never exceeds a quota under concurrent distinct reservations', async () => {
    const store = new InMemoryUsageStore(entitlement())
    const settled = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => reserveMeteredUsage({
      organizationId: store.entitlement.organizationId,
      metric: 'contact_processed',
      quantity: 1,
      idempotencyKey: `batch:record-${index}`,
    }, store)))
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(5)
    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected).toHaveLength(7)
    expect(rejected.every((result) => result.reason instanceof EntitlementError && result.reason.status === 429)).toBe(true)
    expect(store.ledgers.size).toBe(5)
    expect([...store.counters.values()]).toEqual([5])
  })

  it('fails closed with 402 for inactive, unlinked, or out-of-period paid plans', async () => {
    const blocked = entitlement({
      plan: 'agency',
      subscriptionStatus: 'unpaid',
      eligible: false,
      blockedReason: 'subscription_inactive',
      limits: PLAN_LIMITS.agency,
    })
    const store = new InMemoryUsageStore(blocked)
    await expect(reserveMeteredUsage({
      organizationId: blocked.organizationId,
      metric: 'workflow_execution',
      quantity: 1,
      idempotencyKey: 'workflow:blocked-1',
    }, store)).rejects.toMatchObject({ status: 402, code: 'SUBSCRIPTION_PAYMENT_REQUIRED' })
    expect(store.ledgers.size).toBe(0)
    expect(store.counters.size).toBe(0)
  })

  it('returns 409 when one idempotency key is reused for different billable work', async () => {
    const store = new InMemoryUsageStore(entitlement())
    await reserveMeteredUsage({
      organizationId: store.entitlement.organizationId,
      metric: 'workflow_execution',
      quantity: 1,
      idempotencyKey: 'shared:key-1',
    }, store)
    await expect(reserveMeteredUsage({
      organizationId: store.entitlement.organizationId,
      metric: 'contact_processed',
      quantity: 1,
      idempotencyKey: 'shared:key-1',
    }, store)).rejects.toMatchObject({ status: 409 })
  })
})
