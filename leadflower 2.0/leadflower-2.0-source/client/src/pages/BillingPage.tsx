import React from 'react'
import { Check, CreditCard, ExternalLink, ReceiptText, Sparkles } from 'lucide-react'
import { getList, getOne, send } from '../api/client'
import { Alert, Button, Card, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { Plan, UnknownRecord } from '../types'
import { formatDate } from '../utils/format'

interface Subscription extends UnknownRecord { id: string; planId?: string; planName?: string; status?: string; interval?: string; renewsAt?: string; cancelAtPeriodEnd?: boolean; paymentMethod?: string }
interface BillingData { subscription: Subscription | null; plans: Plan[] }

async function loadBilling(): Promise<BillingData> {
  const [subscription, plans] = await Promise.allSettled([getOne<UnknownRecord>('/billing/subscription'), getList<Plan & UnknownRecord>('/billing/plans', ['plans'])])
  if (subscription.status === 'rejected' && plans.status === 'rejected') throw subscription.reason
  const subscriptionEnvelope = subscription.status === 'fulfilled' ? subscription.value : {}
  const rawSubscription = subscriptionEnvelope.subscription && typeof subscriptionEnvelope.subscription === 'object' && !Array.isArray(subscriptionEnvelope.subscription) ? subscriptionEnvelope.subscription as UnknownRecord : subscriptionEnvelope
  const currentPlan = String(rawSubscription.plan ?? 'free')
  const normalizedSubscription: Subscription = { ...rawSubscription, id: String(rawSubscription.id ?? rawSubscription._id ?? ''), planId: currentPlan, planName: currentPlan === 'scale' ? 'Agency Scale' : currentPlan === 'free' ? 'Free' : currentPlan[0]?.toUpperCase() + currentPlan.slice(1), status: String(rawSubscription.status ?? 'inactive'), renewsAt: String(rawSubscription.currentPeriodEnd ?? ''), cancelAtPeriodEnd: Boolean(rawSubscription.cancelAtPeriodEnd) }
  const names: Record<string, string> = { free: 'Free', starter: 'Starter', agency: 'Agency', scale: 'Agency Scale' }
  const normalizedPlans = plans.status === 'fulfilled' ? plans.value.items.map((plan) => {
    const limits = plan.limits && typeof plan.limits === 'object' && !Array.isArray(plan.limits) ? plan.limits as UnknownRecord : {}
    const workflowHistory = limits.workflowVersions != null ? `${Number(limits.workflowVersions)} workflow versions` : `${Number(limits.workflowHistoryDays ?? 0)}-day workflow history`
    return { ...plan, name: names[plan.id] ?? plan.id, description: plan.id === 'free' ? 'For evaluating one governed connection.' : plan.id === 'starter' ? 'For one growing operations team.' : plan.id === 'agency' ? 'For agencies managing multiple clients.' : 'For high-volume agency automation programs.', features: [`${new Intl.NumberFormat().format(Number(limits.workflowExecutions ?? 0))} workflow executions`, `${new Intl.NumberFormat().format(Number(limits.contacts ?? 0))} contact records`, `${Number(limits.connections ?? 0)} encrypted connections`, `${Number(limits.retentionDays ?? 0)}-day job logs`, workflowHistory, 'Append-only audit history'], enabled: Boolean(plan.enabled), current: plan.id === currentPlan }
  }) : []
  return { subscription: normalizedSubscription, plans: normalizedPlans }
}

export default function BillingPage() {
  const query = useApi(loadBilling, [])
  const action = useAction()
  const checkout = async (plan: Plan) => { const result = await action.run(() => send<{ url?: string; checkoutUrl?: string }>('post', '/billing/checkout', { plan: plan.id, successUrl: `${window.location.origin}/billing?checkout=success`, cancelUrl: `${window.location.origin}/billing?checkout=cancelled` })); const url = result?.url ?? result?.checkoutUrl; if (url) window.location.assign(url) }
  const portal = async () => { const result = await action.run(() => send<{ url?: string; portalUrl?: string }>('post', '/billing/portal', { returnUrl: `${window.location.origin}/billing` })); const url = result?.url ?? result?.portalUrl; if (url) window.location.assign(url) }
  const choosePlan = async (plan: Plan) => { if (plan.id === 'free') await portal(); else await checkout(plan) }
  return <>
    <PageHeader eyebrow="Subscription" title="Billing & plans" description="Manage your subscription, usage limits, payment method and invoices." actions={<Button onClick={() => { void portal() }} busy={action.loading}><CreditCard size={16} />Open billing portal <ExternalLink size={14} /></Button>} />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {query.loading ? <SkeletonRows rows={5} columns={4} /> : query.error ? <Alert>{query.error}</Alert> : <>
      <Card className="current-plan"><div><span className="plan-icon"><Sparkles /></span><div><p>Current plan</p><h2>{query.data?.subscription?.planName ?? 'Free'}</h2><span><StatusBadge status={query.data?.subscription?.status ?? 'active'} />{query.data?.subscription?.cancelAtPeriodEnd ? `Ends ${formatDate(query.data.subscription.renewsAt)}` : `Renews ${formatDate(query.data?.subscription?.renewsAt)}`}</span></div></div><div><small>Payment method</small><strong>{query.data?.subscription?.paymentMethod ?? 'No card on file'}</strong></div></Card>
      <div className="plan-grid">{query.data?.plans.map((plan) => <Card key={plan.id} className={`plan-card ${plan.current || plan.id === query.data?.subscription?.planId ? 'featured' : ''}`}><div className="plan-head"><div><h2>{plan.name}</h2><p>{plan.description}</p></div>{(plan.current || plan.id === query.data?.subscription?.planId) && <StatusBadge status="active" label="Current" />}</div><div className="plan-price"><strong>{plan.enabled ? 'Subscription' : 'Unavailable'}</strong></div><ul>{(plan.features ?? []).map((feature) => <li key={feature}><Check size={16} />{feature}</li>)}</ul><Button variant={plan.current || plan.id === query.data?.subscription?.planId ? 'secondary' : 'primary'} disabled={plan.current || plan.id === query.data?.subscription?.planId || !plan.enabled} onClick={() => { void choosePlan(plan) }} busy={action.loading}>{plan.current || plan.id === query.data?.subscription?.planId ? 'Current plan' : !plan.enabled ? 'Not configured' : plan.id === 'free' ? 'Manage in portal' : 'Choose plan'}</Button></Card>)}</div>
      <Card title="Invoices" subtitle="Invoices and tax receipts are managed in the secure billing portal." actions={<Button size="sm" variant="ghost" onClick={() => { void portal() }}><ReceiptText size={15} />View invoices</Button>}><p className="card-copy">Use the billing portal to download invoices, update payment details or change billing information. LogicFlower never stores full card numbers.</p></Card>
    </>}
  </>
}
