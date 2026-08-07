import Stripe from 'stripe'
import Contact from '../../models/Contact'
import Organization from '../../models/Organization'
import PaymentLink from '../../models/PaymentLink'
import { decryptString, encryptString } from '../../security/encryption'
import { HttpError, problemType } from '../../http/problem'
import { env } from '../../env'
import pino from '../../logger'
import { recordAudit } from '../audit'
import { recordActivity } from './contactActivity'

/**
 * Customer-facing payment links.
 *
 * THE SEPARATION THAT MATTERS
 *
 * There are two entirely distinct Stripe relationships in this product:
 *
 *   1. PLATFORM BILLING — the platform's own Stripe account, collecting
 *      subscription revenue from operators. Configured through
 *      `env.STRIPE_SECRET_KEY` and handled in `routes/billing.ts`.
 *
 *   2. CUSTOMER PAYMENTS — each operator's OWN Stripe account, collecting money
 *      from their customers. That is this file.
 *
 * They must never share configuration. **Nothing here reads
 * `env.STRIPE_SECRET_KEY`**, and a runtime guard below asserts it: if the
 * platform key were ever used to create a customer payment link, an operator's
 * customer would pay the platform instead of the operator, and the money would
 * land in the wrong bank account. That is not a bug anyone recovers from
 * gracefully.
 *
 * Credentials follow the `MessagingIdentity` pattern already established:
 * per organisation, encrypted with a per-record AAD, never selected by default.
 *
 * ON STRIPE CONNECT
 *
 * Connect is the other way to do this, and for a platform taking a fee it is
 * usually the right one. It was not chosen here because it changes the
 * commercial relationship — the platform becomes a payment facilitator with
 * onboarding, KYC and liability obligations — and that is a business decision
 * rather than a technical one. The per-organisation key approach works today,
 * keeps the platform out of the money flow entirely, and does not preclude
 * adding Connect later behind the same interface.
 */

export function stripeCredentialAad(organizationId: string): string {
  return `payments-stripe:${organizationId}:secret-key`
}

export async function storeStripeCredential(input: { organizationId: string; secretKey: string; userId?: string }): Promise<void> {
  const key = String(input.secretKey || '').trim()
  if (!key.startsWith('sk_') && !key.startsWith('rk_')) {
    throw new HttpError(400, 'Invalid Stripe key', 'Expected a Stripe secret or restricted key beginning sk_ or rk_', problemType('payments-key-invalid'))
  }
  // The guard that stops the two Stripe relationships being confused.
  if (env.STRIPE_SECRET_KEY && key === env.STRIPE_SECRET_KEY) {
    throw new HttpError(
      400,
      'Refusing the platform key',
      'That is the platform billing key. Using it here would route your customers\' payments to the platform rather than to you. Supply your own organisation\'s Stripe key.',
      problemType('payments-key-is-platform-key'),
    )
  }

  await Organization.updateOne({ _id: input.organizationId }, {
    $set: {
      'payments.provider': 'stripe',
      'payments.credentialCiphertext': encryptString(key, stripeCredentialAad(input.organizationId)),
      'payments.livemode': key.includes('_live_'),
      'payments.linkedAt': new Date(),
    },
  })
  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    actorType: input.userId ? 'user' : 'system',
    action: 'payments.credential_stored',
    entityType: 'Organization',
    entityId: input.organizationId,
    metadata: { provider: 'stripe', livemode: key.includes('_live_') },
  })
}

async function stripeFor(organizationId: string): Promise<Stripe> {
  const organization: any = await Organization.findOne({ _id: organizationId })
    .select('+payments.credentialCiphertext payments').lean()
  const ciphertext = organization?.payments?.credentialCiphertext
  if (!ciphertext) {
    throw new HttpError(409, 'Payments not configured', 'This organisation has no payment provider connected.', problemType('payments-not-configured'))
  }
  let secretKey: string
  try {
    secretKey = decryptString(ciphertext, stripeCredentialAad(organizationId))
  } catch {
    throw new HttpError(409, 'Payment credential unreadable', 'The stored payment credential could not be decrypted.', problemType('payments-credential-unreadable'))
  }
  if (env.STRIPE_SECRET_KEY && secretKey === env.STRIPE_SECRET_KEY) {
    // Defence in depth: even if a platform key were stored somehow, it is
    // refused at use rather than silently charging into the wrong account.
    throw new HttpError(409, 'Refusing the platform key', 'The stored credential is the platform billing key and will not be used for customer payments.', problemType('payments-key-is-platform-key'))
  }
  return new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 })
}

export const MIN_AMOUNT_MINOR_UNITS = 1
export const MAX_AMOUNT_MINOR_UNITS = 100_000_000

export interface CreatePaymentLinkResult {
  id: string
  url: string
  amountMinorUnits: number
  currency: string
}

/**
 * Create a payment link for one contact.
 *
 * A Checkout Session with inline price data rather than a reusable Price
 * object, because these are ad-hoc amounts — a quote for one job — and creating
 * a permanent Price per invoice would fill the operator's Stripe account with
 * thousands of single-use products.
 *
 * The local record is written BEFORE the Stripe call and updated after, the same
 * ordering as the send ledger in Phase 1 and for the same reason: if the call
 * succeeds and the process dies before recording it, a link exists that this
 * system has no record of and nobody can reconcile.
 */
