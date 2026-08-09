import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { promises as fsPromises } from 'fs'
import { Types } from 'mongoose'
import BlogPost from '../models/BlogPost'
import Redirect from '../models/Redirect'
import SiteSetting from '../models/SiteSetting'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { pageLimit } from '../http/cursor'
import { env } from '../env'
import { recordAudit } from '../services/audit'
import { escapeHtml, renderMarkdown, slugify } from '../services/content/markdown'
import {
  checkImage, generatePreviewToken, MAX_IMAGE_BYTES, previewTokenMatches,
  renderRssFeed,
} from '../services/content/publishing'
import { openArtifact, safeDownloadFileName, storeArtifactFromBuffer } from '../services/artifactStore'
import { assessFreshness, buildArticleGraph, checkCapsule, guidanceForIntent } from '../services/content/entityGraph'
import { breadcrumbsFor, helpRoutes, MARKETING_ROUTES, STATIC_PUBLIC_ROUTES } from '../services/content/publicRoutes'
import { pipeline } from 'stream/promises'
import { assertCorporate } from '../middleware/platformAdmin'

/**
 * The public marketing site's content and search configuration.
 *
 * OWNERSHIP
 *
 * There is one public website and it belongs to the platform operator, so these
 * records carry no organizationId and the write routes are gated on the
 * PLATFORM role rather than a workspace membership. That is a deliberate
 * exception to the tenant rule, declared here rather than left to be inferred.
 */

const router = Router()
export const publicContentRouter = Router()

publicContentRouter.use((req, res, next) => {
  // Do not block indexing of the sitemap, robots file, or the server-rendered article HTML shell
  if (!['/robots.txt', '/sitemap.xml', '/rss.xml'].includes(req.path) && !req.path.startsWith('/article-shell/')) {
    res.setHeader('X-Robots-Tag', 'noindex')
  }
  next()
})

const publicLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false })

function objectId(value: unknown, label: string): string {
  const id = String(value || '')
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, `Invalid ${label}`, `${label} identifier is invalid`)
  return id
}

/**
 * Only the platform operator edits the public website, and only with a second
 * factor. Reads of the admin blog list are corporate-only but do not demand
 * MFA; anything that CHANGES what the public sees does.
 */
function requireCorporate(req: any, options: { mfa?: boolean } = {}): void {
  assertCorporate(req, { mfa: options.mfa ?? false })
}

/** Corporate authority plus a second factor, for writes. */
function requireCorporateWrite(req: any): void {
  assertCorporate(req, { mfa: true })
}

async function settings() {
  // tenant-safe: single global document for the public marketing site, which has no tenant
  return await SiteSetting.findOneAndUpdate({ key: 'site' }, { $setOnInsert: { key: 'site' } }, { upsert: true, new: true }).lean() as any
}

function absoluteUrl(site: any, path: string): string {
  const origin = String(site?.canonicalDomain || 'https://logicflower.com').replace(/\/$/, '')
  // Add trailing slash for directories (not files like .xml or .txt or .jpg)
  const isFile = path.match(/\.[a-zA-Z0-9]+$/)
  const slashedPath = (!isFile && !path.endsWith('/')) ? `${path}/` : path
  return `${origin}${slashedPath}`
}

/* ------------------------------------------------------------- blog (admin) */

router.get('/posts', asyncHandler(async (req, res) => {
  requireCorporate(req)
  const query: any = {}
  if (req.query.status) query.status = String(req.query.status).slice(0, 16)
  // tenant-safe: platform-owned marketing content, gated on the platform role above
  const rows: any[] = await BlogPost.find(query).sort({ updatedAt: -1 }).limit(pageLimit(req.query.limit)).lean()
  res.json({
    posts: rows.map((row) => ({
      id: String(row._id), title: row.title, slug: row.slug, status: row.status,
      category: row.category, tags: row.tags, publishedAt: row.publishedAt,
      readingMinutes: row.readingMinutes, updatedAt: row.updatedAt,
      targetKeyword: row.targetKeyword, noindex: row.noindex,
    })),
  })
}))

