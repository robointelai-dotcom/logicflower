import crypto from 'crypto'
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { Types } from 'mongoose'
import Organization from '../models/Organization'
import Review from '../models/Review'
import ReviewWidget from '../models/ReviewWidget'
import ScheduledPost from '../models/ScheduledPost'
import SocialAccount from '../models/SocialAccount'
import SocialPost from '../models/SocialPost'
import { env } from '../env'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor'
import { requireOrganizationId } from '../types/authenticatedRequest'
import { recordAudit } from '../services/audit'
import { recordActivity } from '../services/crm/contactActivity'
import { ComposerError, publishReadiness, validateComposedPost } from '../services/social/composer'
import { listPlatformProfiles, platformProfile, type SocialPlatform } from '../services/social/platforms'
import { computeVariants, suggestedRatios, type AspectRatioName } from '../services/social/mediaVariants'
import { sendReviewRequest, submitReview, widgetPayload } from '../services/reviews/reviewEngine'
import { trypostConfigured } from '../services/social/trypostClient'
import { storeWorkspaceKey, syncSocialAccounts } from '../services/social/trypostPublisher'
import { renderWidgetHtml, safeAccentColor, widgetScript } from '../services/reviews/reviewWidget'

const router = Router()

/**
 * Public review surface: the widget and the submission page.
 *
 * Unauthenticated by necessity — a widget renders on a customer's website and a
 * reviewer has no session. Rate limited, scoped to one organisation by an
 * unguessable key, and exposing nothing beyond published reviews.
 */
export const publicReviewRouter = Router()

const widgetLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false })
const submissionLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false })

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

/* ------------------------------------------------------------------- social */

/**
 * Platform capabilities.
 *
 * Deliberately the first thing a client should call. Every platform currently
 * reports `unimplemented` with the approval outstanding and the documentation
 * needed, so a UI can say "connect and schedule now, publishing enabled once
 * approved" rather than presenting a button that will fail.
 */
router.get('/platforms', asyncHandler(async (_req, res) => {
  const backendConfigured = trypostConfigured()
  res.json({
    platforms: listPlatformProfiles(),
    backend: {
      configured: backendConfigured,
      provider: backendConfigured ? 'trypost' : null,
      // A configured backend is evidence that publishing is POSSIBLE, not that
      // it works. The backend uses the operator's own approved apps, so app
      // review remains the binding constraint and no platform is reported as
      // available without a live probe.
      note: backendConfigured
        ? 'A publishing backend is configured. Platforms remain unverified until a live probe confirms a connected, approved account — the backend uses your own platform apps, so app review is still required.'
        : 'No publishing backend is configured. Posts can be composed and scheduled; they will not publish.',
    },
  })
}))

/**
 * Link an organisation to its workspace in the publishing backend.
 *
 * The workspace itself is created by an operator inside the backend — it has no
 * admin API for workspace creation — and the resulting key is recorded here.
 * That manual step is surfaced rather than hidden: pretending it is automatic
 * would leave an operator wondering why onboarding produced no workspace.
 */
router.post('/backend/workspace', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const apiKey = String(req.body?.apiKey || '').trim()
  if (!apiKey) throw new HttpError(400, 'API key required', 'A workspace API key from the publishing backend is required')
  await storeWorkspaceKey({ organizationId, apiKey, workspaceLabel: req.body?.workspaceLabel, userId: req.auth?.userId })
  const synced = await syncSocialAccounts(organizationId)
  res.status(201).json({ linked: true, ...synced })
}))

router.post('/backend/sync', asyncHandler(async (req, res) => {
  requireOperator(req)
  res.json(await syncSocialAccounts(requireOrganizationId(req)))
}))

router.get('/accounts', asyncHandler(async (req, res) => {
  const rows: any[] = await SocialAccount.find({ organizationId: requireOrganizationId(req) }).limit(100).lean()
  res.json({
    accounts: rows.map((row) => ({
      id: String(row._id),
      platform: row.platform,
      displayName: row.displayName,
      status: row.status,
      // Never the platform profile's optimistic view — the account's own
      // recorded state, which starts at unimplemented.
      publishState: row.publishState,
      grantedScopes: row.grantedScopes || [],
      lastProbeAt: row.lastProbeAt,
    })),
  })
}))

