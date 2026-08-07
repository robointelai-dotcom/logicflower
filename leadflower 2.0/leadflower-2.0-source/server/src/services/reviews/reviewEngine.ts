import crypto from 'crypto'
import Contact from '../../models/Contact'
import Review from '../../models/Review'
import ReviewRequest from '../../models/ReviewRequest'
import { env } from '../../env'
import { HttpError, problemType } from '../../http/problem'
import { recordAudit } from '../audit'
import { recordActivity } from '../crm/contactActivity'
import { providerChannelDispatcher } from '../sequences/channels'
import { assertNotSuppressed, SuppressedRecipientError } from '../sequences/suppression'
import { deferForQuietHours, isWithinQuietHours, normaliseTimeZone } from '../sequences/scheduleArithmetic'

/**
 * The review engine.
 *
 * Unlike social publishing, this is fully implemented — because it sends
 * through the operator's own email and SMS providers, which Phase 1 already
 * built and which need no platform's approval.
 *
 * Two constraints shape it, and both exist to stop a review programme becoming
 * the thing that makes customers mute a business:
 *
 *  - **One outstanding request per contact**, enforced by a partial unique
 *    index. A customer with three completed jobs gets one ask, not three.
 *
 *  - **Suppression and quiet hours apply.** A review request is marketing. It
 *    is not exempt because it is polite.
 */

const REQUEST_EXPIRY_DAYS = 30

export interface SendReviewRequestResult {
  sent: boolean
  requestId?: string
  reason?: 'already_requested' | 'suppressed' | 'no_address' | 'quiet_hours' | 'send_failed' | 'contact_not_found'
  retryAt?: Date
}

export function reviewSubmissionUrl(token: string): string {
  const url = new URL('/api/v1/public/reviews/submit', env.API_URL)
  url.searchParams.set('t', token)
  return url.toString()
}

/**
 * Ask one contact for a review.
 *
 * Called from a pipeline stage change (job completion) or manually. Idempotent
 * per contact while a request is outstanding: a stage change that fires twice
 * produces one ask.
 */
export async function sendReviewRequest(input: {
  organizationId: string
  contactId: string
  dealId?: string | null
  channel: 'email' | 'sms'
  source?: string
  messageTemplate?: string
  quietHours?: { enabled: boolean; startMinute: number; endMinute: number }
  userId?: string
  now?: Date
}): Promise<SendReviewRequestResult> {
  const now = input.now ?? new Date()

  const contact: any = await Contact.findOne({ _id: input.contactId, organizationId: input.organizationId })
    .select('email phone firstName lastName name timezone').lean()
  if (!contact) return { sent: false, reason: 'contact_not_found' }

  const recipient = String((input.channel === 'email' ? contact.email : contact.phone) || '').trim()
  if (!recipient) return { sent: false, reason: 'no_address' }

  // A review request is marketing and is not exempt from suppression because it
  // is polite.
  try {
    await assertNotSuppressed({ organizationId: input.organizationId, channel: input.channel, address: recipient })
  } catch (error) {
    if (error instanceof SuppressedRecipientError) return { sent: false, reason: 'suppressed' }
    throw error
  }

  const timeZone = normaliseTimeZone(contact.timezone || 'UTC')
  if (input.quietHours?.enabled && isWithinQuietHours(now, input.quietHours, timeZone)) {
    // Deferred rather than skipped, unlike missed-call text back: a review
    // request is not time-critical and reads perfectly well the next morning.
    return { sent: false, reason: 'quiet_hours', retryAt: deferForQuietHours(now, input.quietHours, timeZone) }
  }

  const token = crypto.randomBytes(24).toString('base64url')
  let requestId: string
  try {
    const created: any = await ReviewRequest.create({
      organizationId: input.organizationId,
      contactId: input.contactId,
      dealId: input.dealId || null,
      channel: input.channel,
      token,
      status: 'pending',
      expiresAt: new Date(now.getTime() + REQUEST_EXPIRY_DAYS * 86_400_000),
      source: input.source || 'manual',
    })
    requestId = String(created._id)
  } catch (error: any) {
    // The anti-nagging guard. A duplicate means a request is already
    // outstanding for this contact.
    if (Number(error?.code) === 11_000) return { sent: false, reason: 'already_requested' }
    throw error
  }

  const firstName = String(contact.firstName || '').trim()
  const submissionUrl = reviewSubmissionUrl(token)
  const body = (input.messageTemplate
    || 'Hi {{contact.firstName}}, thanks for choosing us. If you have a moment, we would really appreciate a quick review: {{reviewUrl}}')
    .replace(/\{\{\s*contact\.firstName\s*\}\}/g, firstName)
    .replace(/\{\{\s*reviewUrl\s*\}\}/g, submissionUrl)

  try {
    await providerChannelDispatcher.send({
      organizationId: input.organizationId,
      channel: input.channel,
      step: {
        stepIndex: 0,
        channel: input.channel,
        wait: { kind: 'immediate' },
        messagingIdentityId: null,
        bodyTemplate: body,
        subjectTemplate: 'How did we do?',
      },
      contact: { id: String(contact._id), email: contact.email, phone: contact.phone, firstName: contact.firstName, lastName: contact.lastName, name: contact.name, fields: {} },
      recipient,
      enrolmentId: '',
      stepIndex: 0,
      sendRecordId: requestId,
      trackingToken: token,
    })
    await ReviewRequest.updateOne({ _id: requestId, organizationId: input.organizationId }, { $set: { status: 'sent', sentAt: now } })
    await recordActivity({
      organizationId: input.organizationId,
      contactId: input.contactId,
      type: 'review.requested',
      summary: `Review request sent by ${input.channel}`,
      entityType: 'ReviewRequest',
      entityId: requestId,
      metadata: { channel: input.channel, source: input.source || 'manual' },
      actorUserId: input.userId,
      occurredAt: now,
    })
    return { sent: true, requestId }
  } catch (error: any) {
    await ReviewRequest.updateOne(
      { _id: requestId, organizationId: input.organizationId },
      { $set: { status: 'failed', failureReason: String(error?.message || 'send failed').slice(0, 500) } },
    )
    return { sent: false, requestId, reason: 'send_failed' }
  }
}