router.post('/posts', asyncHandler(async (req: any, res) => {
  requireCorporateWrite(req)
  const title = String(req.body?.title || '').trim().slice(0, 200)
  if (!title) throw new HttpError(400, 'Title required', 'A post needs a title')
  const slug = slugify(req.body?.slug || title)
  if (!slug) throw new HttpError(400, 'Invalid slug', 'The title produced no usable URL. Supply a slug.')

  try {
    // tenant-safe: platform-owned marketing content
    const created: any = await BlogPost.create({
      title, slug, status: 'draft',
      authorName: String(req.body?.authorName || '').slice(0, 120),
      category: String(req.body?.category || 'General').slice(0, 60),
      createdBy: req.auth?.userId,
    })
    await recordAudit({ req, organizationId: String(req.auth?.organizationId || 'platform'), action: 'content.post_created', entityType: 'BlogPost', entityId: String(created._id), metadata: { slug } })
    res.status(201).json({ id: String(created._id), slug })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Slug already used', 'Another post already uses that address', problemType('post-slug-duplicate'))
    throw error
  }
}))

router.get('/posts/:postId', asyncHandler(async (req, res) => {
  requireCorporate(req)
  const postId = objectId(req.params.postId, 'post')
  // tenant-safe: platform-owned marketing content
  const post: any = await BlogPost.findOne({ _id: postId }).lean()
  if (!post) throw new HttpError(404, 'Post not found', 'No post with that identifier exists')

  const wordCount = String(post.body || '').split(/\s+/).filter(Boolean).length
  res.json({
    post: { ...post, id: String(post._id), _id: undefined },
    // Prompts, never gates. Publishing is not blocked on any of these: an
    // editor who has a reason to ignore one is usually right, and a rule that
    // blocks publication gets worked around rather than followed.
    guidance: guidanceForIntent({
      intent: post.searchIntent,
      capsuleCount: (post.answerCapsules ?? []).length,
      hasInformationGain: Boolean(String(post.informationGainSource || '').trim()),
      wordCount,
      bodyText: post.body || '',
    }),
    freshness: assessFreshness({
      datePublished: post.publishedAt,
      dateModified: post.updatedAt,
      dateReviewed: post.dateReviewed,
    }),
    wordCount,
  })
}))

router.patch('/posts/:postId', asyncHandler(async (req: any, res) => {
  requireCorporateWrite(req)
  const postId = objectId(req.params.postId, 'post')
  // tenant-safe: platform-owned marketing content
  const existing: any = await BlogPost.findOne({ _id: postId }).select('status slug').lean()
  if (!existing) throw new HttpError(404, 'Post not found', 'No post with that identifier exists')

  const update: Record<string, unknown> = { updatedBy: req.auth?.userId }
  for (const field of ['title', 'excerpt', 'body', 'authorName', 'authorTitle', 'category', 'seoTitle', 'metaDescription', 'canonicalUrl', 'ogTitle', 'ogDescription', 'targetKeyword', 'featuredImageAlt'] as const) {
    if (req.body?.[field] !== undefined) update[field] = String(req.body[field]).slice(0, 4_000)
  }
  if (Array.isArray(req.body?.tags)) update.tags = req.body.tags.map((tag: unknown) => String(tag).slice(0, 60)).slice(0, 20)
  if (Array.isArray(req.body?.secondaryKeywords)) update.secondaryKeywords = req.body.secondaryKeywords.map((keyword: unknown) => String(keyword).slice(0, 80)).slice(0, 20)
  for (const field of ['authorBio', 'informationGainSource', 'reviewedByName', 'reviewedByTitle'] as const) {
    if (req.body?.[field] !== undefined) update[field] = String(req.body[field]).slice(0, 2_000)
  }
  for (const field of ['authorKnowsAbout', 'authorAlumniOf', 'authorSameAs'] as const) {
    if (Array.isArray(req.body?.[field])) update[field] = req.body[field].map((entry: unknown) => String(entry).slice(0, 200)).slice(0, 20)
  }
  if (req.body?.dateReviewed !== undefined) {
    update.dateReviewed = req.body.dateReviewed ? new Date(String(req.body.dateReviewed)) : null
  }
  if (Array.isArray(req.body?.answerCapsules)) {
    // Validated on save, so an out-of-bounds capsule is caught while the author
    // is still looking at it rather than after publication.
    const capsules = req.body.answerCapsules.slice(0, 12).map((capsule: any) => ({
      question: String(capsule?.question || '').slice(0, 300),
      answer: String(capsule?.answer || '').slice(0, 2_000),
    })).filter((capsule: any) => capsule.question.trim() && capsule.answer.trim())

    const problems = capsules.flatMap((capsule: any, index: number) =>
      checkCapsule(capsule.answer).issues.map((issue) => `Capsule ${index + 1}: ${issue}`))
    if (problems.length) {
      throw new HttpError(400, 'Answer capsule needs work', problems.join(' '), problemType('capsule-invalid'))
    }
    update.answerCapsules = capsules
  }
  if (req.body?.noindex !== undefined) update.noindex = Boolean(req.body.noindex)
  if (req.body?.searchIntent !== undefined) update.searchIntent = req.body.searchIntent || null

  if (req.body?.slug !== undefined) {
    // A published post's address is load-bearing: every existing link, every
    // search result and every share points at it. Changing it silently would
    // break all of them, so it is refused and the redirect manager is the
    // sanctioned route.
    if (existing.status === 'published') {
      throw new HttpError(409, 'Address is fixed once published', 'Changing the address of a published post breaks every existing link to it. Create a redirect instead.', problemType('post-slug-locked'))
    }
    const slug = slugify(req.body.slug)
    if (!slug) throw new HttpError(400, 'Invalid slug', 'That produced no usable address')
    update.slug = slug
  }

  if (typeof update.body === 'string') update.readingMinutes = renderMarkdown(update.body).readingMinutes

  try {
    await BlogPost.updateOne({ _id: postId }, { $set: update })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Slug already used', 'Another post already uses that address', problemType('post-slug-duplicate'))
    throw error
  }
  res.json({ id: postId, updated: Object.keys(update) })
}))

