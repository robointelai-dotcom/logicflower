import crypto from 'crypto'
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import Contact from '../models/Contact'
import SendRecord from '../models/SendRecord'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { recordAudit } from '../services/audit'
import { addSuppression, type SuppressionChannel } from '../services/sequences/suppression'
import { exitEnrolmentsForContact } from '../services/sequences/enrolmentService'
import { ingestInboundMessage } from '../services/inbox/inboundIngestion'
import { handleMissedCall, isMissedCallStatus } from '../services/inbox/missedCall'
import MessagingIdentity from '../models/MessagingIdentity'

/**
 * The public messaging surface: unsubscribe and provider delivery callbacks.
 *
 * Everything here is reachable without authentication, which makes it the most
 * exposed part of Phase 1. Three rules apply throughout:
 *
 *  - The tracking token is the only identifier. It is 24 random bytes, scoped
 *    to one send record, and the organisation is derived from the record rather
 *    than accepted from the caller. Nothing in a query string decides which
 *    tenant an operation lands on.
 *
 *  - Every endpoint is rate limited by IP, because an unauthenticated endpoint
 *    without a limiter is a free amplifier.
 *
 *  - Responses do not distinguish "no such token" from "already processed".
 *    A distinguishable response turns these endpoints into an oracle for
 *    probing which addresses an organisation is mailing.
 */

const router = Router()

/**
 * Inbound provider endpoints, mounted separately so they are not confused with
 * the recipient-facing unsubscribe and tracking routes above. Both are public;
 * these ones write.
 */
export const publicMessagingRouter = Router()

const unsubscribeLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false })
const callbackLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false })
const trackingLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false })

/** Constant-ish response, whatever actually happened. */
const CONFIRMATION_HTML = `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>You have been unsubscribed</h1><p>You will not receive further messages from this sender on this channel.</p></body>`

function tokenFrom(value: unknown): string {
  const token = String(value || '').trim()
  // Length-bounded before it reaches a query, so an oversized value cannot be
  // used to probe the index.
  if (!token || token.length > 128) throw new HttpError(400, 'Invalid link', 'This unsubscribe link is not valid', problemType('unsubscribe-token-invalid'))
  return token
}

async function findSendByToken(trackingToken: string): Promise<any | null> {
  // tenant-safe: public endpoint; the unguessable per-send token is the identifier and the organisation is derived from the matched record
  const record: any = await SendRecord.findOne({ trackingToken }).select('_id organizationId contactId channel recipientDigest').lean()
  return record || null
}

/**
 * Apply an unsubscribe.
 *
 * Idempotent, and deliberately does more than add a list entry: the contact's
 * active enrolments are exited immediately. Adding the suppression alone would
 * technically be enough — the step runner checks suppression before every send
 * — but it would leave scheduled steps sitting in the queue looking as though
 * they will fire, which is indistinguishable to an operator from a bug.
 */
async function applyUnsubscribe(record: any, source: string): Promise<void> {
  const organizationId = String(record.organizationId)
  const channel = String(record.channel) as SuppressionChannel

  const contact: any = await Contact.findOne({ _id: record.contactId, organizationId }).select('email phone').lean()
  const address = channel === 'email' ? contact?.email : contact?.phone
  if (address) {
    await addSuppression({
      organizationId,
      channel,
      address: String(address),
      reason: 'unsubscribed',
      source,
      sendRecordId: String(record._id),
    })
  }

  await exitEnrolmentsForContact({ organizationId, contactId: String(record.contactId), reason: 'unsubscribed' })
  await recordAudit({
    organizationId,
    actorType: 'system',
    action: 'suppression.unsubscribe_received',
    entityType: 'SendRecord',
    entityId: String(record._id),
    metadata: { channel, source },
  })
}

/**
 * GET renders a confirmation rather than acting, because mail clients and
 * security scanners prefetch links. An unsubscribe that fires on GET gets
 * triggered by a scanner and removes a recipient who never clicked.
 */
router.get('/unsubscribe', unsubscribeLimiter, asyncHandler(async (req, res) => {
  const token = tokenFrom(req.query.t)
  res.type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Unsubscribe</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">`
    + `<h1>Unsubscribe</h1><p>Confirm that you no longer wish to receive these messages.</p>`
    + `<form method="post" action="unsubscribe"><input type="hidden" name="t" value="${token.replace(/[^A-Za-z0-9_-]/g, '')}">`
    + `<button type="submit" style="padding:.75rem 1.5rem;font-size:1rem">Unsubscribe me</button></form></body>`,
  )
}))

