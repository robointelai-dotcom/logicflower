import { Request, Response, Router } from 'express'
import Stripe from 'stripe'
import { z } from 'zod'
import { Types } from 'mongoose'
import { env } from '../env'
import Subscription from '../models/Subscription'
import Organization from '../models/Organization'
import User from '../models/User'
import StripeEvent from '../models/StripeEvent'
import { asyncHandler, HttpError, parseBody, sendProblem } from '../http/problem'
import { requireRole } from '../middleware/rbac'
import { requireIdempotency } from '../middleware/idempotency'
import { recordAudit } from '../services/audit'
import pino from '../logger'
import { PLAN_LIMITS } from '../services/entitlements'
import { planPolicyCatalog } from '../services/planPolicy'

const router = Router()
const billingRole = requireRole('owner', 'billing')

const planCatalog = {
  starter: { priceId: () => env.STRIPE_PRICE_STARTER },
  agency: { priceId: () => env.STRIPE_PRICE_AGENCY },
  scale: { priceId: () => env.STRIPE_PRICE_SCALE },
} as const
type PaidPlan = keyof typeof planCatalog

function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Billing unavailable', 'Stripe billing is not configured on this deployment', 'about:blank', true)
  return new Stripe(env.STRIPE_SECRET_KEY)
}

function safeReturnUrl(raw: string): string {
  const url = new URL(raw, env.APP_URL)
  if (url.origin !== new URL(env.APP_URL).origin) throw new HttpError(400, 'Invalid return URL', 'Billing return URLs must use the configured application origin')
  return url.toString()
}

router.get('/plans', (_req, res) => {
  const policies = planPolicyCatalog()
  res.json({ items: [
    { id: 'free', enabled: true, limits: { workflowExecutions: PLAN_LIMITS.free.workflow_execution, contacts: PLAN_LIMITS.free.contact_processed, connections: policies.free.maxConnections, retentionDays: policies.free.maxRetentionDays, workflowVersions: policies.free.workflowVersionLimit, workflowHistoryDays: policies.free.workflowHistoryDays } },
    ...Object.entries(planCatalog).map(([id, plan]) => ({
    id,
    enabled: Boolean(plan.priceId()),
    limits: {
      workflowExecutions: PLAN_LIMITS[id as PaidPlan].workflow_execution,
      contacts: PLAN_LIMITS[id as PaidPlan].contact_processed,
      connections: policies[id as PaidPlan].maxConnections,
      retentionDays: policies[id as PaidPlan].maxRetentionDays,
      workflowVersions: policies[id as PaidPlan].workflowVersionLimit,
      workflowHistoryDays: policies[id as PaidPlan].workflowHistoryDays,
    },
  })),
  ] })
})

router.get('/subscription', asyncHandler(async (req, res) => {
  const subscription = await Subscription.findOne({ organizationId: req.auth!.organizationId }).lean()
  res.json({ subscription: subscription || { plan: 'free', status: 'inactive' } })
}))

router.post('/checkout', billingRole, requireIdempotency, asyncHandler(async (req, res) => {
  const body = parseBody(z.object({
    plan: z.enum(['starter', 'agency', 'scale']),
    successUrl: z.string().min(1),
    cancelUrl: z.string().min(1),
  }).strict(), req)
  const priceId = planCatalog[body.plan].priceId()
  if (!priceId) throw new HttpError(503, 'Plan unavailable', `Stripe price for ${body.plan} is not configured`)
  const organizationId = req.auth!.organizationId!
  const [organization, user] = await Promise.all([
    Organization.findById(organizationId).select('name').lean(),
    User.findById(req.auth!.userId).select('email').lean(),
  ])
  if (!organization || !user) throw new HttpError(404, 'Billing account unavailable', 'Organization or user was not found')
  let subscription: any = await Subscription.findOne({ organizationId })
  if (!subscription) subscription = await Subscription.create({ organizationId, plan: 'free', status: 'inactive' })
  const client = stripe()
  if (!subscription.stripeCustomerId) {
    const customer = await client.customers.create({
      name: organization.name,
      email: user.email,
      metadata: { logicflowerOrganizationId: organizationId },
    }, { idempotencyKey: `${req.idempotencyKey}:customer` })
    subscription.stripeCustomerId = customer.id
    await subscription.save()
  }
  const session = await client.checkout.sessions.create({
    mode: 'subscription',
    customer: subscription.stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: safeReturnUrl(body.successUrl),
    cancel_url: safeReturnUrl(body.cancelUrl),
    client_reference_id: organizationId,
    metadata: { logicflowerOrganizationId: organizationId, logicflowerPlan: body.plan },
    subscription_data: { metadata: { logicflowerOrganizationId: organizationId, logicflowerPlan: body.plan } },
  }, { idempotencyKey: `${req.idempotencyKey}:checkout` })
  await recordAudit({ action: 'billing.checkout_created', req, entityType: 'Organization', entityId: organizationId, metadata: { plan: body.plan } })
  res.status(201).json({ checkoutUrl: session.url })
}))

