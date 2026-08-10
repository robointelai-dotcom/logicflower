import { Router } from 'express'
import { Types } from 'mongoose'
import AnswerCapsule from '../models/AnswerCapsule'
import BusinessProfile from '../models/BusinessProfile'
import Contact from '../models/Contact'
import ContactActivity from '../models/ContactActivity'
import Deal from '../models/Deal'
import Message from '../models/Message'
import Review from '../models/Review'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { recordAudit } from '../services/audit'
import {
  BUSINESS_TYPES, buildBusinessGraph, checkCapsule, isKnownBusinessType,
} from '../services/content/entityGraph'
import { clusterQuestions } from '../services/visibility/questions'
import { attributionReport } from '../services/visibility/attribution'
import { briefFromWork, canPublishDraft, MAX_ARTICLES_PER_MONTH } from '../services/visibility/articleDrafts'
import BlogPost from '../models/BlogPost'
import SiteConnection from '../models/SiteConnection'
import SearchConsoleConnection from '../models/SearchConsoleConnection'
import { searchConsoleProvider, SearchConsoleNotConfiguredError } from '../services/visibility/searchConsole'
import { encryptString, decryptString } from '../security/encryption'
import crypto from 'crypto'

/**
 * "Getting found" — the customer's own visibility.
 *
 * SCOPE, AND WHY IT DIFFERS FROM THE BLOG
 *
 * `routes/content.ts` is gated on `platformRole` because there is exactly one
 * public marketing website and it belongs to the platform operator.
 *
 * This module is the opposite. Every client has their own business, their own
 * website and their own customers, so everything here is scoped to
 * `organizationId` and gated on the WORKSPACE role. Copying the corporate gate
 * from `content.ts` would lock the feature to platform administrators and it
 * would look like it worked until an agency's client tried to use it.
 */

const router = Router()

function objectId(value: unknown, label: string): string {
  const id = String(value || '')
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, `Invalid ${label}`, `${label} identifier is invalid`)
  return id
}

function requireOrganizationId(req: any): string {
  const organizationId = String(req.auth?.organizationId || '')
  if (!organizationId) throw new HttpError(403, 'No workspace', 'This request is not scoped to a workspace')
  return organizationId
}

/** Anybody who does the work. Read-only roles are refused. */
function requireOperator(req: any): void {
  if (!['owner', 'admin', 'operator'].includes(String(req.auth?.role || ''))) {
    throw new HttpError(403, 'Insufficient role', 'Owner, admin, or operator role is required')
  }
}

/* ------------------------------------------------------- 1. BUSINESS PROFILE */

router.get('/business-types', asyncHandler(async (_req, res) => {
  res.json({ types: BUSINESS_TYPES })
}))

router.get('/profile', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const profile: any = await BusinessProfile.findOne({ organizationId }).lean()

  // Published, moderated reviews only. Including hidden ones in the average
  // would be a false claim in structured data.
  const reviews: any[] = await Review.find({ organizationId, status: 'published' }).select('rating').lean()
  const aggregateRating = reviews.length
    ? {
      ratingValue: reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviews.length,
      reviewCount: reviews.length,
    }
    : undefined

  const capsules: any[] = await AnswerCapsule.find({ organizationId, status: 'published' })
    .select('question answer').limit(20).lean()

  res.json({
    profile: profile ? { ...profile, id: String(profile._id), _id: undefined } : null,
    // Shown to the operator as "what Google sees", so they can judge whether
    // the fields they filled in produced anything useful.
    preview: profile
      ? buildBusinessGraph({ ...profile, url: profile.website, aggregateRating, capsules })
      : null,
    aggregateRating,
  })
}))