router.post('/posts/:postId/status', asyncHandler(async (req: any, res) => {
  requireCorporateWrite(req)
  const postId = objectId(req.params.postId, 'post')
  const status = String(req.body?.status || '')
  if (!['draft', 'scheduled', 'published', 'archived'].includes(status)) throw new HttpError(400, 'Invalid status', 'Status must be draft, scheduled, published or archived')

  // tenant-safe: platform-owned marketing content
  const post: any = await BlogPost.findOne({ _id: postId }).lean()
  if (!post) throw new HttpError(404, 'Post not found', 'No post with that identifier exists')

  if ((status === 'published' || status === 'scheduled') && !String(post.body || '').trim()) {
    throw new HttpError(409, 'Nothing to publish', 'This post has no content yet', problemType('post-empty'))
  }

  let publishedAt = post.publishedAt
  if (status === 'published') publishedAt = post.publishedAt ?? new Date()
  if (status === 'scheduled') {
    const when = new Date(String(req.body?.publishAt || ''))
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      throw new HttpError(400, 'Future date required', 'A scheduled post needs a publication time in the future')
    }
    publishedAt = when
  }

  await BlogPost.updateOne({ _id: postId }, { $set: { status, publishedAt } })
  await recordAudit({ req, organizationId: String(req.auth?.organizationId || 'platform'), action: `content.post_${status}`, entityType: 'BlogPost', entityId: postId, metadata: { slug: post.slug } })
  res.json({ id: postId, status, publishedAt })
}))

router.post('/posts/:postId/duplicate', asyncHandler(async (req: any, res) => {
  requireCorporateWrite(req)
  const postId = objectId(req.params.postId, 'post')
  // tenant-safe: platform-owned marketing content
  const post: any = await BlogPost.findOne({ _id: postId }).lean()
  if (!post) throw new HttpError(404, 'Post not found', 'No post with that identifier exists')

  const created: any = await BlogPost.create({
    ...post, _id: undefined, id: undefined,
    title: `${post.title} (copy)`,
    slug: `${post.slug}-copy-${Date.now().toString(36)}`,
    // A copy always starts as a draft, so duplicating never publishes.
    status: 'draft', publishedAt: null,
    createdAt: undefined, updatedAt: undefined,
    createdBy: req.auth?.userId,
  })
  res.status(201).json({ id: String(created._id), slug: created.slug })
}))

router.delete('/posts/:postId', asyncHandler(async (req, res) => {
  requireCorporateWrite(req)
  const postId = objectId(req.params.postId, 'post')
  // tenant-safe: platform-owned marketing content
  const result = await BlogPost.deleteOne({ _id: postId })
  if (!Number((result as any).deletedCount || 0)) throw new HttpError(404, 'Post not found', 'No post with that identifier exists')
  await recordAudit({ req, organizationId: String((req as any).auth?.organizationId || 'platform'), action: 'content.post_deleted', entityType: 'BlogPost', entityId: postId })
  res.json({ id: postId, deleted: true })
}))

