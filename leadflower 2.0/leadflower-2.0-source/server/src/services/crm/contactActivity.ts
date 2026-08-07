import Contact from '../../models/Contact'
import ContactActivity from '../../models/ContactActivity'
import pino from '../../logger'

/**
 * The contact timeline.
 *
 * Written alongside the operation it describes rather than derived at read
 * time. Deriving it means querying six collections and merge-sorting them, a
 * query that gets slower every month and cannot be paginated coherently.
 *
 * Two rules:
 *
 *  - Never carries message bodies or any address. Content stays on the record
 *    that owns it; duplicating it here would double the redaction and retention
 *    surface for no gain, and the timeline is the surface most likely to be
 *    rendered somewhere unescaped.
 *
 *  - Never throws into its caller. A timeline entry failing to write must not
 *    roll back the send, stage change or payment it describes. The operation is
 *    the truth; the timeline is a record of it, and a missing line is a
 *    reporting gap rather than a correctness one.
 */

export type ActivityType =
  | 'contact.created' | 'contact.updated' | 'contact.merged'
  | 'message.sent' | 'message.delivered' | 'message.bounced' | 'message.suppressed' | 'message.received'
  | 'call.missed' | 'call.blocked' | 'call.placed' | 'call.completed'
  | 'sequence.enrolled' | 'sequence.exited' | 'sequence.completed'
  | 'deal.created' | 'deal.stage_changed' | 'deal.won' | 'deal.lost' | 'deal.deleted'
  | 'contact.archived' | 'contact.restored'
  | 'note.added' | 'form.submitted' | 'payment.link_created' | 'payment.received'
  | 'task.created' | 'task.completed'
  | 'appointment.booked' | 'appointment.cancelled' | 'appointment.completed'
  | 'contact.location_updated'
  | 'review.requested' | 'review.submitted' | 'review.published' | 'review.replied'
  | 'social.published'
  | 'tag.added' | 'tag.removed' | 'company.linked'

export interface ActivityInput {
  organizationId: string
  contactId: string
  type: ActivityType
  summary: string
  entityType?: string
  entityId?: string | null
  metadata?: Record<string, unknown>
  actorUserId?: string
  occurredAt?: Date
}

/** Metadata keys that must never reach the timeline. */
const FORBIDDEN_METADATA_KEYS = new Set([
  'email', 'phone', 'address', 'body', 'bodyTemplate', 'subject', 'subjectTemplate',
  'password', 'token', 'trackingToken', 'credentials', 'apiKey', 'authToken',
])

function safeMetadata(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input || {})) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) continue
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue
    if (value === undefined || value === null) continue
    // Scalars only. A nested object here is how a whole message payload ends up
    // on the timeline by accident.
    if (typeof value === 'object' && !(value instanceof Date)) continue
    output[key] = typeof value === 'string' ? value.slice(0, 500) : value
  }
  return output
}

export async function recordActivity(input: ActivityInput): Promise<void> {
  try {
    const occurredAt = input.occurredAt ?? new Date()
    await ContactActivity.create({
      organizationId: input.organizationId,
      contactId: input.contactId,
      type: input.type,
      summary: String(input.summary).slice(0, 500),
      entityType: input.entityType,
      entityId: input.entityId || null,
      metadata: safeMetadata(input.metadata),
      actorUserId: input.actorUserId,
      occurredAt,
    })
    await Contact.updateOne(
      { _id: input.contactId, organizationId: input.organizationId },
      { $set: { lastActivityAt: occurredAt } },
    )
  } catch (error) {
    pino.warn({ err: error, organizationId: input.organizationId, contactId: input.contactId, type: input.type }, 'contact activity write failed')
  }
}

export interface TimelineEntry {
  id: string
  type: string
  summary: string
  entityType?: string
  entityId?: string | null
  metadata: Record<string, unknown>
  occurredAt: Date
}

export async function contactTimeline(input: {
  organizationId: string
  contactId: string
  limit?: number
  before?: Date
}): Promise<TimelineEntry[]> {
  const query: Record<string, unknown> = {
    organizationId: input.organizationId,
    contactId: input.contactId,
    ...(input.before ? { occurredAt: { $lt: input.before } } : {}),
  }
  const rows: any[] = await ContactActivity.find(query)
    .sort({ occurredAt: -1 })
    .limit(Math.max(1, Math.min(input.limit ?? 50, 200)))
    .lean()
  return rows.map((row) => ({
    id: String(row._id),
    type: row.type,
    summary: row.summary,
    entityType: row.entityType,
    entityId: row.entityId ? String(row.entityId) : null,
    metadata: row.metadata || {},
    occurredAt: row.occurredAt,
  }))
}
