import Contact from '../../models/Contact'
import Conversation from '../../models/Conversation'
import Message from '../../models/Message'
import Organization from '../../models/Organization'
import { encryptString } from '../../security/encryption'
import pino from '../../logger'
import { recordActivity } from '../crm/contactActivity'
import { providerChannelDispatcher } from '../sequences/channels'
import { assertNotSuppressed, SuppressedRecipientError } from '../sequences/suppression'
import { deferForQuietHours, isWithinQuietHours, normaliseTimeZone } from '../sequences/scheduleArithmetic'
import { messageAad, previewOf } from './inboundIngestion'

/**
 * Missed-call text back.
 *
 * A missed call from a lead is the highest-intent signal a small business gets
 * and the one most often lost: the caller rings, nobody answers, they ring the
 * next tradesperson on the list. An immediate text closes that gap.
 *
 * Three constraints, all of which the specification names and none of which are
 * optional:
 *
 *  - **Suppression is checked first.** Someone who opted out of SMS does not
 *    become contactable again by ringing. If anything, a missed call from a
 *    suppressed number is more likely to be a wrong number than a lead.
 *
 *  - **Quiet hours are respected.** A 2am missed call does not justify a 2am
 *    text. Unlike a sequence step, this one is NOT deferred to the morning: an
 *    automated "sorry we missed you" arriving nine hours later is confusing
 *    rather than helpful, and by then a human should handle it. It is skipped,
 *    and the skip is recorded so the operator can see it happened.
 *
 *  - **Only genuine no-answers.** A completed call did not go unanswered, and
 *    texting someone you just spoke to reads as automation nobody is minding.
 */

/** Twilio call statuses that mean the caller did not reach a person. */
const NO_ANSWER_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled'])

export function isMissedCallStatus(status: string): boolean {
  return NO_ANSWER_STATUSES.has(String(status || '').trim().toLowerCase())
}

export interface MissedCallResult {
  handled: boolean
  reason?: 'not_missed' | 'not_enabled' | 'no_matching_contact' | 'suppressed' | 'quiet_hours' | 'no_identity' | 'send_failed'
  contactId?: string
  messageId?: string
}

export interface MissedCallSettings {
  enabled: boolean
  messageTemplate: string
  quietHours: { enabled: boolean; startMinute: number; endMinute: number }
  defaultTimeZone: string
}

/**
 * Per-organisation configuration.
 *
 * Defaults to DISABLED. Enabling it means an automated SMS goes to anyone who
 * rings and is not answered, under the operator's own number and at their cost,
 * so it must be a deliberate act rather than something that starts happening
 * because a webhook was wired up.
 */
export async function missedCallSettings(organizationId: string): Promise<MissedCallSettings> {
  const organization: any = await Organization.findOne({ _id: organizationId }).select('missedCallTextBack timezone').lean()
  const configured = organization?.missedCallTextBack || {}
  return {
    enabled: Boolean(configured.enabled),
    messageTemplate: String(configured.messageTemplate || 'Sorry we missed your call. Reply here and we will get straight back to you.'),
    quietHours: {
      enabled: configured.quietHours?.enabled !== false,
      startMinute: Number(configured.quietHours?.startMinute ?? 1_260),
      endMinute: Number(configured.quietHours?.endMinute ?? 480),
    },
    defaultTimeZone: normaliseTimeZone(configured.defaultTimeZone || organization?.timezone || 'UTC'),
  }
}