/**
 * Attach a featured image.
 *
 * Validated on its BYTES, not on the content type the uploader supplied. A file
 * claiming to be a PNG while beginning with `<svg` would otherwise be served
 * from the marketing domain, in its own origin, carrying whatever script it
 * likes.
 */
router.post('/posts/:postId/image', asyncHandler(async (req: any, res) => {
  requireCorporateWrite(req)
  const postId = objectId(req.params.postId, 'post')
  // tenant-safe: platform-owned marketing content
  const post: any = await BlogPost.findOne({ _id: postId }).select('slug').lean()
  if (!post) throw new HttpError(404, 'Post not found', 'No post with that identifier exists')

  const base64 = String(req.body?.contentBase64 || '')
  if (!base64) throw new HttpError(400, 'File required', 'Supply contentBase64')
  const body = Buffer.from(base64, 'base64')

  const check = checkImage({ body, declaredType: String(req.body?.contentType || '') })
  if (!check.ok) throw new HttpError(400, 'Image rejected', check.reason ?? 'That file cannot be used', problemType('image-rejected'))

  const artifact: any = await storeArtifactFromBuffer({
    organizationId: 'platform',
    kind: 'contact_attachment',
    fileName: safeDownloadFileName(`${post.slug}.${check.extension}`),
    contentType: check.detectedType!,
    body,
  })
  const artifactId = String(artifact.artifactId ?? artifact._id)
  await BlogPost.updateOne({ _id: postId }, {
    $set: {
      featuredImageArtifactId: artifactId,
      featuredImageUrl: `/api/v1/public/content/images/${artifactId}`,
      featuredImageAlt: String(req.body?.alt || '').slice(0, 300),
    },
  })
  res.status(201).json({ id: artifactId, url: `/api/v1/public/content/images/${artifactId}`, maxBytes: MAX_IMAGE_BYTES })
}))

/** A shareable link that makes an unpublished article readable for review. */
router.post('/posts/:postId/preview-token', asyncHandler(async (req: any, res) => {
  requireCorporateWrite(req)
  const postId = objectId(req.params.postId, 'post')
  const token = generatePreviewToken()
  // Rotating revokes any link already handed out.
  const result = await BlogPost.updateOne({ _id: postId }, { $set: { previewToken: token } })
  if (!Number((result as any).matchedCount || 0)) throw new HttpError(404, 'Post not found', 'No post with that identifier exists')
  await recordAudit({ req, organizationId: 'platform', action: 'content.preview_token_issued', entityType: 'BlogPost', entityId: postId })
  res.status(201).json({ token, url: `/blog/${(await BlogPost.findOne({ _id: postId }).select('slug').lean() as any)?.slug}?preview=${token}` })
}))

/* -------------------------------------------------------- site settings (admin) */

router.get('/settings', asyncHandler(async (req, res) => {
  requireCorporate(req)
  const site = await settings()
  res.json({ settings: { ...site, id: String(site._id), _id: undefined } })
}))

router.put('/settings', asyncHandler(async (req: any, res) => {
  requireCorporateWrite(req)
  const update: Record<string, unknown> = { updatedBy: req.auth?.userId }
  for (const field of ['siteTitle', 'siteDescription', 'titleTemplate', 'organizationName', 'defaultSocialImageUrl', 'searchConsoleVerification'] as const) {
    if (req.body?.[field] !== undefined) update[field] = String(req.body[field]).slice(0, 500)
  }
  if (req.body?.canonicalDomain !== undefined) {
    const domain = String(req.body.canonicalDomain).trim().replace(/\/$/, '')
    // One origin, or the site competes with itself in search results.
    if (domain && !/^https?:\/\/[^\s/]+$/i.test(domain)) {
      throw new HttpError(400, 'Invalid domain', 'Give a full origin such as https://example.com, with no path', problemType('canonical-domain-invalid'))
    }
    update.canonicalDomain = domain
  }
  if (Array.isArray(req.body?.socialProfiles)) update.socialProfiles = req.body.socialProfiles.map((url: unknown) => String(url).slice(0, 300)).slice(0, 10)
  if (req.body?.robotsNoindexAll !== undefined) update.robotsNoindexAll = Boolean(req.body.robotsNoindexAll)

  await SiteSetting.updateOne({ key: 'site' }, { $set: update }, { upsert: true })
  await recordAudit({ req, organizationId: String(req.auth?.organizationId || 'platform'), action: 'content.settings_updated', entityType: 'SiteSetting', entityId: 'site', metadata: { fields: Object.keys(update) } })
  res.json({ updated: Object.keys(update) })
}))