router.post('/accounts', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const platform = String(req.body?.platform || '') as SocialPlatform
  let profile
  try { profile = platformProfile(platform) } catch {
    throw new HttpError(400, 'Unknown platform', `"${platform}" is not a supported platform`, problemType('social-platform-unknown'))
  }
  const externalAccountId = String(req.body?.externalAccountId || '').trim().slice(0, 200)
  const displayName = String(req.body?.displayName || '').trim().slice(0, 200)
  if (!externalAccountId || !displayName) throw new HttpError(400, 'Account details required', 'An external account id and display name are required')

  try {
    const created: any = await SocialAccount.create({
      organizationId, platform, externalAccountId, displayName,
      // Never seeded from a request. A connection is not a capability.
      publishState: 'unimplemented',
      createdBy: req.auth?.userId,
    })
    await recordAudit({ req, organizationId, action: 'social.account_connected', entityType: 'SocialAccount', entityId: String(created._id), metadata: { platform } })
    res.status(201).json({
      id: String(created._id),
      platform,
      publishState: 'unimplemented',
      approvalRequired: profile.approvalRequired,
      documentationNeeded: profile.documentationNeeded,
    })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Account already connected', 'That account is already connected to this organisation', problemType('social-account-duplicate'))
    throw error
  }
}))

/** Media variant geometry for an uploaded image. Computation only, no processing. */
router.post('/media/variants', asyncHandler(async (req, res) => {
  const width = Number(req.body?.width)
  const height = Number(req.body?.height)
  const platform = req.body?.platform ? String(req.body.platform) : undefined
  const fit = req.body?.fit === 'contain' ? 'contain' : 'cover'
  const ratios = (Array.isArray(req.body?.ratios) && req.body.ratios.length
    ? req.body.ratios
    : platform ? suggestedRatios(platform) : undefined) as AspectRatioName[] | undefined

  try {
    res.json({ variants: computeVariants({ width, height }, ratios, fit) })
  } catch (error: any) {
    throw new HttpError(400, 'Invalid media', String(error?.message || 'Media dimensions are invalid'), problemType('media-invalid'))
  }
}))

router.get('/posts', asyncHandler(async (req, res) => {
  const query: any = { organizationId: requireOrganizationId(req) }
  if (req.query.status) query.status = String(req.query.status).slice(0, 24)
  if (req.query.from || req.query.to) {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(0)
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 365 * 86_400_000)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new HttpError(400, 'Invalid range', 'from and to must be valid dates')
    query.scheduledFor = { $gte: from, $lte: to }
  }
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) query._id = { $lt: cursor }

  const rows: any[] = await SocialPost.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    posts: rows.slice(0, limit).map((row) => ({
      id: String(row._id),
      caption: row.caption,
      status: row.status,
      scheduledFor: row.scheduledFor,
      timeZone: row.timeZone,
      mediaCount: (row.mediaArtifactIds || []).length,
      targets: (row.targets || []).map((target: any) => ({
        platform: target.platform,
        socialAccountId: String(target.socialAccountId),
        status: target.status,
        blockedReason: target.blockedReason,
        externalPostUrl: target.externalPostUrl,
      })),
    })),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

router.post('/posts', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)

  const targets = Array.isArray(req.body?.targets) ? req.body.targets : []
  const accountIds = targets.map((target: any) => String(target?.socialAccountId || '')).filter(Boolean)
  const accounts: any[] = accountIds.length
    ? await SocialAccount.find({ organizationId, _id: { $in: accountIds } }).select('_id platform').lean()
    : []
  const accountsById = new Map(accounts.map((account) => [String(account._id), account]))
  if (accounts.length !== new Set(accountIds).size) {
    throw new HttpError(404, 'Account not found', 'One or more target accounts do not exist in this organisation', problemType('social-account-not-found'))
  }

  let composed
  try {
    composed = validateComposedPost({
      caption: String(req.body?.caption ?? ''),
      mediaCount: Array.isArray(req.body?.mediaArtifactIds) ? req.body.mediaArtifactIds.length : 0,
      // The platform is taken from the stored account, never from the request:
      // a caller could otherwise claim a permissive platform's limits while
      // targeting a stricter one.
      targets: targets.map((target: any) => ({
        socialAccountId: String(target.socialAccountId),
        platform: accountsById.get(String(target.socialAccountId))?.platform,
        captionOverride: target.captionOverride ?? null,
      })),
      scheduledFor: req.body?.scheduledFor ?? null,
      timeZone: req.body?.timeZone,
    })
  } catch (error) {
    if (error instanceof ComposerError) throw new HttpError(400, 'Post is invalid', error.issues.join('; '), problemType('social-post-invalid'))
    throw error
  }

  const readiness = publishReadiness(composed.targets)
  const created: any = await SocialPost.create({
    organizationId,
    caption: composed.caption,
    mediaArtifactIds: (req.body?.mediaArtifactIds || []).map((id: unknown) => objectId(id, 'artifact')),
    targets: composed.targets.map((target) => {
      const ready = readiness.find((entry) => entry.socialAccountId === target.socialAccountId)
      return {
        socialAccountId: target.socialAccountId,
        platform: target.platform,
        captionOverride: target.captionOverride,
        // Marked blocked at composition, not discovered at publish time.
        status: ready?.willPublish ? 'pending' : 'blocked',
        blockedReason: ready?.willPublish ? undefined : ready?.blockedReason,
      }
    }),
    status: composed.scheduledFor ? 'scheduled' : 'draft',
    scheduledFor: composed.scheduledFor,
    timeZone: composed.timeZone,
    createdBy: req.auth?.userId,
  })

  if (composed.scheduledFor) {
    // Durable, in MongoDB, for the same reason sequence steps are: a content
    // calendar planned a month out must not evaporate with a Redis restart.
    await ScheduledPost.updateOne(
      { organizationId, socialPostId: created._id },
      { $setOnInsert: { organizationId, socialPostId: created._id, dueAt: composed.scheduledFor, status: 'pending' } },
      { upsert: true },
    )
  }

  await recordAudit({ req, organizationId, action: 'social.post_created', entityType: 'SocialPost', entityId: String(created._id), metadata: { targets: composed.targets.length, scheduled: Boolean(composed.scheduledFor) } })
  res.status(201).json({
    id: String(created._id),
    status: created.status,
    readiness,
    // Stated on every create rather than buried in documentation.
    note: readiness.every((entry) => entry.willPublish)
      ? undefined
      : 'This post is scheduled but will not publish: no platform integration is available in this build.',
  })
}))