export async function createPaymentLink(input: {
  organizationId: string
  contactId: string
  dealId?: string | null
  description: string
  amountMinorUnits: number
  currency: string
  userId?: string
}): Promise<CreatePaymentLinkResult> {
  const description = String(input.description || '').trim().slice(0, 200)
  if (!description) throw new HttpError(400, 'Description required', 'A payment link needs a description the customer will see')

  const amount = Number(input.amountMinorUnits)
  if (!Number.isInteger(amount) || amount < MIN_AMOUNT_MINOR_UNITS || amount > MAX_AMOUNT_MINOR_UNITS) {
    throw new HttpError(400, 'Invalid amount', `Amount must be a whole number of minor currency units between ${MIN_AMOUNT_MINOR_UNITS} and ${MAX_AMOUNT_MINOR_UNITS}`, problemType('payments-amount-invalid'))
  }
  const currency = String(input.currency || '').trim().toLowerCase()
  if (!/^[a-z]{3}$/.test(currency)) throw new HttpError(400, 'Invalid currency', 'Currency must be a three-letter ISO code', problemType('payments-currency-invalid'))

  const contact: any = await Contact.findOne({ _id: input.contactId, organizationId: input.organizationId }).select('email').lean()
  if (!contact) throw new HttpError(404, 'Contact not found', 'No contact with that identifier exists in this organisation')

  const record: any = await PaymentLink.create({
    organizationId: input.organizationId,
    contactId: input.contactId,
    dealId: input.dealId || null,
    provider: 'stripe',
    description,
    amountMinorUnits: amount,
    currency: currency.toUpperCase(),
    status: 'created',
    createdBy: input.userId,
  })

  try {
    const stripe = await stripeFor(input.organizationId)
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: { currency, unit_amount: amount, product_data: { name: description } },
      }],
      ...(contact.email ? { customer_email: String(contact.email) } : {}),
      success_url: `${env.APP_URL.replace(/\/$/, '')}/payment/complete`,
      cancel_url: `${env.APP_URL.replace(/\/$/, '')}/payment/cancelled`,
      // Carried so a webhook can be matched back without trusting anything in
      // the request that produced it.
      metadata: { paymentLinkId: String(record._id), organizationId: input.organizationId, contactId: String(input.contactId) },
    })

    await PaymentLink.updateOne({ _id: record._id, organizationId: input.organizationId }, {
      $set: { providerObjectId: session.id, url: session.url || undefined, expiresAt: session.expires_at ? new Date(session.expires_at * 1_000) : null },
    })
    await recordActivity({
      organizationId: input.organizationId, contactId: String(input.contactId), type: 'payment.link_created',
      summary: `Payment link created for ${description}`,
      entityType: 'PaymentLink', entityId: String(record._id),
      metadata: { amountMinorUnits: amount, currency: currency.toUpperCase() }, actorUserId: input.userId,
    })
    return { id: String(record._id), url: String(session.url || ''), amountMinorUnits: amount, currency: currency.toUpperCase() }
  } catch (error: any) {
    await PaymentLink.updateOne({ _id: record._id, organizationId: input.organizationId }, { $set: { status: 'cancelled' } })
    pino.warn({ err: error, organizationId: input.organizationId }, 'payment link creation failed')
    throw new HttpError(502, 'Payment link could not be created', String(error?.message || 'The payment provider rejected the request'), problemType('payments-link-failed'))
  }
}

/**
 * Record a completed payment.
 *
 * Idempotent by payment link status: a redelivered webhook, or a manual
 * reconciliation running alongside one, must not add the revenue twice.
 */
export async function markPaymentReceived(input: {
  organizationId: string
  paymentLinkId: string
  now?: Date
}): Promise<{ recorded: boolean }> {
  const now = input.now ?? new Date()
  const result = await PaymentLink.updateOne(
    { _id: input.paymentLinkId, organizationId: input.organizationId, status: 'created' },
    { $set: { status: 'paid', paidAt: now } },
  )
  // A no-op means it was already paid. Stopping here is the guard.
  if (!Number((result as any).modifiedCount || 0)) return { recorded: false }

  const link: any = await PaymentLink.findOne({ _id: input.paymentLinkId, organizationId: input.organizationId }).lean()
  if (!link) return { recorded: false }

  // This is what finally makes `Contact.revenueMinorUnits` mean something. It
  // was present and always zero until payments existed.
  await Contact.updateOne({ _id: link.contactId, organizationId: input.organizationId }, {
    $inc: { revenueMinorUnits: Number(link.amountMinorUnits || 0) },
    $set: { revenueCurrency: link.currency },
  })
  await recordActivity({
    organizationId: input.organizationId, contactId: String(link.contactId), type: 'payment.received',
    summary: `Payment received: ${link.description}`,
    entityType: 'PaymentLink', entityId: String(link._id),
    metadata: { amountMinorUnits: Number(link.amountMinorUnits || 0), currency: link.currency }, occurredAt: now,
  })
  await recordAudit({
    organizationId: input.organizationId, actorType: 'system', action: 'payments.received',
    entityType: 'PaymentLink', entityId: String(link._id),
    metadata: { amountMinorUnits: Number(link.amountMinorUnits || 0), currency: link.currency },
  })
  return { recorded: true }
}
