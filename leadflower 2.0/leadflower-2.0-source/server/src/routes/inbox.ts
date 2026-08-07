import { Router } from 'express'
import { Types } from 'mongoose'
import Contact from '../models/Contact'
import Conversation from '../models/Conversation'
import Message from '../models/Message'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor'
import { requireOrganizationId } from '../types/authenticatedRequest'
import { decryptString, encryptString } from '../security/encryption'
import { recordAudit } from '../services/audit'
import { recordActivity } from '../services/crm/contactActivity'
import { messageAad, previewOf } from '../services/inbox/inboundIngestion'
import { providerChannelDispatcher } from '../services/sequences/channels'
import { assertNotSuppressed, SuppressedRecipientError } from '../services/sequences/suppression'
import { applySnapshot, listSnapshots } from '../services/snapshots/industrySnapshots'

const router = Router()

function objectId(value: unknown, label: string): string {
  const id = String(value || '')
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, `Invalid ${label}`, `${label} identifier is invalid`)
  return id
}

function requireOperator(req: any): void {
  if (!['owner', 'admin', 'operator'].includes(String(req.auth?.role || ''))) {
    throw new HttpError(403, 'Insufficient role', 'Owner, admin, or operator role is required')
  }
}

/* --------------------------------------------------------------------- inbox */

router.get('/conversations', asyncHandler(async (req, res) => {
  const query: any = { organizationId: requireOrganizationId(req) }
  if (req.query.status) query.status = String(req.query.status).slice(0, 16)
  if (String(req.query.mine || '') === 'true') query.assigneeUserId = String(req.auth?.userId || '')
  if (String(req.query.unread || '') === 'true') query.unreadCount = { $gt: 0 }

  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) query._id = { $lt: cursor }

  const rows: any[] = await Conversation.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    // The list renders from previews alone and decrypts nothing. A thread list
    // is the most frequently loaded view in the product; decrypting every
    // latest message to render it would be both slow and a needless widening
    // of where plaintext appears.
    conversations: rows.slice(0, limit).map((row) => ({
      id: String(row._id),
      contactId: String(row.contactId),
      status: row.status,
      channels: row.channels || [],
      assigneeUserId: row.assigneeUserId,
      lastMessageAt: row.lastMessageAt,
      lastMessagePreview: row.lastMessagePreview,
      lastMessageDirection: row.lastMessageDirection,
      unreadCount: Number(row.unreadCount || 0),
    })),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

/**
 * One thread, decrypted.
 *
 * This is the only endpoint that returns message plaintext, which makes it the
 * one to audit. Opening a thread is recorded, because in a clinic or a legal
 * practice "who read this conversation" is a question that will eventually be
 * asked and cannot be answered retrospectively.
 */
router.get('/conversations/:conversationId', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const conversationId = objectId(req.params.conversationId, 'conversation')

  const conversation: any = await Conversation.findOne({ _id: conversationId, organizationId }).lean()
  if (!conversation) throw new HttpError(404, 'Conversation not found', 'No conversation with that identifier exists in this organisation')

  const rows: any[] = await Message.find({ organizationId, conversationId })
    .sort({ occurredAt: -1 })
    .limit(Math.max(1, Math.min(pageLimit(req.query.limit), 200)))
    .select('+bodyCiphertext +subjectCiphertext')
    .lean()

  const messages = rows.map((row) => {
    let body = ''
    let subject: string | undefined
    try {
      if (row.bodyCiphertext) body = decryptString(row.bodyCiphertext, messageAad(organizationId, String(row._id), 'body'))
      if (row.subjectCiphertext) subject = decryptString(row.subjectCiphertext, messageAad(organizationId, String(row._id), 'subject'))
    } catch {
      // A ciphertext that will not open under its own AAD is corrupt or belongs
      // to another record. Surfacing the failure per message keeps the rest of
      // the thread readable rather than failing the whole request.
      body = ''
      subject = undefined
    }
    return {
      id: String(row._id),
      direction: row.direction,
      channel: row.channel,
      body,
      subject,
      unreadable: Boolean(row.bodyCiphertext) && !body,
      addressPreview: row.addressPreview,
      status: row.status,
      authorUserId: row.authorUserId,
      occurredAt: row.occurredAt,
    }
  }).reverse()

  await Conversation.updateOne({ _id: conversationId, organizationId }, { $set: { unreadCount: 0 } })
  await recordAudit({
    req, organizationId, action: 'inbox.conversation_read',
    entityType: 'Conversation', entityId: conversationId,
    metadata: { messageCount: messages.length },
  })

  res.json({
    conversation: {
      id: conversationId,
      contactId: String(conversation.contactId),
      status: conversation.status,
      channels: conversation.channels || [],
      assigneeUserId: conversation.assigneeUserId,
    },
    messages,
  })
}))