router.put('/profile', asyncHandler(async (req: any, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)

  const update: Record<string, unknown> = { updatedBy: req.auth?.userId }
  for (const field of [
    'legalName', 'tradingName', 'addressLine1', 'addressLine2', 'city', 'region',
    'postalCode', 'country', 'telephone', 'email', 'website', 'priceRange',
  ] as const) {
    if (req.body?.[field] !== undefined) update[field] = String(req.body[field]).slice(0, 300)
  }
  for (const field of ['paymentAccepted', 'currenciesAccepted', 'languagesSpoken', 'serviceAreaPlaces', 'acceptedInsurance', 'services'] as const) {
    if (Array.isArray(req.body?.[field])) {
      update[field] = req.body[field].map((entry: unknown) => String(entry).slice(0, 120)).slice(0, 40)
    }
  }
  for (const field of ['latitude', 'longitude', 'serviceAreaRadiusKm', 'foundingYear'] as const) {
    if (req.body?.[field] !== undefined) update[field] = Number(req.body[field])
  }

  if (req.body?.businessType !== undefined) {
    const type = String(req.body.businessType)
    // Refused rather than silently downgraded to LocalBusiness: an operator who
    // picks a type should get that type or an explanation.
    if (!isKnownBusinessType(type)) {
      throw new HttpError(400, 'Unknown business type', 'That trade is not one we can describe to search engines yet', problemType('business-type-unknown'))
    }
    update.businessType = type
  }

  if (req.body?.serviceAreaKind !== undefined) {
    const kind = String(req.body.serviceAreaKind)
    if (!['radius', 'named', 'none'].includes(kind)) throw new HttpError(400, 'Invalid service area', 'Service area must be radius, named or none')
    update.serviceAreaKind = kind
  }

  if (Array.isArray(req.body?.openingHours)) {
    update.openingHours = req.body.openingHours.slice(0, 7).map((entry: any) => ({
      day: String(entry?.day || '').slice(0, 10),
      opens: String(entry?.opens || '').slice(0, 5),
      closes: String(entry?.closes || '').slice(0, 5),
      closed: Boolean(entry?.closed),
    }))
  }

  if (Array.isArray(req.body?.hoursExceptions)) {
    update.hoursExceptions = req.body.hoursExceptions.slice(0, 60).map((entry: any) => ({
      date: String(entry?.date || '').slice(0, 10),
      closed: Boolean(entry?.closed),
      opens: String(entry?.opens || '').slice(0, 5),
      closes: String(entry?.closes || '').slice(0, 5),
      note: String(entry?.note || '').slice(0, 120),
    })).filter((entry: any) => entry.date)
  }

  if (Array.isArray(req.body?.credentials)) {
    /*
     * Only what the operator typed.
     *
     * A credential with no name is dropped rather than filled in. A fabricated
     * professional registration is a false statement about a regulated trade.
     */
    update.credentials = req.body.credentials.slice(0, 20)
      .map((credential: any) => ({
        name: String(credential?.name || '').slice(0, 200),
        issuedBy: String(credential?.issuedBy || '').slice(0, 200),
        identifier: String(credential?.identifier || '').slice(0, 120),
        url: String(credential?.url || '').slice(0, 400),
      }))
      .filter((credential: any) => credential.name.trim())
  }

  await BusinessProfile.updateOne({ organizationId }, { $set: update }, { upsert: true })
  await recordAudit({ req, organizationId, action: 'visibility.profile_updated', entityType: 'BusinessProfile', entityId: organizationId, metadata: { fields: Object.keys(update) } })
  res.json({ updated: Object.keys(update) })
}))

/* ------------------------------------------------------------ 5. QUESTIONS */

router.get('/questions', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const capsules: any[] = await AnswerCapsule.find({ organizationId, status: { $ne: 'dismissed' } })
    .sort({ status: 1, askedCount: -1 }).limit(100).lean()

  res.json({
    questions: capsules.map((capsule) => ({
      id: String(capsule._id),
      question: capsule.question,
      answer: capsule.answer,
      askedCount: capsule.askedCount,
      examples: capsule.examples,
      status: capsule.status,
      lastAskedAt: capsule.lastAskedAt,
    })),
  })
}))

/**
 * Look through recent inbound messages for questions asked more than once.
 *
 * This is the research step, and the reason it beats a keyword tool: these are
 * real people, in their own words, asking this specific business.
 */
router.post('/questions/scan', asyncHandler(async (req: any, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)

  const since = new Date(Date.now() - 180 * 86_400_000)
  const messages: any[] = await Message.find({ organizationId, direction: 'inbound', createdAt: { $gte: since } })
    .select('bodyPreview createdAt').sort({ createdAt: -1 }).limit(2_000).lean()

  const clusters = clusterQuestions(messages.map((message) => ({
    text: String(message.bodyPreview || ''),
    at: message.createdAt,
  })))

  let created = 0
  for (const cluster of clusters) {
    const existing = await AnswerCapsule.findOne({ organizationId, question: cluster.question })
    if (existing) {
      await AnswerCapsule.updateOne({ _id: existing._id }, {
        $set: { askedCount: cluster.count, lastAskedAt: cluster.lastAskedAt, examples: cluster.examples },
      })
      continue
    }
    await AnswerCapsule.create({
      organizationId,
      question: cluster.question,
      askedCount: cluster.count,
      lastAskedAt: cluster.lastAskedAt,
      examples: cluster.examples,
      status: 'suggested',
      createdBy: req.auth?.userId,
    })
    created += 1
  }

  res.json({ scanned: messages.length, clusters: clusters.length, created })
}))