/**
 * Record a submitted review.
 *
 * Never published automatically. The widget is unauthenticated and permanent,
 * so a review becomes world-readable only when a person decides it should —
 * which is also the only defence against a submission link being shared or
 * abused.
 */
export async function submitReview(input: {
  token: string
  rating: number
  body?: string
  authorName?: string
  now?: Date
}): Promise<{ accepted: boolean; reason?: string }> {
  const now = input.now ?? new Date()
  const rating = Number(input.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new HttpError(400, 'Invalid rating', 'A rating must be a whole number between 1 and 5', problemType('review-rating-invalid'))
  }

  // tenant-safe: public endpoint; the unguessable single-use token is the identifier and the organisation is derived from the matched request
  const request: any = await ReviewRequest.findOne({ token: String(input.token || '').slice(0, 128) })
    .select('_id organizationId contactId dealId status expiresAt').lean()
  // The same response for a missing, used or expired token: distinguishing them
  // turns this into an oracle for probing which tokens are live.
  if (!request) return { accepted: false, reason: 'invalid_or_used' }
  if (request.status === 'submitted') return { accepted: false, reason: 'invalid_or_used' }
  if (request.expiresAt && new Date(request.expiresAt).getTime() < now.getTime()) return { accepted: false, reason: 'invalid_or_used' }

  const organizationId = String(request.organizationId)
  const review: any = await Review.create({
    organizationId,
    contactId: request.contactId,
    dealId: request.dealId || null,
    rating,
    body: String(input.body || '').slice(0, 5_000),
    // Never an email address, and never the full name unless the reviewer gave
    // it: this string ends up on a public web page.
    authorName: String(input.authorName || 'Customer').slice(0, 80),
    source: 'first_party',
    publishState: 'pending',
    submittedAt: now,
  })

  await ReviewRequest.updateOne(
    { _id: request._id, organizationId },
    { $set: { status: 'submitted', submittedAt: now, reviewId: review._id } },
  )
  await recordActivity({
    organizationId,
    contactId: String(request.contactId),
    type: 'review.submitted',
    summary: `Review submitted (${rating} of 5)`,
    entityType: 'Review',
    entityId: String(review._id),
    metadata: { rating },
    occurredAt: now,
  })
  await recordAudit({
    organizationId,
    actorType: 'system',
    action: 'review.submitted',
    entityType: 'Review',
    entityId: String(review._id),
    metadata: { rating, source: 'first_party' },
  })
  return { accepted: true }
}

export interface PublicReview {
  id: string
  rating: number
  body: string
  authorName: string
  submittedAt: Date
  reply?: { body: string; repliedAt: Date }
}

export interface WidgetPayload {
  reviews: PublicReview[]
  aggregate: { ratingValue: number; reviewCount: number } | null
  layout: string
  theme: { accentColor: string; darkMode: boolean }
}

/**
 * Data for the public widget.
 *
 * Exposes published reviews and nothing else. Specifically absent: contact
 * identifiers, pending or hidden reviews, and any count of what was filtered
 * out — publishing "12 shown of 40" would disclose the ratio of reviews an
 * operator suppressed, which is exactly the information the widget must not
 * leak.
 *
 * The aggregate is computed over the SHOWN reviews only, so the star rating a
 * visitor sees is the average of the reviews they can read. An aggregate over
 * all reviews, displayed above a filtered list, would be a figure nobody can
 * verify and arguably a misleading one.
 */
export async function widgetPayload(widget: {
  organizationId: string
  layout: string
  minimumRating: number
  maximumReviews: number
  showAggregateRating: boolean
  theme: { accentColor: string; darkMode: boolean }
}): Promise<WidgetPayload> {
  const rows: any[] = await Review.find({
    organizationId: widget.organizationId,
    publishState: 'published',
    rating: { $gte: widget.minimumRating },
  })
    .sort({ submittedAt: -1 })
    .limit(Math.max(1, Math.min(widget.maximumReviews, 50)))
    .select('rating body authorName submittedAt reply')
    .lean()

  const reviews: PublicReview[] = rows.map((row) => ({
    id: String(row._id),
    rating: Number(row.rating),
    body: String(row.body || ''),
    authorName: String(row.authorName || 'Customer'),
    submittedAt: row.submittedAt,
    ...(row.reply?.body ? { reply: { body: String(row.reply.body), repliedAt: row.reply.repliedAt } } : {}),
  }))

  const aggregate = widget.showAggregateRating && reviews.length
    ? {
      ratingValue: Math.round((reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length) * 10) / 10,
      reviewCount: reviews.length,
    }
    : null

  return { reviews, aggregate, layout: widget.layout, theme: widget.theme }
}