/** Send a human-typed reply into a thread. */
router.post('/conversations/:conversationId/messages', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const conversationId = objectId(req.params.conversationId, 'conversation')
  const channel = String(req.body?.channel || '')
  if (!['email', 'sms'].includes(channel)) {
    // WhatsApp is excluded because its provider call is not implemented, and
    // webchat outbound needs the widget's transport, which does not exist yet.
    throw new HttpError(400, 'Unsupported channel', 'Replies can currently be sent on email or SMS', problemType('inbox-channel-unsupported'))
  }
  const body = String(req.body?.body || '').trim()
  if (!body) throw new HttpError(400, 'Body required', 'A reply requires a body')

  const conversation: any = await Conversation.findOne({ _id: conversationId, organizationId }).lean()
  if (!conversation) throw new HttpError(404, 'Conversation not found', 'No conversation with that identifier exists in this organisation')

  const contact: any = await Contact.findOne({ _id: conversation.contactId, organizationId }).select('email phone firstName lastName name').lean()
  if (!contact) throw new HttpError(404, 'Contact not found', 'The contact this conversation belongs to no longer exists')

  const recipient = String((channel === 'email' ? contact.email : contact.phone) || '')
  if (!recipient) throw new HttpError(409, 'No address', `This contact has no ${channel} address`, problemType('inbox-no-address'))

  // Suppression applies to a human reply exactly as it does to an automated
  // send. A person who unsubscribed has not consented to be messaged because
  // an operator typed it by hand rather than a scheduler sending it.
  try {
    await assertNotSuppressed({ organizationId, channel: channel as 'email' | 'sms', address: recipient })
  } catch (error) {
    if (error instanceof SuppressedRecipientError) {
      throw new HttpError(409, 'Recipient is suppressed', `This contact is on the ${channel} suppression list (${error.reason}) and cannot be messaged`, problemType('recipient-suppressed'))
    }
    throw error
  }

  const now = new Date()
  const created: any = await Message.create({
    organizationId, conversationId, contactId: conversation.contactId,
    direction: 'outbound', channel,
    preview: previewOf(body), status: 'queued',
    authorUserId: req.auth?.userId, occurredAt: now,
  })
  const messageId = String(created._id)
  await Message.updateOne({ _id: messageId, organizationId }, {
    $set: {
      bodyCiphertext: encryptString(body, messageAad(organizationId, messageId, 'body')),
      ...(req.body?.subject ? { subjectCiphertext: encryptString(String(req.body.subject).slice(0, 998), messageAad(organizationId, messageId, 'subject')) } : {}),
    },
  })

  try {
    const result = await providerChannelDispatcher.send({
      organizationId,
      channel: channel as 'email' | 'sms',
      step: {
        stepIndex: 0, channel: channel as 'email' | 'sms', wait: { kind: 'immediate' },
        messagingIdentityId: null, bodyTemplate: body,
        subjectTemplate: req.body?.subject ? String(req.body.subject).slice(0, 998) : 'Re: your enquiry',
      },
      contact: { id: String(contact._id), email: contact.email, phone: contact.phone, firstName: contact.firstName, lastName: contact.lastName, name: contact.name, fields: {} },
      recipient,
      enrolmentId: '',
      stepIndex: 0,
      sendRecordId: messageId,
      trackingToken: '',
    })
    await Message.updateOne({ _id: messageId, organizationId }, { $set: { status: 'sent', provider: result.provider, providerMessageId: result.providerMessageId || null } })
    await Conversation.updateOne({ _id: conversationId, organizationId }, {
      $set: { lastMessageAt: now, lastOutboundAt: now, lastMessagePreview: previewOf(body), lastMessageDirection: 'outbound' },
      $addToSet: { channels: channel },
    })
    await recordActivity({
      organizationId, contactId: String(conversation.contactId), type: 'message.sent',
      summary: `Reply sent on ${channel}`, entityType: 'Message', entityId: messageId,
      metadata: { channel }, actorUserId: req.auth?.userId, occurredAt: now,
    })
    res.status(201).json({ id: messageId, status: 'sent' })
  } catch (error: any) {
    await Message.updateOne({ _id: messageId, organizationId }, { $set: { status: 'failed' } })
    throw new HttpError(502, 'Reply could not be sent', String(error?.message || 'The provider rejected the message'), problemType('inbox-send-failed'))
  }
}))

router.post('/conversations/:conversationId/status', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const conversationId = objectId(req.params.conversationId, 'conversation')
  const status = String(req.body?.status || '')
  if (!['open', 'snoozed', 'closed'].includes(status)) throw new HttpError(400, 'Invalid status', 'Status must be open, snoozed or closed')

  const update: Record<string, unknown> = { status }
  if (status === 'snoozed') {
    const until = new Date(String(req.body?.snoozedUntil || ''))
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      throw new HttpError(400, 'Invalid snooze', 'snoozedUntil must be a future date')
    }
    update.snoozedUntil = until
  } else {
    update.snoozedUntil = null
  }
  if (req.body?.assigneeUserId !== undefined) update.assigneeUserId = req.body.assigneeUserId ? String(req.body.assigneeUserId).slice(0, 64) : null

  const result = await Conversation.updateOne({ _id: conversationId, organizationId }, { $set: update })
  if (!Number((result as any).matchedCount || 0)) throw new HttpError(404, 'Conversation not found', 'No conversation with that identifier exists in this organisation')
  res.json({ id: conversationId, status })
}))

/* --------------------------------------------------------- industry snapshots */

router.get('/snapshots', asyncHandler(async (_req, res) => {
  res.json({ snapshots: listSnapshots() })
}))

router.post('/snapshots/:snapshotId/apply', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const snapshotId = String(req.params.snapshotId || '').slice(0, 64)
  const result = await applySnapshot({ organizationId, snapshotId, userId: req.auth?.userId })
  // Skipped items are returned explicitly. Applying a snapshot never overwrites
  // an operator's existing work, and they should be able to see what it left
  // alone rather than assuming everything was created.
  res.status(201).json(result)
}))

export default router