/**
 * POST performs the unsubscribe. Also the RFC 8058 one-click target, which
 * mail providers invoke as a POST with `List-Unsubscribe=One-Click`.
 */
router.post('/unsubscribe', unsubscribeLimiter, asyncHandler(async (req, res) => {
  const token = tokenFrom(req.body?.t ?? req.query.t)
  const record = await findSendByToken(token)
  if (record) await applyUnsubscribe(record, 'recipient_link')
  // Same response either way: a distinguishable 404 confirms which tokens are
  // live and turns this into an enumeration oracle.
  res.type('html').send(CONFIRMATION_HTML)
}))

/* ------------------------------------------------------------- open and click */

const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/**
 * Open tracking. Disableable per organisation for privacy compliance: when an
 * organisation has turned tracking off the pixel still renders, so message
 * layout is unaffected, but nothing is recorded.
 */
router.get('/track/open/:token', trackingLimiter, asyncHandler(async (req, res) => {
  const token = tokenFrom(req.params.token)
  const record = await findSendByToken(token)
  if (record) {
    const { trackingEnabledFor } = await import('../services/sequences/deliveryTracking')
    if (await trackingEnabledFor(String(record.organizationId))) {
      await SendRecord.updateOne(
        { _id: record._id, organizationId: String(record.organizationId), status: { $in: ['sent', 'delivered'] } },
        { $set: { status: 'opened', openedAt: new Date() } },
      )
    }
  }
  res.type('gif').set('Cache-Control', 'no-store').send(TRANSPARENT_GIF)
}))

/* ------------------------------------------------------- provider callbacks */

/**
 * Twilio message status callback.
 *
 * NOTE ON VERIFICATION: Twilio signs callbacks with an `X-Twilio-Signature`
 * header computed over the URL and the POSTed parameters using the account's
 * auth token. That verification is NOT implemented here, because the auth token
 * needed to compute it is per-organisation and encrypted, and the organisation
 * is not known until the message SID has been looked up — which is itself the
 * thing the signature is meant to authenticate.
 *
 * The interim control is that this endpoint only ever acts on a MessageSid that
 * already exists as a `providerMessageId` in the ledger, and only ever moves a
 * send along its own status track. An attacker who guesses a SID can mark a
 * message delivered or failed; they cannot cause a send, read an address, or
 * reach another tenant. Signature verification must be completed before this is
 * relied on for billing or compliance evidence — see LIVE_ACCEPTANCE.
 */
router.post('/callbacks/twilio', callbackLimiter, asyncHandler(async (req, res) => {
  const messageSid = String(req.body?.MessageSid || req.body?.SmsSid || '').trim().slice(0, 128)
  const status = String(req.body?.MessageStatus || req.body?.SmsStatus || '').trim().toLowerCase()
  if (!messageSid || !status) return res.status(204).end()

  // tenant-safe: public provider callback; the provider message id is matched against the ledger and the organisation is derived from the matched record
  const record: any = await SendRecord.findOne({ providerMessageId: messageSid }).select('_id organizationId contactId channel').lean()
  if (!record) return res.status(204).end()
  const organizationId = String(record.organizationId)
  const now = new Date()

  if (status === 'delivered') {
    await SendRecord.updateOne({ _id: record._id, organizationId, status: 'sent' }, { $set: { status: 'delivered', deliveredAt: now } })
  } else if (status === 'failed' || status === 'undelivered') {
    await SendRecord.updateOne({ _id: record._id, organizationId }, { $set: { status: 'bounced', bouncedAt: now, bounceType: 'hard' } })
    const contact: any = await Contact.findOne({ _id: record.contactId, organizationId }).select('phone').lean()
    if (contact?.phone) {
      // A permanently undeliverable number feeds suppression, which is what
      // makes the onBounced exit condition effective on every later step.
      await addSuppression({ organizationId, channel: 'sms', address: String(contact.phone), reason: 'hard_bounce', source: 'twilio_callback', sendRecordId: String(record._id) })
      await exitEnrolmentsForContact({ organizationId, contactId: String(record.contactId), reason: 'bounced' })
    }
  }
  res.status(204).end()
}))