/* ------------------------------------------------------------ redirects (admin) */

router.get('/redirects', asyncHandler(async (req, res) => {
  requireCorporate(req)
  // tenant-safe: platform-owned marketing site configuration
  const rows: any[] = await Redirect.find({}).sort({ _id: -1 }).limit(500).lean()
  res.json({
    redirects: rows.map((row) => ({
      id: String(row._id), fromPath: row.fromPath, toPath: row.toPath,
      statusCode: row.statusCode, hits: row.hits, lastHitAt: row.lastHitAt, note: row.note,
    })),
  })
}))

router.post('/redirects', asyncHandler(async (req: any, res) => {
  requireCorporateWrite(req)
  const fromPath = String(req.body?.fromPath || '').trim()
  const toPath = String(req.body?.toPath || '').trim()
  for (const [label, value] of [['fromPath', fromPath], ['toPath', toPath]] as const) {
    if (!value.startsWith('/') || value.startsWith('//')) {
      throw new HttpError(400, 'Paths only', `${label} must be a path beginning with a single slash, not a full URL`, problemType('redirect-path-invalid'))
    }
  }
  // A redirect to itself is an infinite loop, and the browser is the thing that
  // notices.
  if (fromPath === toPath) throw new HttpError(400, 'Redirect loops', 'A path cannot redirect to itself', problemType('redirect-loop'))

  try {
    const created: any = await Redirect.create({
      fromPath, toPath,
      statusCode: Number(req.body?.statusCode) === 302 ? 302 : 301,
      note: String(req.body?.note || '').slice(0, 300),
      createdBy: req.auth?.userId,
    })
    res.status(201).json({ id: String(created._id) })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Already redirected', 'That path already has a redirect', problemType('redirect-duplicate'))
    throw error
  }
}))

router.delete('/redirects/:redirectId', asyncHandler(async (req, res) => {
  requireCorporateWrite(req)
  const redirectId = objectId(req.params.redirectId, 'redirect')
  // tenant-safe: platform-owned marketing site configuration
  await Redirect.deleteOne({ _id: redirectId })
  res.json({ id: redirectId, deleted: true })
}))

/* ------------------------------------------------------------------ public */

/** Only posts that are published AND due. A scheduled post is not yet public. */
function livePostFilter() {
  return { status: 'published', publishedAt: { $lte: new Date() }, noindex: { $ne: true } }
}

publicContentRouter.get('/posts', publicLimiter, asyncHandler(async (req, res) => {
  const filter: any = { status: 'published', publishedAt: { $lte: new Date() } }
  if (req.query.category) filter.category = String(req.query.category).slice(0, 60)
  if (req.query.tag) filter.tags = String(req.query.tag).slice(0, 60)

  // tenant-safe: public marketing content with no tenant
  const rows: any[] = await BlogPost.find(filter).sort({ publishedAt: -1 }).limit(pageLimit(req.query.limit)).lean()
  const site = await settings()
  res.json({
    posts: rows.map((row) => ({
      title: row.title, slug: row.slug, excerpt: row.excerpt, category: row.category,
      tags: row.tags, publishedAt: row.publishedAt, readingMinutes: row.readingMinutes,
      authorName: row.authorName, url: absoluteUrl(site, `/blog/${row.slug}`),
    })),
    categories: [...new Set(rows.map((row) => row.category).filter(Boolean))],
  })
}))