router.patch('/questions/:questionId', asyncHandler(async (req: any, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const questionId = objectId(req.params.questionId, 'question')

  const update: Record<string, unknown> = { updatedBy: req.auth?.userId }
  if (req.body?.question !== undefined) update.question = String(req.body.question).slice(0, 300)

  if (req.body?.answer !== undefined) {
    const answer = String(req.body.answer).slice(0, 2_000)
    if (answer.trim()) {
      // The same validator the blog uses. One set of rules, not two.
      const check = checkCapsule(answer)
      if (!check.ok) {
        throw new HttpError(400, 'Answer needs work', check.issues.join(' '), problemType('capsule-invalid'))
      }
      update.status = 'answered'
    }
    update.answer = answer
  }

  if (req.body?.status !== undefined) {
    const status = String(req.body.status)
    if (!['suggested', 'answered', 'published', 'dismissed'].includes(status)) {
      throw new HttpError(400, 'Invalid status', 'Status must be suggested, answered, published or dismissed')
    }
    if (status === 'published') {
      const existing: any = await AnswerCapsule.findOne({ _id: questionId, organizationId }).select('answer').lean()
      const answer = String(update.answer ?? existing?.answer ?? '')
      // Publishing an empty answer would put a question on their website with
      // nothing under it, which is worse than not answering it.
      if (!checkCapsule(answer).ok) {
        throw new HttpError(409, 'Nothing to publish', 'Write an answer of 40 to 60 words first', problemType('capsule-empty'))
      }
      update.publishedAt = new Date()
    }
    update.status = status
  }

  const result = await AnswerCapsule.updateOne({ _id: questionId, organizationId }, { $set: update })
  if (!Number((result as any).matchedCount || 0)) throw new HttpError(404, 'Question not found', 'No question with that identifier exists in this workspace')
  res.json({ id: questionId, updated: Object.keys(update) })
}))

/* ------------------------------------------------------- 4. SEARCH CONSOLE */

/**
 * Search Console, NOT Business Profile.
 *
 * This needs no application to Google and no approval — the customer authorises
 * their own property. Business Profile (reading Google reviews, editing the
 * listing) is a separate API that is granted per application and can be
 * refused. It is not part of this module.
 */
router.get('/search-console', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const connection: any = await SearchConsoleConnection.findOne({ organizationId })
    .select('siteUrl connectedEmail status lastError lastSyncedAt updatedAt').lean()

  const provider = searchConsoleProvider()
  res.json({
    // Distinguishes "this deployment cannot do it" from "this customer has not
    // connected". They need different messages and different people to fix.
    available: provider.isConfigured(),
    connection: connection
      ? { ...connection, id: String(connection._id), _id: undefined }
      : null,
  })
}))

router.post('/search-console/start', asyncHandler(async (req: any, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const provider = searchConsoleProvider()

  try {
    /*
     * The state parameter carries the workspace AND a nonce.
     *
     * Without the nonce, a state value is guessable and somebody could complete
     * an authorisation against a workspace that never started one. The nonce is
     * stored and compared on return.
     */
    const nonce = crypto.randomBytes(24).toString('base64url')
    const state = `${organizationId}.${nonce}`
    await SearchConsoleConnection.updateOne(
      { organizationId },
      { $set: { lastError: null }, $setOnInsert: { organizationId } },
      { upsert: true },
    )
    ;(req.session ??= {}).searchConsoleNonce = nonce

    const redirectUri = `${String(req.headers.origin || '')}/api/v1/visibility/search-console/return`
    res.json({ url: provider.authorizationUrl({ organizationId, redirectUri, state }) })
  } catch (error) {
    if (error instanceof SearchConsoleNotConfiguredError) {
      throw new HttpError(503, 'Search Console unavailable', error.message, problemType('search-console-unconfigured'))
    }
    throw error
  }
}))

