import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { Types } from 'mongoose'
import BlogPost from '../models/BlogPost'
import Redirect from '../models/Redirect'
import SiteSetting from '../models/SiteSetting'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { pageLimit } from '../http/cursor'
import { recordAudit } from '../services/audit'
import { escapeHtml, renderMarkdown, slugify } from '../services/content/markdown'

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

const publicLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false })

function objectId(value: unknown, label: string): string {
  const id = String(value || '')
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, `Invalid ${label}`, `${label} identifier is invalid`)
  return id
}

/** Only the platform operator edits the public website. */
function requireCorporate(req: any): void {
  if (!['owner', 'admin'].includes(String(req.auth?.platformRole || 'user'))) {
    throw new HttpError(403, 'Corporate access required', 'Only platform administrators can edit the public website')
  }
}

async function settings() {
  // tenant-safe: single global document for the public marketing site, which has no tenant
  return await SiteSetting.findOneAndUpdate({ key: 'site' }, { $setOnInsert: { key: 'site' } }, { upsert: true, new: true }).lean() as any
}

/** Absolute URL from the one configured origin, so canonicals never disagree. */
function absoluteUrl(site: any, path: string): string {
  const origin = String(site?.canonicalDomain || '').replace(/\/$/, '')
  return origin ? `${origin}${path}` : path
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
  requireCorporate(req)
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
  res.json({ post: { ...post, id: String(post._id), _id: undefined } })
}))

router.patch('/posts/:postId', asyncHandler(async (req: any, res) => {
  requireCorporate(req)
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
  requireCorporate(req)
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
  requireCorporate(req)
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
  requireCorporate(req)
  const postId = objectId(req.params.postId, 'post')
  // tenant-safe: platform-owned marketing content
  const result = await BlogPost.deleteOne({ _id: postId })
  if (!Number((result as any).deletedCount || 0)) throw new HttpError(404, 'Post not found', 'No post with that identifier exists')
  await recordAudit({ req, organizationId: String((req as any).auth?.organizationId || 'platform'), action: 'content.post_deleted', entityType: 'BlogPost', entityId: postId })
  res.json({ id: postId, deleted: true })
}))

/* -------------------------------------------------------- site settings (admin) */

router.get('/settings', asyncHandler(async (req, res) => {
  requireCorporate(req)
  const site = await settings()
  res.json({ settings: { ...site, id: String(site._id), _id: undefined } })
}))

router.put('/settings', asyncHandler(async (req: any, res) => {
  requireCorporate(req)
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
  requireCorporate(req)
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
  requireCorporate(req)
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
  // tenant-safe: public marketing content with no tenant
  const post: any = await BlogPost.findOne({ slug, status: 'published', publishedAt: { $lte: new Date() } }).lean()
  if (!post) throw new HttpError(404, 'Article not found', 'No published article matches this address', problemType('post-not-found'))

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
    },
    seo: {
      title: (site.titleTemplate || '%s').replace('%s', post.seoTitle || post.title),
      description: post.metaDescription || post.excerpt,
      canonical,
      noindex: Boolean(post.noindex || site.robotsNoindexAll),
      ogTitle: post.ogTitle || post.seoTitle || post.title,
      ogDescription: post.ogDescription || post.metaDescription || post.excerpt,
      ogImage: site.defaultSocialImageUrl,
    },
    // Emitted by the client as JSON-LD. Assembled here so the shape stays with
    // the data rather than being reconstructed in the browser.
    structuredData: {
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

publicContentRouter.get('/robots.txt', publicLimiter, asyncHandler(async (_req, res) => {
  const site = await settings()
  res.type('text/plain')
  // A site-wide noindex is honoured here as well as in the page metadata, so a
  // staging deployment cannot leak into search through one route while blocked
  // on the other.
  if (site.robotsNoindexAll) return res.send('User-agent: *\nDisallow: /\n')
  const sitemap = absoluteUrl(site, '/sitemap.xml')
  res.send(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${sitemap}\n`)
}))

publicContentRouter.get('/sitemap.xml', publicLimiter, asyncHandler(async (_req, res) => {
  const site = await settings()
  res.type('application/xml')
  if (site.robotsNoindexAll) return res.send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>')

  // tenant-safe: public marketing content with no tenant
  const posts: any[] = await BlogPost.find(livePostFilter()).sort({ publishedAt: -1 }).limit(2_000).select('slug updatedAt').lean()
  const staticPaths = ['/', '/blog']

  const entries = [
    ...staticPaths.map((path) => ({ loc: absoluteUrl(site, path), lastmod: null })),
    ...posts.map((post) => ({ loc: absoluteUrl(site, `/blog/${post.slug}`), lastmod: post.updatedAt })),
  ]
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((entry) => `  <url><loc>${escapeHtml(entry.loc)}</loc>${entry.lastmod ? `<lastmod>${new Date(entry.lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>`)
}))

export default router