publicContentRouter.get('/posts/:slug', publicLimiter, asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').slice(0, 100)
  const previewToken = String(req.query.preview || '').slice(0, 128)

  /*
   * An unpublished article is readable only with its own preview token, so a
   * draft can be sent for review without being published.
   *
   * The token is fetched then compared in constant time rather than matched in
   * the query: a query match would confirm or deny a guess by whether a row
   * came back, and the token is guessable byte by byte if timing leaks.
   */
  // tenant-safe: public marketing content with no tenant
  let post: any = await BlogPost.findOne({ slug, status: 'published', publishedAt: { $lte: new Date() } }).lean()
  if (!post && previewToken) {
    // tenant-safe: public marketing content with no tenant
    const draft: any = await BlogPost.findOne({ slug }).select('+previewToken').lean()
    if (draft && previewTokenMatches(previewToken, draft.previewToken)) post = draft
  }
  if (!post) throw new HttpError(404, 'Article not found', 'No published article matches this address', problemType('post-not-found'))

  // A preview must never be indexed, whatever the article's own setting says.
  const isPreview = post.status !== 'published'

  const site = await settings()
  const rendered = renderMarkdown(post.body || '')
  const canonical = post.canonicalUrl || absoluteUrl(site, `/blog/${post.slug}`)

  // tenant-safe: public marketing content with no tenant
  const related: any[] = await BlogPost.find({ ...livePostFilter(), category: post.category, _id: { $ne: post._id } })
    .sort({ publishedAt: -1 }).limit(3).select('title slug excerpt readingMinutes').lean()

  res.json({
    article: {
      title: post.title,
      slug: post.slug,
      excerpt: post.excerpt,
      html: rendered.html,
      headings: rendered.headings,
      readingMinutes: rendered.readingMinutes,
      authorName: post.authorName,
      authorTitle: post.authorTitle,
      category: post.category,
      tags: post.tags,
      publishedAt: post.publishedAt,
      modifiedAt: post.updatedAt,
      featuredImageAlt: post.featuredImageAlt,
      featuredImageUrl: post.featuredImageUrl,
      isPreview,
    },
    seo: {
      title: (site.titleTemplate || '%s').replace('%s', post.seoTitle || post.title),
      description: post.metaDescription || post.excerpt,
      canonical,
      noindex: Boolean(post.noindex || site.robotsNoindexAll || isPreview),
      ogTitle: post.ogTitle || post.seoTitle || post.title,
      ogDescription: post.ogDescription || post.metaDescription || post.excerpt,
      ogImage: site.defaultSocialImageUrl,
    },
    // Answers written to be lifted whole. Surfaced separately from the body so
    // the layout can present them as quotable blocks.
    capsules: post.answerCapsules ?? [],
    // Shown as a badge, and used by the editor to flag articles going stale.
    freshness: assessFreshness({
      datePublished: post.publishedAt,
      dateModified: post.updatedAt,
      dateReviewed: post.dateReviewed,
      reviewedByName: post.reviewedByName,
      reviewedByTitle: post.reviewedByTitle,
    }),
    author: post.authorName ? {
      name: post.authorName,
      jobTitle: post.authorTitle,
      bio: post.authorBio,
      knowsAbout: post.authorKnowsAbout ?? [],
      sameAs: post.authorSameAs ?? [],
    } : null,
    informationGainSource: post.informationGainSource,
    // A connected graph rather than a list of unrelated blocks: the
    // relationships between article, author and publisher are what carry
    // meaning to a retrieval system.
    structuredData: buildArticleGraph({
      title: post.title,
      description: post.metaDescription || post.excerpt || '',
      canonicalUrl: canonical,
      imageUrl: post.featuredImageUrl ? absoluteUrl(site, post.featuredImageUrl) : null,
      articleSection: post.category,
      keywords: post.tags,
      wordCount: String(post.body || '').split(/\s+/).filter(Boolean).length,
      author: post.authorName ? {
        name: post.authorName,
        jobTitle: post.authorTitle,
        description: post.authorBio,
        knowsAbout: post.authorKnowsAbout,
        alumniOf: post.authorAlumniOf,
        sameAs: post.authorSameAs,
      } : null,
      organizationName: site.organizationName,
      organizationUrl: site.canonicalDomain,
      organizationLogoUrl: site.defaultSocialImageUrl,
      editorial: {
        datePublished: post.publishedAt,
        dateModified: post.updatedAt,
        dateReviewed: post.dateReviewed,
        reviewedByName: post.reviewedByName,
        reviewedByTitle: post.reviewedByTitle,
      },
      capsules: post.answerCapsules,
    }),
    // Shown as the trail in a search result rather than a bare URL.
    breadcrumbs: breadcrumbsFor({
      path: `/blog/${post.slug}`,
      title: post.title,
      origin: String(site.canonicalDomain || ''),
    }),
    legacyStructuredData: {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.metaDescription || post.excerpt,
      datePublished: post.publishedAt,
      dateModified: post.updatedAt,
      author: post.authorName ? { '@type': 'Person', name: post.authorName } : undefined,
      publisher: site.organizationName ? { '@type': 'Organization', name: site.organizationName } : undefined,
      mainEntityOfPage: canonical,
    },
    related: related.map((row) => ({ title: row.title, slug: row.slug, excerpt: row.excerpt, readingMinutes: row.readingMinutes })),
  })
}))