router.post('/search-console/disconnect', asyncHandler(async (req: any, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  // The tokens go, not just the flag. A disconnected connection that still
  // holds a live refresh token is a credential nobody believes exists.
  await SearchConsoleConnection.updateOne({ organizationId }, {
    $set: { status: 'revoked', refreshTokenCipher: null, accessTokenCipher: null, siteUrl: '', connectedEmail: null },
  })
  await recordAudit({ req, organizationId, action: 'visibility.search_console_disconnected', entityType: 'SearchConsoleConnection', entityId: organizationId })
  res.json({ disconnected: true })
}))

/** Recent queries, for the results screen. */
router.get('/search-console/queries', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const connection: any = await SearchConsoleConnection.findOne({ organizationId }).lean()
  if (!connection?.refreshTokenCipher || connection.status !== 'connected') {
    return res.json({ connected: false, rows: [] })
  }

  const provider = searchConsoleProvider()
  try {
    const refreshToken = decryptString(connection.refreshTokenCipher)
    const { accessToken, expiresAt } = await provider.refreshAccessToken(refreshToken)
    await SearchConsoleConnection.updateOne({ organizationId }, {
      $set: { accessTokenCipher: encryptString(accessToken), accessTokenExpiresAt: expiresAt, lastSyncedAt: new Date(), lastError: null },
    })

    const rows = await provider.queryAnalytics({
      accessToken,
      siteUrl: connection.siteUrl,
      from: new Date(Date.now() - 28 * 86_400_000),
      to: new Date(),
      rowLimit: 200,
    })
    res.json({ connected: true, rows })
  } catch (error) {
    /*
     * A failure is recorded and reported, never swallowed.
     *
     * Returning an empty list here would render as "no search traffic", the
     * operator would conclude their site has no visibility, and nobody would
     * discover the connection was broken.
     */
    const message = (error as Error).message
    await SearchConsoleConnection.updateOne({ organizationId }, {
      $set: { status: 'error', lastError: message.slice(0, 400) },
    })
    throw new HttpError(502, 'Search Console unavailable', message, problemType('search-console-error'))
  }
}))

/* ---------------------------------------------------------- 3. ATTRIBUTION */

router.get('/results', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const days = Math.min(365, Math.max(7, Number(req.query.days) || 30))

  const report = await attributionReport({
    organizationId,
    from: new Date(Date.now() - days * 86_400_000),
    to: new Date(),
    models: { Contact, ContactActivity, Deal },
  })

  res.json(report)
}))

/* --------------------------------------------------- 6. ARTICLE FROM A JOB */

/**
 * Is there an article in this month's work?
 *
 * Answers "no" freely. A refusal is the safety mechanism, not a failure: an
 * article about nothing in particular is exactly the thin content search
 * engines demote, and the risk sits on the customer's domain.
 */
router.get('/article-brief', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)

  const [profile, deals, questions, reviews, publishedThisMonth]: any[] = await Promise.all([
    BusinessProfile.findOne({ organizationId }).select('businessType').lean(),
    Deal.find({ organizationId, status: 'won', updatedAt: { $gte: new Date(Date.now() - 60 * 86_400_000) } })
      .select('title valueMinorUnits currency updatedAt contactId').sort({ updatedAt: -1 }).limit(20).lean(),
    AnswerCapsule.find({ organizationId, askedCount: { $gt: 1 } }).select('question askedCount').limit(10).lean(),
    Review.find({ organizationId, status: 'published', rating: { $gte: 4 } }).select('rating body').limit(20).lean(),
    BlogPost.countDocuments({ organizationId, status: 'published', publishedAt: { $gte: monthStart } }),
  ])

  const brief = briefFromWork({
    sources: {
      jobs: deals.map((deal: any) => ({
        title: deal.title,
        valueMinorUnits: deal.valueMinorUnits,
        currency: deal.currency,
        closedAt: deal.updatedAt,
        notes: [],
      })),
      questions: questions.map((entry: any) => ({ question: entry.question, askedCount: entry.askedCount })),
      reviews: reviews.map((review: any) => ({ rating: review.rating, body: review.body || '' })),
    },
    businessType: profile?.businessType,
    publishedThisMonth,
  })

  res.json({ brief, publishedThisMonth, maxPerMonth: MAX_ARTICLES_PER_MONTH })
}))