/**
 * SendGrid event webhook.
 *
 * Signature verification (`X-Twilio-Email-Event-Webhook-Signature`, ECDSA over
 * timestamp + body against a per-account public key) is NOT implemented, for
 * the same reason as above: the verification key is per-organisation. The same
 * interim control applies — events are matched to existing ledger records by
 * the custom argument written at send time, and cannot cross a tenant boundary.
 */
router.post('/callbacks/sendgrid', callbackLimiter, asyncHandler(async (req, res) => {
  const events = Array.isArray(req.body) ? req.body.slice(0, 500) : []
  const now = new Date()

  for (const event of events) {
    const sendRecordId = String(event?.sendRecordId || '').trim()
    const organizationId = String(event?.organizationId || '').trim()
    const type = String(event?.event || '').trim().toLowerCase()
    if (!sendRecordId || !organizationId || !type) continue

    // Both identifiers came back from the provider as custom arguments we set
    // ourselves; the pair must match a record we wrote, or it is ignored.
    const record: any = await SendRecord.findOne({ _id: sendRecordId, organizationId }).select('_id contactId channel').lean()
    if (!record) continue

    if (type === 'delivered') {
      await SendRecord.updateOne({ _id: record._id, organizationId, status: 'sent' }, { $set: { status: 'delivered', deliveredAt: now } })
    } else if (type === 'open') {
      const { trackingEnabledFor } = await import('../services/sequences/deliveryTracking')
      if (await trackingEnabledFor(organizationId)) {
        await SendRecord.updateOne({ _id: record._id, organizationId, status: { $in: ['sent', 'delivered'] } }, { $set: { status: 'opened', openedAt: now } })
      }
    } else if (type === 'click') {
      const { trackingEnabledFor } = await import('../services/sequences/deliveryTracking')
      if (await trackingEnabledFor(organizationId)) {
        await SendRecord.updateOne({ _id: record._id, organizationId }, { $set: { status: 'clicked', clickedAt: now } })
      }
    } else if (type === 'bounce' || type === 'dropped' || type === 'spamreport' || type === 'unsubscribe') {
      const hard = type === 'bounce' || type === 'dropped'
      const bounceType = type === 'spamreport' ? 'complaint' : hard ? 'hard' : 'soft'
      await SendRecord.updateOne({ _id: record._id, organizationId }, { $set: { status: 'bounced', bouncedAt: now, bounceType } })
      const contact: any = await Contact.findOne({ _id: record.contactId, organizationId }).select('email').lean()
      if (contact?.email) {
        await addSuppression({
          organizationId,
          channel: 'email',
          address: String(contact.email),
          reason: type === 'spamreport' ? 'complaint' : type === 'unsubscribe' ? 'unsubscribed' : 'hard_bounce',
          source: 'sendgrid_webhook',
          sendRecordId: String(record._id),
        })
        await exitEnrolmentsForContact({ organizationId, contactId: String(record.contactId), reason: type === 'unsubscribe' ? 'unsubscribed' : 'bounced' })
      }
    }
  }
  res.status(204).end()
}))

/* --------------------------------------------------------- inbound messages */

/**
 * Resolve which organisation an inbound message on a number belongs to.
 *
 * The receiving number is the tenant key: it is the operator's own provisioned
 * number, recorded on a MessagingIdentity. Deriving the organisation from it
 * rather than accepting one from the request body is what keeps an
 * unauthenticated endpoint from being a cross-tenant write.
 *
 * A number that matches no identity resolves to nothing and the message is
 * dropped, rather than falling back to any default.
 */
async function organizationForInboundNumber(toNumber: string): Promise<string | null> {
  const normalised = String(toNumber || '').trim()
  if (!normalised) return null
  // tenant-safe: public inbound endpoint; the operator's own provisioned number is the tenant key and the organisation is derived from the matched identity
  const identity: any = await MessagingIdentity.findOne({ fromNumber: normalised, status: 'active' }).select('organizationId').lean()
  return identity ? String(identity.organizationId) : null
}