/** Resolve a redirect, and count it so dead links can be found later. */
publicContentRouter.get('/redirect', publicLimiter, asyncHandler(async (req, res) => {
  const path = String(req.query.path || '').slice(0, 300)
  // tenant-safe: public marketing site configuration with no tenant
  const redirect: any = await Redirect.findOneAndUpdate(
    { fromPath: path },
    { $inc: { hits: 1 }, $set: { lastHitAt: new Date() } },
    { new: true },
  ).lean()
  if (!redirect) return res.status(404).json({ found: false })
  res.json({ found: true, toPath: redirect.toPath, statusCode: redirect.statusCode })
}))

/**
 * Serve a blog image.
 *
 * The stored content type is echoed rather than sniffed by the browser, and
 * nosniff is set, so a file that somehow got through validation still cannot be
 * reinterpreted as script.
 */
publicContentRouter.get('/images/:artifactId', publicLimiter, asyncHandler(async (req, res) => {
  const artifactId = String(req.params.artifactId || '')
  if (!Types.ObjectId.isValid(artifactId)) throw new HttpError(404, 'Not found', 'No image with that identifier')
  // tenant-safe: platform-owned marketing image, referenced by an unguessable id
  const post: any = await BlogPost.findOne({ featuredImageArtifactId: artifactId }).select('_id').lean()
  if (!post) throw new HttpError(404, 'Not found', 'No image with that identifier')

  const opened = await openArtifact('platform', artifactId)
  res.setHeader('Content-Type', opened.artifact?.contentType || 'application/octet-stream')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'public, max-age=86400')
  await pipeline(opened.stream, res)
}))

publicContentRouter.get('/rss.xml', publicLimiter, asyncHandler(async (_req, res) => {
  const site = await settings()
  // tenant-safe: public marketing content with no tenant
  const posts: any[] = await BlogPost.find(livePostFilter()).sort({ publishedAt: -1 }).limit(50)
    .select('title slug excerpt publishedAt authorName category').lean()
  res.type('application/rss+xml')
  res.send(renderRssFeed({
    siteTitle: site.siteTitle || 'Blog',
    siteDescription: site.siteDescription || '',
    origin: String(site.canonicalDomain || ''),
    items: posts.map((post) => ({
      title: post.title, slug: post.slug, excerpt: post.excerpt || '',
      publishedAt: post.publishedAt, authorName: post.authorName, category: post.category,
    })),
  }))
}))

/**
 * The SPA shell for one article, with its metadata already in the head.
 *
 * Blog articles live in the database, so the build-time prerender cannot know
 * them. nginx proxies `/blog/:slug` here, this fills in the head, and the same
 * bundle hydrates over it.
 *
 * Without this, sharing an article on LinkedIn shows the homepage blurb, and
 * every crawler that does not run JavaScript reads one generic description for
 * every article on the site.
 */