router.post('/portal', billingRole, requireIdempotency, asyncHandler(async (req, res) => {
  const { returnUrl } = parseBody(z.object({ returnUrl: z.string().min(1) }).strict(), req)
  const subscription = await Subscription.findOne({ organizationId: req.auth!.organizationId }).lean()
  if (!subscription?.stripeCustomerId) throw new HttpError(409, 'Billing profile required', 'Start a subscription checkout before opening the billing portal')
  const session = await stripe().billingPortal.sessions.create({
    customer: subscription.stripeCustomerId,
    return_url: safeReturnUrl(returnUrl),
  }, { idempotencyKey: `${req.idempotencyKey}:portal` })
  await recordAudit({ action: 'billing.portal_created', req })
  res.status(201).json({ portalUrl: session.url })
}))

function normalizedSubscriptionStatus(status: string): string {
  return ['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'].includes(status) ? status : 'inactive'
}

async function processStripeEvent(event: Stripe.Event): Promise<void> {
  const object: any = event.data.object
  if (event.type === 'checkout.session.completed') {
    const organizationId = String(object.metadata?.logicflowerOrganizationId || object.client_reference_id || '')
    if (!Types.ObjectId.isValid(organizationId)) throw new Error('Checkout event lacks a valid organization identifier')
    await Subscription.findOneAndUpdate({ organizationId }, {
      $set: {
        stripeCustomerId: typeof object.customer === 'string' ? object.customer : object.customer?.id,
        stripeSubscriptionId: typeof object.subscription === 'string' ? object.subscription : object.subscription?.id,
        plan: object.metadata?.logicflowerPlan || 'free',
      },
    }, { upsert: true })
    return
  }
  if (event.type.startsWith('customer.subscription.')) {
    const organizationId = String(object.metadata?.logicflowerOrganizationId || '')
    const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id
    const query = Types.ObjectId.isValid(organizationId) ? { organizationId } : { stripeCustomerId: customerId }
    const plan = String(object.metadata?.logicflowerPlan || '')
    const update: Record<string, unknown> = {
      stripeCustomerId: customerId,
      stripeSubscriptionId: object.id,
      status: normalizedSubscriptionStatus(object.status),
      currentPeriodStart: object.current_period_start ? new Date(object.current_period_start * 1_000) : undefined,
      currentPeriodEnd: object.current_period_end ? new Date(object.current_period_end * 1_000) : undefined,
      cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
    }
    if (['starter', 'agency', 'scale'].includes(plan)) update.plan = plan
    // tenant-safe: Stripe webhook reconciliation keyed on the Stripe customer/subscription id, which is the tenant identifier here
    const result = await Subscription.updateOne(query, { $set: update })
    if (!result.matchedCount) throw new Error('Stripe subscription is not linked to a LogicFlower organization')
  }
}

export async function stripeWebhook(req: Request, res: Response): Promise<void> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    sendProblem(req, res, { status: 503, title: 'Billing unavailable', detail: 'Stripe webhook is not configured', retryable: true })
    return
  }
  const signature = req.headers['stripe-signature']
  if (!signature || !Buffer.isBuffer(req.body)) {
    sendProblem(req, res, { status: 400, title: 'Invalid Stripe webhook', detail: 'Stripe signature and raw body are required' })
    return
  }
  let event: Stripe.Event
  try {
    event = stripe().webhooks.constructEvent(req.body, signature, env.STRIPE_WEBHOOK_SECRET)
  } catch {
    sendProblem(req, res, { status: 400, title: 'Invalid Stripe signature', detail: 'Invalid Stripe signature' })
    return
  }
  const now = new Date()
  let claim: any
  try {
    claim = await StripeEvent.findOneAndUpdate({
      eventId: event.id,
      $or: [{ processedAt: null, processingUntil: { $lte: now } }, { state: 'failed' }],
    }, {
      $setOnInsert: { eventId: event.id, type: event.type, expiresAt: new Date(Date.now() + 90 * 86_400_000) },
      $set: { state: 'processing', processingUntil: new Date(Date.now() + 2 * 60_000), error: null },
    }, { upsert: true, new: true })
  } catch (error: any) {
    if (error?.code === 11000) {
      const existing = await StripeEvent.findOne({ eventId: event.id }).lean()
      if (existing?.processedAt) { res.json({ received: true, duplicate: true }); return }
      sendProblem(req, res, { status: 409, title: 'Event already processing', detail: 'Event is already processing', retryable: true })
      return
    }
    throw error
  }
  if (!claim) { res.json({ received: true, duplicate: true }); return }
  try {
    await processStripeEvent(event)
    await StripeEvent.updateOne({ _id: claim._id }, { $set: { state: 'processed', processedAt: new Date() } })
    res.json({ received: true })
  } catch (error: any) {
    await StripeEvent.updateOne({ _id: claim._id }, { $set: { state: 'failed', error: String(error?.message || error).slice(0, 1_000), processingUntil: new Date() } })
    pino.error({ err: error, stripeEventId: event.id }, 'stripe event processing failed')
    sendProblem(req, res, { status: 500, title: 'Stripe event processing failed', detail: 'Stripe event processing failed', retryable: true })
  }
}

export default router