/**
 * Twilio inbound SMS.
 *
 * Signature verification is NOT implemented, for the reason recorded in
 * REMEDIATION_2_0.md §4.3: the verification key is per-organisation and the
 * organisation is not known until the receiving number has been looked up.
 *
 * The interim controls here are narrower than for the status callback, because
 * this endpoint WRITES rather than updating an existing record. A forged
 * request could insert a message into a thread and exit that contact's
 * sequences. It cannot create a contact (matching only), cannot reach a tenant
 * whose number it does not know, and cannot cause an outbound send. Close this
 * before relying on inbound for anything contractual.
 */
publicMessagingRouter.post('/inbound/twilio/sms', callbackLimiter, asyncHandler(async (req, res) => {
  const fromNumber = String(req.body?.From || '').trim().slice(0, 32)
  const toNumber = String(req.body?.To || '').trim().slice(0, 32)
  const body = String(req.body?.Body ?? '').slice(0, 10_000)
  const messageSid = String(req.body?.MessageSid || req.body?.SmsSid || '').trim().slice(0, 128)
  if (!fromNumber || !toNumber) return res.status(204).end()

  const organizationId = await organizationForInboundNumber(toNumber)
  if (!organizationId) return res.status(204).end()

  await ingestInboundMessage({
    organizationId,
    channel: 'sms',
    fromAddress: fromNumber,
    body,
    providerMessageId: messageSid || undefined,
    provider: 'twilio',
  })
  // An empty TwiML response: acknowledged, no auto-reply. Any reply is the
  // operator's to send, from the inbox or a sequence.
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
}))

/**
 * Twilio voice status callback, for missed-call text back.
 *
 * Distinct from the message status callback above: this one carries CallStatus
 * and fires the text-back path.
 */
publicMessagingRouter.post('/inbound/twilio/voice-status', callbackLimiter, asyncHandler(async (req, res) => {
  const fromNumber = String(req.body?.From || '').trim().slice(0, 32)
  const toNumber = String(req.body?.To || '').trim().slice(0, 32)
  const callStatus = String(req.body?.CallStatus || '').trim().slice(0, 32)
  if (!fromNumber || !toNumber || !isMissedCallStatus(callStatus)) return res.status(204).end()

  const organizationId = await organizationForInboundNumber(toNumber)
  if (!organizationId) return res.status(204).end()

  await handleMissedCall({
    organizationId,
    fromNumber,
    callStatus,
    callSid: String(req.body?.CallSid || '').slice(0, 128),
  })
  res.status(204).end()
}))

/**
 * SendGrid inbound parse.
 *
 * The `to` address is the tenant key here, matched against a MessagingIdentity
 * `fromAddress` — replies come back to the address the mail was sent from.
 */
publicMessagingRouter.post('/inbound/sendgrid/email', callbackLimiter, asyncHandler(async (req, res) => {
  const fromRaw = String(req.body?.from || '').trim().slice(0, 320)
  const toRaw = String(req.body?.to || '').trim().slice(0, 320)
  if (!fromRaw || !toRaw) return res.status(204).end()

  // "Name <address@example.com>" is the common form; the address is what matters.
  const extractAddress = (value: string) => {
    const angled = value.match(/<([^>]+)>/)
    return (angled?.[1] || value).trim().toLowerCase()
  }
  const toAddress = extractAddress(toRaw)

  // tenant-safe: public inbound endpoint; the operator's own sending address is the tenant key and the organisation is derived from the matched identity
  const identity: any = await MessagingIdentity.findOne({ fromAddress: toAddress, status: 'active' }).select('organizationId').lean()
  if (!identity) return res.status(204).end()

  await ingestInboundMessage({
    organizationId: String(identity.organizationId),
    channel: 'email',
    fromAddress: extractAddress(fromRaw),
    // Prefer the plain-text part. Storing raw HTML would mean every surface
    // that renders a thread has to sanitise it correctly, forever.
    body: String(req.body?.text ?? '').slice(0, 100_000),
    subject: String(req.body?.subject || '').slice(0, 998),
    providerMessageId: String(req.body?.['Message-Id'] || req.body?.message_id || '').slice(0, 200) || undefined,
    provider: 'sendgrid',
  })
  res.status(204).end()
}))

/** Deterministic token comparison helper, kept for future signed callbacks. */
export function timingSafeTokenEqual(a: string, b: string): boolean {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

export default router
