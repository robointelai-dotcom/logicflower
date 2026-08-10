import crypto from 'crypto'
import BlogPost from '../../models/BlogPost'
import pino from '../../logger'
import { recordAudit } from '../audit'

/**
 * Publishing scheduled articles, and the preview tokens that let a draft be
 * read before it goes live.
 *
 * The scheduler exists because the alternative was worse than having no
 * scheduling at all: the interface accepted a future date, stored it, and
 * nothing ever published it. The post sat scheduled forever and nobody noticed
 * until the launch that was meant to happen on Tuesday had not.
 */

/**
 * Publish everything whose time has come.
 *
 * Claimed one at a time with a conditional update rather than read-then-write.
 * Two application instances both run this loop, and without the condition both
 * would publish the same article — harmless in itself, but it would write two
 * audit records and two `publishedAt` values, and the second would overwrite
 * the first with a later timestamp.
 */
export async function publishDueArticles(limit = 25): Promise<{ published: number }> {
  const now = new Date()
  let published = 0

  for (let index = 0; index < Math.max(1, Math.min(limit, 100)); index += 1) {
    // tenant-safe: platform-owned marketing content, which has no tenant
    const claimed: any = await BlogPost.findOneAndUpdate(
      { status: 'scheduled', publishedAt: { $lte: now } },
      { $set: { status: 'published' } },
      { new: true, sort: { publishedAt: 1 } },
    ).lean()
    if (!claimed) break

    published += 1
    await recordAudit({
      organizationId: 'platform',
      actorType: 'system',
      action: 'content.post_published_on_schedule',
      entityType: 'BlogPost',
      entityId: String(claimed._id),
      metadata: { slug: claimed.slug, scheduledFor: claimed.publishedAt },
    })
    pino.info({ slug: claimed.slug }, 'scheduled article published')
  }

  return { published }
}

/**
 * A token that makes one unpublished article readable.
 *
 * Unguessable and scoped to a single article, so it can be sent to somebody for
 * review without publishing. It deliberately does NOT expire: a review link
 * that dies over a weekend is a link somebody works around by publishing early,
 * which is the outcome the preview exists to prevent. Rotating it revokes the
 * old one.
 */
export function generatePreviewToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

/**
 * Compare a supplied token against the stored one.
 *
 * Constant-time: a plain `===` on a secret leaks its prefix through timing, and
 * this one is guessable byte by byte if it does.
 */
export function previewTokenMatches(supplied: string, stored: string | null | undefined): boolean {
  if (!stored || !supplied) return false
  const a = Buffer.from(String(supplied))
  const b = Buffer.from(String(stored))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/* --------------------------------------------------------------- media */

/**
 * Image types permitted for upload.
 *
 * An allow-list, not a block-list. SVG is deliberately absent: it is a document
 * format that can carry script, and one served from your own domain runs in
 * your origin. The convenience is not worth the hole.
 */
export const PERMITTED_IMAGE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
})

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * Magic bytes per format.
 *
 * The declared content type is supplied by whoever is uploading and cannot be
 * trusted. A file claiming to be a PNG while beginning with `<svg` or `<?php`
 * is rejected here rather than served from the marketing domain.
 */
const SIGNATURES: Array<{ type: string; test: (buffer: Buffer) => boolean }> = [
  { type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/gif', test: (b) => b.length > 6 && (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a') },
  { type: 'image/webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
]

export interface ImageCheck {
  ok: boolean
  detectedType?: string
  extension?: string
  reason?: string
}

export function checkImage(input: { body: Buffer; declaredType: string }): ImageCheck {
  if (!input.body?.length) return { ok: false, reason: 'The file is empty.' }
  if (input.body.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `Images must be under ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.` }
  }

  const declared = String(input.declaredType || '').toLowerCase().split(';')[0]!.trim()
  if (!PERMITTED_IMAGE_TYPES[declared]) {
    return { ok: false, reason: 'Only JPEG, PNG, WebP and GIF images are accepted. SVG is not, because it can carry script.' }
  }

  const match = SIGNATURES.find((signature) => signature.test(input.body))
  if (!match) return { ok: false, reason: 'That file does not look like an image, whatever it is named.' }

  // The bytes decide, not the label. A mismatch usually means an honest mistake
  // and occasionally means somebody testing what gets through.
  if (match.type !== declared) {
    return { ok: false, reason: `The file is a ${match.type}, not the ${declared} it claims to be.` }
  }

  return { ok: true, detectedType: match.type, extension: PERMITTED_IMAGE_TYPES[match.type] }
}

/* ----------------------------------------------------------------- RSS */

export interface FeedItem {
  title: string
  slug: string
  excerpt: string
  publishedAt: Date
  authorName?: string
  category?: string
}

/** Escape for XML. A stray ampersand in a title makes a feed unparseable. */
function xml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function renderRssFeed(input: {
  siteTitle: string
  siteDescription: string
  origin: string
  selfHref?: string
  items: FeedItem[]
}): string {
  const origin = String(input.origin || '').replace(/\/$/, '')
  const self = input.selfHref || `${origin}/rss.xml`
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(input.siteTitle || 'Blog')}</title>
    <!-- No trailing slash: the sitemap and the prerendered pages both use
         /blog, and to a search engine /blog and /blog/ are two URLs. A feed
         advertising the second splits the signal from the first. -->
    <link>${xml(`${origin}/blog`)}</link>
    <description>${xml(input.siteDescription || '')}</description>
    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>
${input.items.map((item) => `    <item>
      <title>${xml(item.title)}</title>
      <link>${xml(`${origin}/blog/${item.slug}`)}</link>
      <guid isPermaLink="true">${xml(`${origin}/blog/${item.slug}`)}</guid>
      <description>${xml(item.excerpt)}</description>
      <pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>${item.category ? `\n      <category>${xml(item.category)}</category>` : ''}
    </item>`).join('\n')}
  </channel>
</rss>`
}