/**
 * Check a finished draft before it goes public.
 *
 * Separate from drafting deliberately. A brief costs nothing; publishing is the
 * moment the customer's domain is exposed.
 */
router.post('/article-check', asyncHandler(async (req: any, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const profile: any = await BusinessProfile.findOne({ organizationId }).select('businessType').lean()
  const brief = briefFromWork({
    sources: { jobs: [{ title: 'placeholder' }], questions: [], reviews: [] },
    businessType: profile?.businessType,
    publishedThisMonth: 0,
  })

  const verdict = canPublishDraft({
    body: String(req.body?.body || ''),
    requiresReview: brief.ok ? brief.requiresReview : false,
    reviewedByName: req.body?.reviewedByName,
    dateReviewed: req.body?.dateReviewed ? new Date(String(req.body.dateReviewed)) : null,
    approvedByUser: Boolean(req.body?.approved),
  })
  res.json(verdict)
}))

/* ---------------------------------------------------- 2. WEBSITE CONNECTION */

/** Four characters, dash, four. Readable over the phone; a key is not. */
function pairingCode(): string {
  // No I, O, 0 or 1 — they are the characters people misread and mistype when
  // reading a code aloud.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const pick = () => alphabet[crypto.randomInt(0, alphabet.length)]
  return `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(String(value).toUpperCase().trim()).digest('hex')
}

router.get('/site', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const connection: any = await SiteConnection.findOne({ organizationId })
    .select('siteUrl platform pluginVersion status lastSeenAt tokenIssuedAt').lean()

  const profile: any = await BusinessProfile.findOne({ organizationId }).select('website').lean()
  res.json({
    connection: connection ? { ...connection, id: String(connection._id), _id: undefined } : null,
    website: profile?.website ?? null,
    currentPluginVersion: '1.0.0',
    downloadUrl: '/logicflower-wordpress-plugin.zip',
  })
}))

router.post('/site/pairing-code', asyncHandler(async (req: any, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)

  const code = pairingCode()
  await SiteConnection.updateOne({ organizationId }, {
    $set: {
      pairingCodeHash: hash(code),
      // Fifteen minutes. Long enough to walk to a laptop; short enough that a
      // code left on a screen is already dead.
      pairingExpiresAt: new Date(Date.now() + 15 * 60_000),
      status: 'pairing',
    },
    $setOnInsert: { organizationId },
  }, { upsert: true })

  await recordAudit({ req, organizationId, action: 'visibility.pairing_code_issued', entityType: 'SiteConnection', entityId: organizationId })
  // The code is returned once. It is stored hashed, so it cannot be shown again.
  res.status(201).json({ code, expiresInMinutes: 15 })
}))

router.post('/site/disconnect', asyncHandler(async (req: any, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  // The token is destroyed, not merely flagged. A revoked connection still
  // holding a live token is a credential nobody believes exists.
  await SiteConnection.updateOne({ organizationId }, {
    $set: { status: 'revoked', siteTokenHash: null, pairingCodeHash: null },
  })
  await recordAudit({ req, organizationId, action: 'visibility.site_disconnected', entityType: 'SiteConnection', entityId: organizationId })
  res.json({ disconnected: true })
}))

/** Everything the plugin needs, for an operator who cannot install it. */
router.get('/site/manual', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const profile: any = await BusinessProfile.findOne({ organizationId }).lean()
  if (!profile) throw new HttpError(409, 'Add your business first', 'Fill in your business details before copying anything to your website', problemType('profile-missing'))

  const capsules: any[] = await AnswerCapsule.find({ organizationId, status: 'published' }).select('question answer').lean()
  const graph = buildBusinessGraph({ ...profile, url: profile.website, capsules })

  /*
   * The fallback is not second class.
   *
   * Some customers will never manage a plugin install: no WP-Admin experience,
   * a locked host, or an agency built the site three years ago and holds the
   * login. For them this is the only route, so it ships from day one.
   */
  res.json({
    schemaBlock: `<script type="application/ld+json">\n${JSON.stringify(graph, null, 2)}\n</script>`,
    questions: capsules.map((capsule) => ({ question: capsule.question, answer: capsule.answer })),
    instructions: 'Paste the block into the <head> of every page. Whoever looks after your website will know where that is.',
  })
}))

export default router
