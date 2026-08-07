import Contact from '../../models/Contact'
import Conversation from '../../models/Conversation'
import Message from '../../models/Message'
import SequenceEnrolment from '../../models/SequenceEnrolment'
import { encryptString } from '../../security/encryption'
import pino from '../../logger'
import { recordAudit } from '../audit'
import { recordActivity } from '../crm/contactActivity'
import { exitEnrolment } from '../sequences/enrolmentService'
import { addSuppression, normaliseAddress, type SuppressionChannel } from '../sequences/suppression'

/**
 * Inbound message ingestion.
 *
 * The most important behaviour in Phase 3, stated plainly: **an inbound message
 * exits every active sequence enrolment for that contact.** Someone who replies
 * must stop receiving automated follow-up. Getting this wrong is not a cosmetic
 * failure — it is a person answering a question and then being chased three
 * more times by a machine that did not notice, which is the single most
 * damaging thing an automated follow-up system can do to a customer
 * relationship.
 *
 * Until now that exit could only be triggered by an explicit API call from the
 * operator's own systems. This module makes it automatic.
 *
 * Ingestion is idempotent by provider message id. Providers retry webhooks, and
 * without idempotence a redelivery both duplicates the thread entry and fires
 * the exit a second time.
 */

export type InboundChannel = 'email' | 'sms' | 'whatsapp' | 'webchat'

const DUPLICATE_KEY = 11_000

export interface InboundMessage {
  organizationId: string
  channel: InboundChannel
  /** The contact's address: email, E.164 number, or a web chat session id. */
  fromAddress: string
  body: string
  subject?: string
  providerMessageId?: string
  provider?: string
  occurredAt?: Date
}

export interface IngestResult {
  accepted: boolean
  duplicate: boolean
  contactId?: string
  conversationId?: string
  messageId?: string
  exitedEnrolments: number
  /** Set when the message was an opt-out keyword rather than a conversation. */
  optOut?: boolean
  reason?: string
}

/**
 * Standard opt-out keywords.
 *
 * Recognised on SMS and WhatsApp because carriers and regulators expect them,
 * and because a person typing STOP has unambiguously withdrawn consent whether
 * or not the operator built an unsubscribe link into that channel. Matched on
 * the whole trimmed body only: a message reading "stop by the shop tomorrow"
 * is a conversation, not an opt-out, and treating it as one silently loses a
 * customer.
 */
const OPT_OUT_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt-out', 'revoke'])

export function isOptOutKeyword(body: string): boolean {
  const normalised = String(body || '').trim().toLowerCase().replace(/[.!]+$/, '')
  return OPT_OUT_KEYWORDS.has(normalised)
}

export function messageAad(organizationId: string, messageId: string, field: 'body' | 'subject'): string {
  return `message:${organizationId}:${messageId}:${field}`
}

