import { QuotaMetric } from '../models/UsageCounter'

/**
 * The built-in tier limits.
 *
 * Extracted from `entitlements.ts` to break a cycle: `packages.ts` needs the
 * tier defaults to fall back to, and `entitlements.ts` needs `packages.ts` to
 * resolve a package. Two modules importing each other happens to work under
 * ESM's live bindings, right up until one of them reads the other's export at
 * module-evaluation time and gets `undefined`. A leaf module both can depend on
 * removes the question.
 *
 * These remain the floor beneath every package. A customer with no package
 * assigned — which is every customer that existed before package management —
 * gets exactly these numbers, unchanged.
 */

export const subscriptionPlans = ['free', 'starter', 'agency', 'scale'] as const
export type SubscriptionPlan = typeof subscriptionPlans[number]

export const PLAN_LIMITS: Readonly<Record<SubscriptionPlan, Readonly<Record<QuotaMetric, number>>>> = Object.freeze({
  free: Object.freeze({ workflow_execution: 250, contact_processed: 1_000 }),
  starter: Object.freeze({ workflow_execution: 10_000, contact_processed: 20_000 }),
  agency: Object.freeze({ workflow_execution: 100_000, contact_processed: 100_000 }),
  scale: Object.freeze({ workflow_execution: 1_000_000, contact_processed: 500_000 }),
})