/* ------------------------------------------------------------------ reviews */

router.post('/reviews/requests', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const channel = String(req.body?.channel || 'email')
  if (!['email', 'sms'].includes(channel)) throw new HttpError(400, 'Invalid channel', 'Channel must be email or sms')

  const result = await sendReviewRequest({
    organizationId,
    contactId: objectId(req.body?.contactId, 'contact'),
    dealId: req.body?.dealId ? objectId(req.body.dealId, 'deal') : null,
    channel: channel as 'email' | 'sms',
    source: 'manual',
    messageTemplate: req.body?.messageTemplate ? String(req.body.messageTemplate).slice(0, 2_000) : undefined,
    quietHours: req.body?.quietHours,
    userId: req.auth?.userId,
  })
  res.status(result.sent ? 201 : 200).json(result)
}))

router.get('/reviews', asyncHandler(async (req, res) => {
  const query: any = { organizationId: requireOrganizationId(req) }
  if (req.query.publishState) query.publishState = String(req.query.publishState).slice(0, 16)
  if (req.query.minimumRating) query.rating = { $gte: Number(req.query.minimumRating) }
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) query._id = { $lt: cursor }

  const rows: any[] = await Review.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    reviews: rows.slice(0, limit).map((row) => ({
      id: String(row._id),
      rating: row.rating,
      body: row.body,
      authorName: row.authorName,
      source: row.source,
      publishState: row.publishState,
      contactId: row.contactId ? String(row.contactId) : null,
      submittedAt: row.submittedAt,
      reply: row.reply?.body ? { body: row.reply.body, repliedAt: row.reply.repliedAt } : null,
    })),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

/**
 * Moderation.
 *
 * Publishing is an explicit act, and it is audited. A review on the public
 * widget is world-readable and effectively permanent, so "who made this public"
 * needs an answer.
 */
router.post('/reviews/:reviewId/publish-state', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const reviewId = objectId(req.params.reviewId, 'review')
  const publishState = String(req.body?.publishState || '')
  if (!['pending', 'published', 'hidden'].includes(publishState)) {
    throw new HttpError(400, 'Invalid state', 'publishState must be pending, published or hidden')
  }

  const review: any = await Review.findOne({ _id: reviewId, organizationId }).lean()
  if (!review) throw new HttpError(404, 'Review not found', 'No review with that identifier exists in this organisation')

  await Review.updateOne({ _id: reviewId, organizationId }, {
    $set: {
      publishState,
      publishedAt: publishState === 'published' ? new Date() : null,
      moderatedBy: String(req.auth?.userId || ''),
    },
  })
  if (publishState === 'published' && review.contactId) {
    await recordActivity({
      organizationId, contactId: String(review.contactId), type: 'review.published',
      summary: `Review published (${review.rating} of 5)`, entityType: 'Review', entityId: reviewId,
      actorUserId: req.auth?.userId,
    })
  }
  await recordAudit({ req, organizationId, action: 'review.publish_state_changed', entityType: 'Review', entityId: reviewId, metadata: { from: review.publishState, to: publishState, rating: review.rating } })
  res.json({ id: reviewId, publishState })
}))