/** Truncated, single-line preview safe to render in a list view. */
export function previewOf(body: string, limit = 140): string {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function redactAddress(channel: InboundChannel, address: string): string {
  const value = String(address || '').trim()
  if (!value) return ''
  if (channel === 'email') {
    const [local = '', domain = ''] = value.split('@')
    return domain ? `${local.slice(0, 1)}***@${domain}` : '***'
  }
  return value.length <= 8 ? `${value.slice(0, 2)}***` : `${value.slice(0, 5)}***${value.slice(-4)}`
}

/**
 * Find the contact an inbound message belongs to.
 *
 * Matching only, never creation. An unmatched inbound message is reported and
 * dropped rather than silently creating a contact: an inbound webhook is
 * unauthenticated, and auto-creating records from it turns the endpoint into a
 * way for anyone to write into a customer's CRM.
 */
export async function matchContact(input: { organizationId: string; channel: InboundChannel; fromAddress: string }): Promise<string | null> {
  const channelForNormalisation: SuppressionChannel = input.channel === 'email' ? 'email' : 'sms'
  const normalised = input.channel === 'webchat'
    ? String(input.fromAddress || '').trim()
    : normaliseAddress(channelForNormalisation, input.fromAddress)
  if (!normalised) return null

  const query: Record<string, unknown> = { organizationId: input.organizationId }
  if (input.channel === 'email') query.email = normalised
  else query.phone = normalised

  const contact: any = await Contact.findOne(query).select('_id').lean()
  return contact ? String(contact._id) : null
}

/**
 * Exit every active enrolment for a contact because they replied.
 *
 * Separated so it can be called from the webchat and email paths as well, and
 * so the behaviour is testable on its own.
 */
export async function exitEnrolmentsOnReply(input: {
  organizationId: string
  contactId: string
  now: Date
}): Promise<number> {
  const active: any[] = await SequenceEnrolment.find({
    organizationId: input.organizationId,
    contactId: input.contactId,
    status: 'active',
  }).select('_id').limit(500).lean()

  let exited = 0
  for (const enrolment of active) {
    const result = await exitEnrolment({
      organizationId: input.organizationId,
      enrolmentId: String(enrolment._id),
      reason: 'replied',
      now: input.now,
    })
    if (result.exited) exited += 1
  }
  return exited
}

/**
 * Ingest one inbound message.
 *
 * Order of operations, and the reasoning for it:
 *
 *  1. Match the contact. No match, no write.
 *  2. Write the message, idempotently. A duplicate stops here — before the exit
 *     is fired a second time.
 *  3. Update the thread and the contact's inbound marker.
 *  4. Exit active enrolments.
 *  5. Apply an opt-out if the body was a stop keyword.
 *
 * The exit comes after the message write so that a crash between them leaves a
 * visible message with sequences still running — recoverable, and obvious to an
 * operator looking at the thread. The reverse order would exit sequences with
 * no record of why.
 */
export async function ingestInboundMessage(input: InboundMessage): Promise<IngestResult> {
  const now = input.occurredAt ?? new Date()
  const organizationId = input.organizationId

  const contactId = await matchContact({ organizationId, channel: input.channel, fromAddress: input.fromAddress })
  if (!contactId) {
    // Reported, not created. This endpoint is unauthenticated; auto-creating a
    // contact from it would let anyone write into a customer's CRM.
    pino.info({ organizationId, channel: input.channel }, 'inbound message did not match a known contact and was dropped')
    return { accepted: false, duplicate: false, exitedEnrolments: 0, reason: 'no_matching_contact' }
  }

  const conversation: any = await Conversation.findOneAndUpdate(
    { organizationId, contactId },
    { $setOnInsert: { organizationId, contactId, status: 'open' } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean()
  const conversationId = String(conversation._id)

  const preview = previewOf(input.body)
  let messageId: string
  try {
    const created: any = await Message.create({
      organizationId,
      conversationId,
      contactId,
      direction: 'inbound',
      channel: input.channel,
      preview,
      addressPreview: redactAddress(input.channel, input.fromAddress),
      providerMessageId: input.providerMessageId || null,
      provider: input.provider,
      status: 'received',
      occurredAt: now,
    })
    messageId = String(created._id)
    // The body is encrypted in a second write, because the AAD binds the
    // ciphertext to the record's own id and that id does not exist until the
    // record does.
    await Message.updateOne({ _id: messageId, organizationId }, {
      $set: {
        bodyCiphertext: encryptString(String(input.body ?? ''), messageAad(organizationId, messageId, 'body')),
        ...(input.subject ? { subjectCiphertext: encryptString(String(input.subject), messageAad(organizationId, messageId, 'subject')) } : {}),
      },
    })
  } catch (error: any) {
    if (Number(error?.code) === DUPLICATE_KEY) {
      // A provider redelivery. Stopping here is the point: firing the reply
      // exit twice is harmless, but re-applying an opt-out or duplicating the
      // thread entry is not.
      return { accepted: true, duplicate: true, contactId, conversationId, exitedEnrolments: 0, reason: 'duplicate_provider_message' }
    }
    throw error
  }

  await Conversation.updateOne({ _id: conversationId, organizationId }, {
    $set: {
      lastMessageAt: now,
      lastInboundAt: now,
      lastMessagePreview: preview,
      lastMessageDirection: 'inbound',
      status: 'open',
      snoozedUntil: null,
    },
    $inc: { unreadCount: 1 },
    $addToSet: { channels: input.channel },
  })
  await Contact.updateOne({ _id: contactId, organizationId }, { $set: { lastInboundAt: now } })

  const exitedEnrolments = await exitEnrolmentsOnReply({ organizationId, contactId, now })

  let optOut = false
  if ((input.channel === 'sms' || input.channel === 'whatsapp') && isOptOutKeyword(input.body)) {
    optOut = true
    await addSuppression({
      organizationId,
      channel: input.channel,
      address: input.fromAddress,
      reason: 'unsubscribed',
      source: `inbound_${input.channel}_keyword`,
    })
    await recordAudit({
      organizationId,
      actorType: 'system',
      action: 'suppression.opt_out_keyword_received',
      entityType: 'Message',
      entityId: messageId,
      metadata: { channel: input.channel },
    })
  }

  await recordActivity({
    organizationId,
    contactId,
    type: 'message.received',
    // The summary carries no message content. A reply may say anything, and the
    // timeline is the surface most likely to be rendered somewhere broad.
    summary: optOut ? `Opt-out received on ${input.channel}` : `Reply received on ${input.channel}`,
    entityType: 'Message',
    entityId: messageId,
    metadata: { channel: input.channel, exitedEnrolments },
    occurredAt: now,
  })

  return { accepted: true, duplicate: false, contactId, conversationId, messageId, exitedEnrolments, optOut }
}