publicContentRouter.get('/article-shell/:slug', publicLimiter, asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').slice(0, 100)
  // tenant-safe: public marketing content with no tenant
  const post: any = await BlogPost.findOne({ slug, status: 'published', publishedAt: { $lte: new Date() } })
    .select('title slug excerpt metaDescription seoTitle ogTitle ogDescription canonicalUrl noindex featuredImageUrl publishedAt updatedAt authorName category').lean()

  const site = await settings()
  const shellPath = env.CLIENT_DIST_PATH || '/usr/share/nginx/html/index.html'
  let template: string
  try {
    template = await fsPromises.readFile(shellPath, 'utf8')
  } catch {
    // Without the shell there is nothing to inject into. Falling through to a
    // redirect keeps the page working for a human, and only the crawler
    // metadata is lost.
    return res.redirect(302, `/blog/${encodeURIComponent(slug)}`)
  }

  if (!post) {
    // A real 404 for a real missing article, rather than the soft 200 nginx
    // would otherwise return for any unknown path.
    res.status(404)
    return res.type('html').send(template.replace('</head>', '  <meta name="robots" content="noindex">\n  </head>'))
  }

  const canonical = post.canonicalUrl || absoluteUrl(site, `/blog/${post.slug}`)
  const title = (site.titleTemplate || '%s').replace('%s', post.seoTitle || post.title)
  const description = post.metaDescription || post.excerpt || site.siteDescription || ''
  const image = post.featuredImageUrl ? absoluteUrl(site, post.featuredImageUrl) : site.defaultSocialImageUrl

  const head = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    post.noindex || site.robotsNoindexAll ? '<meta name="robots" content="noindex">' : '',
    '<meta property="og:type" content="article">',
    `<meta property="og:title" content="${escapeHtml(post.ogTitle || post.seoTitle || post.title)}">`,
    `<meta property="og:description" content="${escapeHtml(post.ogDescription || description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : '',
    `<meta property="article:published_time" content="${new Date(post.publishedAt).toISOString()}">`,
    `<meta property="article:modified_time" content="${new Date(post.updatedAt).toISOString()}">`,
    post.authorName ? `<meta property="article:author" content="${escapeHtml(post.authorName)}">` : '',
    post.category ? `<meta property="article:section" content="${escapeHtml(post.category)}">` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(post.ogTitle || post.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(post.ogDescription || description)}">`,
  ].filter(Boolean).join('\n    ')

  // The template's own title and description are removed rather than left in
  // place: a crawler taking the first match would read the generic one.
  const html = template
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name="description"[^>]*>/i, '')
    .replace('</head>', `  ${head}\n  </head>`)

  res.type('html')
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.send(html)
}))

publicContentRouter.get('/robots.txt', publicLimiter, asyncHandler(async (_req, res) => {
  const site = await settings()
  res.type('text/plain')
  
  if (site.robotsNoindexAll) return res.send('User-agent: *\nDisallow: /\n')
  
  const sitemap = absoluteUrl(site, '/sitemap.xml')

  res.send([
    'User-agent: *',
    'Allow: /api/v1/public/content/',
    'Disallow: /api/',
    '',
    `Sitemap: ${sitemap}`,
  ].join('\n') + '\n')
}))

publicContentRouter.get('/sitemap.xml', publicLimiter, asyncHandler(async (_req, res) => {
  const site = await settings()
  res.type('application/xml')
  if (site.robotsNoindexAll) return res.send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>')

  // tenant-safe: public marketing content with no tenant
  const posts: any[] = await BlogPost.find(livePostFilter()).sort({ publishedAt: -1 }).limit(2_000)
    .select('slug title updatedAt featuredImageUrl featuredImageAlt').lean()

  interface Entry {
    loc: string
    lastmod?: Date | null
    image?: { loc: string; title: string; caption?: string }
  }

  const now = new Date()

  const entries: Entry[] = [
    ...STATIC_PUBLIC_ROUTES.map((route) => ({
      loc: absoluteUrl(site, route.path), lastmod: now,
    })),
    // One page per search intent. A homepage cannot rank for four queries at
    // once, so these are where the specific ones land.
    ...MARKETING_ROUTES.map((route) => ({
      loc: absoluteUrl(site, route.path), lastmod: now,
    })),
    // Help articles are worth indexing: "why is activate greyed out" is a real
    // search, and one of these pages is the answer.
    ...helpRoutes().map((route) => ({
      loc: absoluteUrl(site, route.path), lastmod: now,
    })),
    ...posts.map((post) => ({
      loc: absoluteUrl(site, `/blog/${post.slug}`),
      lastmod: post.updatedAt,
      // The image namespace, so a featured image is indexed with its article
      // rather than being invisible.
      ...(post.featuredImageUrl ? {
        image: {
          loc: absoluteUrl(site, post.featuredImageUrl),
          title: post.title,
          caption: post.featuredImageAlt || undefined,
        },
      } : {}),
    })),
  ]

  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${entries.map((entry) => `  <url>
    <loc>${escapeHtml(entry.loc)}</loc>${entry.lastmod ? `\n    <lastmod>${new Date(entry.lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}${entry.image ? `\n    <image:image>
      <image:loc>${escapeHtml(entry.image.loc)}</image:loc>
      <image:title>${escapeHtml(entry.image.title)}</image:title>${entry.image.caption ? `\n      <image:caption>${escapeHtml(entry.image.caption)}</image:caption>` : ''}
    </image:image>` : ''}
  </url>`).join('\n')}
</urlset>
`)
}))

export default router