/**
 * Reply to a review.
 *
 * The reply is published with the review, not separately: a reply attached to a
 * review nobody can see helps nobody, and a reply that appears before its
 * review has been approved would leak the review's existence.
 *
 * Editable, because a reply written in irritation on a Friday is exactly the
 * thing an operator wants to soften on Monday, and a public apology with a typo
 * in it is worse than no reply. Each edit is audited.
 */
router.post('/reviews/:reviewId/reply', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const reviewId = objectId(req.params.reviewId, 'review')
  const body = String(req.body?.body ?? '').trim()

  const review: any = await Review.findOne({ _id: reviewId, organizationId }).select('reply publishState rating contactId source').lean()
  if (!review) throw new HttpError(404, 'Review not found', 'No review with that identifier exists in this organisation')

  if (review.source !== 'first_party') {
    // Replying to a Google or Facebook review has to happen through that
    // platform's own API, and writing the text here would produce a reply the
    // reviewer never sees while making it look answered.
    throw new HttpError(
      409,
      'Reply must be posted on the original platform',
      `This review came from ${review.source}. A reply stored here would not reach the reviewer. Reply on that platform directly.`,
      problemType('review-reply-external'),
    )
  }

  if (!body) {
    // An empty body removes the reply rather than storing a blank one.
    await Review.updateOne({ _id: reviewId, organizationId }, { $unset: { reply: 1 } })
    await recordAudit({ req, organizationId, action: 'review.reply_removed', entityType: 'Review', entityId: reviewId })
    return res.json({ id: reviewId, reply: null })
  }
  if (body.length > 2_000) throw new HttpError(400, 'Reply too long', 'A reply cannot exceed 2000 characters')

  const existing = Boolean(review.reply?.body)
  const now = new Date()
  await Review.updateOne({ _id: reviewId, organizationId }, {
    $set: {
      reply: {
        body,
        // The original timestamp is kept on an edit, because when the business
        // first responded is the fact a reader cares about.
        repliedAt: review.reply?.repliedAt ?? now,
        repliedBy: String(req.auth?.userId || ''),
      },
    },
  })

  if (review.contactId) {
    await recordActivity({
      organizationId, contactId: String(review.contactId), type: 'review.replied',
      summary: existing ? 'Review reply edited' : 'Replied to review',
      entityType: 'Review', entityId: reviewId,
      metadata: { rating: review.rating }, actorUserId: req.auth?.userId,
    })
  }
  await recordAudit({
    req, organizationId, action: existing ? 'review.reply_edited' : 'review.reply_added',
    entityType: 'Review', entityId: reviewId, metadata: { rating: review.rating, published: review.publishState === 'published' },
  })

  res.status(existing ? 200 : 201).json({
    id: reviewId,
    reply: { body, repliedAt: review.reply?.repliedAt ?? now },
    // Stated plainly: a reply on an unapproved review is not yet visible.
    visible: review.publishState === 'published',
  })
}))

router.post('/reviews/widgets', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const name = String(req.body?.name || '').trim().slice(0, 120)
  if (!name) throw new HttpError(400, 'Name required', 'A widget name is required')
  const layout = String(req.body?.layout || 'carousel')
  if (!['carousel', 'grid', 'list', 'badge'].includes(layout)) throw new HttpError(400, 'Invalid layout', 'Layout must be carousel, grid, list or badge')

  try {
    const created: any = await ReviewWidget.create({
      organizationId,
      name,
      publicKey: crypto.randomBytes(18).toString('base64url'),
      layout,
      minimumRating: Math.max(1, Math.min(5, Number(req.body?.minimumRating ?? 4))),
      maximumReviews: Math.max(1, Math.min(50, Number(req.body?.maximumReviews ?? 12))),
      showAggregateRating: req.body?.showAggregateRating !== false,
      theme: {
        accentColor: safeAccentColor(req.body?.theme?.accentColor),
        darkMode: Boolean(req.body?.theme?.darkMode),
      },
      allowedOrigins: Array.isArray(req.body?.allowedOrigins) ? req.body.allowedOrigins.map((origin: unknown) => String(origin).slice(0, 200)).slice(0, 20) : [],
      createdBy: req.auth?.userId,
    })
    res.status(201).json({
      id: String(created._id),
      publicKey: created.publicKey,
      embedSnippet: `<div data-lf-rw></div>\n<script src="${env.API_URL}/api/v1/public/reviews/widget/${created.publicKey}/embed.js" async></script>`,
    })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Widget already exists', 'A widget with that name already exists', problemType('review-widget-duplicate'))
    throw error
  }
}))