export async function handleMissedCall(input: {
  organizationId: string
  fromNumber: string
  callStatus: string
  callSid?: string
  now?: Date
}): Promise<MissedCallResult> {
  const now = input.now ?? new Date()

  if (!isMissedCallStatus(input.callStatus)) return { handled: false, reason: 'not_missed' }

  const settings = await missedCallSettings(input.organizationId)
  if (!settings.enabled) return { handled: false, reason: 'not_enabled' }

  const contact: any = await Contact.findOne({ organizationId: input.organizationId, phone: input.fromNumber }).select('_id timezone firstName phone').lean()
  if (!contact) {
    // Matching only, never creation — the same rule as inbound ingestion. A
    // call webhook is unauthenticated.
    return { handled: false, reason: 'no_matching_contact' }
  }
  const contactId = String(contact._id)

  try {
    await assertNotSuppressed({ organizationId: input.organizationId, channel: 'sms', address: String(contact.phone || input.fromNumber) })
  } catch (error) {
    if (error instanceof SuppressedRecipientError) {
      await recordActivity({
        organizationId: input.organizationId, contactId, type: 'call.missed',
        summary: 'Missed call — no text sent, number is on the suppression list',
        metadata: { reason: error.reason }, occurredAt: now,
      })
      return { handled: false, reason: 'suppressed', contactId }
    }
    throw error
  }

  const timeZone = normaliseTimeZone(contact.timezone || settings.defaultTimeZone)
  if (isWithinQuietHours(now, settings.quietHours, timeZone)) {
    // Skipped, not deferred. A sequence step deferred overnight still makes
    // sense in the morning; "sorry we missed your call" nine hours later does
    // not, and by then a person should pick it up.
    const wouldResumeAt = deferForQuietHours(now, settings.quietHours, timeZone)
    await recordActivity({
      organizationId: input.organizationId, contactId, type: 'call.missed',
      summary: 'Missed call during quiet hours — no automated text sent',
      metadata: { wouldResumeAt, timeZone }, occurredAt: now,
    })
    return { handled: false, reason: 'quiet_hours', contactId }
  }

  const body = settings.messageTemplate.replace(/\{\{\s*contact\.firstName\s*\}\}/g, String(contact.firstName || '').trim())

  const conversation: any = await Conversation.findOneAndUpdate(
    { organizationId: input.organizationId, contactId },
    { $setOnInsert: { organizationId: input.organizationId, contactId, status: 'open' } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean()

  const message: any = await Message.create({
    organizationId: input.organizationId,
    conversationId: conversation._id,
    contactId,
    direction: 'outbound',
    channel: 'sms',
    preview: previewOf(body),
    status: 'queued',
    occurredAt: now,
  })
  const messageId = String(message._id)
  await Message.updateOne({ _id: messageId, organizationId: input.organizationId }, {
    $set: { bodyCiphertext: encryptString(body, messageAad(input.organizationId, messageId, 'body')) },
  })

  try {
    const result = await providerChannelDispatcher.send({
      organizationId: input.organizationId,
      channel: 'sms',
      step: { stepIndex: 0, channel: 'sms', wait: { kind: 'immediate' }, messagingIdentityId: null, bodyTemplate: body },
      contact: { id: contactId, phone: String(contact.phone || input.fromNumber), firstName: contact.firstName, fields: {} },
      recipient: String(contact.phone || input.fromNumber),
      enrolmentId: '',
      stepIndex: 0,
      sendRecordId: messageId,
      trackingToken: '',
    })
    await Message.updateOne({ _id: messageId, organizationId: input.organizationId }, {
      $set: { status: 'sent', provider: result.provider, providerMessageId: result.providerMessageId || null },
    })
    await Conversation.updateOne({ _id: conversation._id, organizationId: input.organizationId }, {
      $set: { lastMessageAt: now, lastOutboundAt: now, lastMessagePreview: previewOf(body), lastMessageDirection: 'outbound' },
      $addToSet: { channels: 'sms' },
    })
    await recordActivity({
      organizationId: input.organizationId, contactId, type: 'call.missed',
      summary: 'Missed call — automated text sent',
      entityType: 'Message', entityId: messageId, occurredAt: now,
    })
    return { handled: true, contactId, messageId }
  } catch (error) {
    await Message.updateOne({ _id: messageId, organizationId: input.organizationId }, { $set: { status: 'failed' } })
    pino.warn({ err: error, organizationId: input.organizationId, contactId }, 'missed-call text back failed to send')
    await recordActivity({
      organizationId: input.organizationId, contactId, type: 'call.missed',
      summary: 'Missed call — automated text failed to send',
      entityType: 'Message', entityId: messageId, occurredAt: now,
    })
    return { handled: false, reason: 'send_failed', contactId, messageId }
  }
}
