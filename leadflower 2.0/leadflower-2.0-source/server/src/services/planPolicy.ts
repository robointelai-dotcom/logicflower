import Organization from '../models/Organization'
import PlatformConnection from '../models/PlatformConnection'
import Subscription from '../models/Subscription'
import { HttpError, problemType} from '../http/problem'
import { entitlementFromSubscription, SubscriptionPlan } from './entitlements'

export interface PlanPolicy {
  plan: SubscriptionPlan
  eligible: boolean
  maxConnections: number
  maxRetentionDays: number
  workflowVersionLimit: number | null
  workflowHistoryDays: number
}

const POLICIES: Readonly<Record<SubscriptionPlan, Omit<PlanPolicy, 'plan' | 'eligible'>>> = Object.freeze({
  free: Object.freeze({ maxConnections: 1, maxRetentionDays: 7, workflowVersionLimit: 3, workflowHistoryDays: 7 }),
  starter: Object.freeze({ maxConnections: 3, maxRetentionDays: 7, workflowVersionLimit: 5, workflowHistoryDays: 7 }),
  agency: Object.freeze({ maxConnections: 15, maxRetentionDays: 30, workflowVersionLimit: null, workflowHistoryDays: 30 }),
  scale: Object.freeze({ maxConnections: 50, maxRetentionDays: 90, workflowVersionLimit: null, workflowHistoryDays: 365 }),
})

export function policyForPlan(plan: SubscriptionPlan, eligible = true): PlanPolicy {
  // An ineligible paid subscription must not retain paid operational capacity.
  const effectivePlan: SubscriptionPlan = plan === 'free' || eligible ? plan : 'free'
  return { plan: effectivePlan, eligible: plan === 'free' || eligible, ...POLICIES[effectivePlan] }
}

export async function resolvePlanPolicy(organizationId: string, at = new Date()): Promise<PlanPolicy> {
  const subscription = await Subscription.findOne({ organizationId }).lean()
  const entitlement = entitlementFromSubscription(organizationId, subscription, at)
  return policyForPlan(entitlement.plan, entitlement.eligible)
}

export async function assertRetentionAllowed(organizationId: string, retentionDays: number): Promise<PlanPolicy> {
  const policy = await resolvePlanPolicy(organizationId)
  if (retentionDays > policy.maxRetentionDays) {
    throw new HttpError(
      409,
      'Retention exceeds plan',
      `The ${policy.plan} plan permits up to ${policy.maxRetentionDays} days of operational log retention.`,
      problemType('plan-retention-limit'),
    )
  }
  return policy
}

async function observedConnectionCount(organizationId: string): Promise<number> {
  return PlatformConnection.countDocuments({
    organizationId,
    status: { $in: ['pending', 'active', 'degraded', 'error'] },
    slotReleasedAt: { $exists: false },
  })
}

export async function claimConnectionCapacity(organizationId: string): Promise<PlanPolicy> {
  const policy = await resolvePlanPolicy(organizationId)
  const observed = await observedConnectionCount(organizationId)
  // Reconcile old rows before the atomic claim. $max never lowers a concurrent count.
  await Organization.updateOne({ _id: organizationId }, { $max: { connectionCount: observed } })
  const claimed = await Organization.findOneAndUpdate({
    _id: organizationId,
    status: 'active',
    $expr: { $lt: [{ $ifNull: ['$connectionCount', 0] }, policy.maxConnections] },
  }, { $inc: { connectionCount: 1 } }, { new: true }).select('+connectionCount')
  if (!claimed) {
    throw new HttpError(
      409,
      'Connection limit reached',
      `The ${policy.plan} plan permits ${policy.maxConnections} active connection${policy.maxConnections === 1 ? '' : 's'}. Disconnect one or change plan before adding another.`,
      problemType('plan-connection-limit'),
    )
  }
  return policy
}

export async function releaseUnpersistedConnectionClaim(organizationId: string): Promise<void> {
  await Organization.updateOne({ _id: organizationId, connectionCount: { $gt: 0 } }, { $inc: { connectionCount: -1 } })
}

export async function releaseConnectionCapacity(input: { organizationId: string; connectionId: string }): Promise<boolean> {
  const released = await PlatformConnection.findOneAndUpdate({
    _id: input.connectionId,
    organizationId: input.organizationId,
    slotReleasedAt: { $exists: false },
  }, { $set: { slotReleasedAt: new Date() } }, { new: true }).select('_id')
  if (!released) return false
  await releaseUnpersistedConnectionClaim(input.organizationId)
  return true
}

export function planPolicyCatalog(): Record<SubscriptionPlan, PlanPolicy> {
  return {
    free: policyForPlan('free'), starter: policyForPlan('starter'),
    agency: policyForPlan('agency'), scale: policyForPlan('scale'),
  }
}