/* ------------------------------------------------------------ public review */

/** The submission page target. Identified only by an unguessable token. */
publicReviewRouter.post('/submit', submissionLimiter, asyncHandler(async (req, res) => {
  const result = await submitReview({
    token: String(req.body?.t ?? req.query.t ?? ''),
    rating: Number(req.body?.rating),
    body: req.body?.body ? String(req.body.body) : undefined,
    authorName: req.body?.authorName ? String(req.body.authorName) : undefined,
  })
  // The same response whether the token was invalid, used or expired, so this
  // cannot be used to probe which tokens are live.
  res.status(result.accepted ? 201 : 200).json({ received: true })
}))

async function widgetByKey(publicKey: string) {
  // tenant-safe: public endpoint; the unguessable widget key is the identifier and the organisation is derived from the matched widget
  const widget: any = await ReviewWidget.findOne({ publicKey: String(publicKey || '').slice(0, 64), status: 'active' }).lean()
  return widget || null
}

publicReviewRouter.get('/widget/:publicKey', widgetLimiter, asyncHandler(async (req, res) => {
  const widget = await widgetByKey(String(req.params.publicKey || ""))
  if (!widget) throw new HttpError(404, 'Widget not found', 'No active widget matches this key', problemType('review-widget-not-found'))

  const origin = String(req.headers.origin || '')
  if ((widget.allowedOrigins || []).length && origin && !widget.allowedOrigins.includes(origin)) {
    throw new HttpError(403, 'Origin rejected', 'This widget does not accept requests from that origin', problemType('review-widget-origin-rejected'))
  }

  const payload = await widgetPayload({
    organizationId: String(widget.organizationId),
    layout: widget.layout,
    minimumRating: Number(widget.minimumRating),
    maximumReviews: Number(widget.maximumReviews),
    showAggregateRating: Boolean(widget.showAggregateRating),
    theme: { accentColor: safeAccentColor(widget.theme?.accentColor), darkMode: Boolean(widget.theme?.darkMode) },
  })

  // A widget is embedded cross-origin by design, so this endpoint is the one
  // place a permissive CORS header is correct. It exposes only published
  // reviews and carries no credentials.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.json(payload)
}))

publicReviewRouter.get('/widget/:publicKey/embed.js', widgetLimiter, asyncHandler(async (req, res) => {
  const widget = await widgetByKey(String(req.params.publicKey || ""))
  if (!widget) throw new HttpError(404, 'Widget not found', 'No active widget matches this key', problemType('review-widget-not-found'))

  const organization: any = await Organization.findOne({ _id: widget.organizationId }).select('name').lean()
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.type('application/javascript').send(widgetScript({
    publicKey: String(widget.publicKey),
    apiBaseUrl: env.API_URL,
    businessName: String(organization?.name || 'This business'),
  }))
}))

/** Server-rendered variant, for hosts that will not run a script. */
publicReviewRouter.get('/widget/:publicKey/embed.html', widgetLimiter, asyncHandler(async (req, res) => {
  const widget = await widgetByKey(String(req.params.publicKey || ""))
  if (!widget) throw new HttpError(404, 'Widget not found', 'No active widget matches this key', problemType('review-widget-not-found'))

  const [organization, payload] = await Promise.all([
    Organization.findOne({ _id: widget.organizationId }).select('name').lean(),
    widgetPayload({
      organizationId: String(widget.organizationId),
      layout: widget.layout,
      minimumRating: Number(widget.minimumRating),
      maximumReviews: Number(widget.maximumReviews),
      showAggregateRating: Boolean(widget.showAggregateRating),
      theme: { accentColor: safeAccentColor(widget.theme?.accentColor), darkMode: Boolean(widget.theme?.darkMode) },
    }),
  ])
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.type('html').send(renderWidgetHtml({ businessName: String((organization as any)?.name || 'This business'), payload }))
}))

export default router
