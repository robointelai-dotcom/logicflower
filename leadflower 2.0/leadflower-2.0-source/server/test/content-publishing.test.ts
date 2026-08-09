import { describe, expect, it } from 'vitest'
import {
  checkImage, generatePreviewToken, MAX_IMAGE_BYTES,
  PERMITTED_IMAGE_TYPES, previewTokenMatches, renderRssFeed,
} from '../src/services/content/publishing'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(64)])

describe('image validation', () => {
  it('accepts the four raster formats a blog needs', () => {
    expect(checkImage({ body: PNG, declaredType: 'image/png' }).ok).toBe(true)
    expect(checkImage({ body: JPEG, declaredType: 'image/jpeg' }).ok).toBe(true)
    expect(checkImage({ body: GIF, declaredType: 'image/gif' }).ok).toBe(true)
  })

  it('refuses SVG outright', () => {
    // SVG is a document format that can carry script, and one served from the
    // marketing domain runs in that origin.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const result = checkImage({ body: svg, declaredType: 'image/svg+xml' })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/SVG/)
    expect(PERMITTED_IMAGE_TYPES['image/svg+xml']).toBeUndefined()
  })

  it('trusts the bytes over the declared type', () => {
    // A file claiming to be a PNG while beginning with <svg would otherwise be
    // served from our own domain.
    const svgPretendingToBePng = Buffer.from('<svg><script>alert(1)</script></svg>')
    expect(checkImage({ body: svgPretendingToBePng, declaredType: 'image/png' }).ok).toBe(false)
    // And a genuine mismatch between two permitted formats is still refused.
    const result = checkImage({ body: PNG, declaredType: 'image/jpeg' })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/not the image\/jpeg it claims/)
  })

  it('refuses anything that is not an image at all', () => {
    for (const payload of ['<?php system($_GET[0]); ?>', 'MZ\u0090\u0000', 'plain text']) {
      expect(checkImage({ body: Buffer.from(payload), declaredType: 'image/png' }).ok).toBe(false)
    }
  })

  it('bounds size and refuses an empty file', () => {
    expect(checkImage({ body: Buffer.alloc(0), declaredType: 'image/png' }).ok).toBe(false)
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES + 1)])
    expect(checkImage({ body: huge, declaredType: 'image/png' }).ok).toBe(false)
  })
})

describe('preview tokens', () => {
  it('produces an unguessable token, different every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generatePreviewToken()))
    expect(tokens.size).toBe(50)
    expect(generatePreviewToken().length).toBeGreaterThanOrEqual(30)
  })

  it('matches only the exact token', () => {
    const token = generatePreviewToken()
    expect(previewTokenMatches(token, token)).toBe(true)
    expect(previewTokenMatches(token.slice(0, -1) + 'x', token)).toBe(false)
    // A prefix must not match, or the token is guessable byte by byte.
    expect(previewTokenMatches(token.slice(0, 8), token)).toBe(false)
  })

  it('refuses when nothing is stored, rather than matching an empty value', () => {
    for (const stored of [null, undefined, '']) {
      expect(previewTokenMatches('anything', stored)).toBe(false)
    }
    expect(previewTokenMatches('', 'a-real-token')).toBe(false)
  })
})

describe('RSS feed', () => {
  const feed = renderRssFeed({
    siteTitle: 'Acme & Co',
    siteDescription: 'Notes on <winning> work',
    origin: 'https://example.com/',
    items: [{
      title: 'Quotes & estimates: what to send',
      slug: 'quotes-and-estimates',
      excerpt: 'A short piece about "pricing" <clearly>',
      publishedAt: new Date('2026-03-02T09:00:00Z'),
      category: 'Sales & marketing',
    }],
  })

  it('escapes every field, so one ampersand does not break the feed', () => {
    expect(feed).toContain('Acme &amp; Co')
    expect(feed).toContain('Quotes &amp; estimates')
    expect(feed).toContain('Sales &amp; marketing')
    expect(feed).not.toMatch(/<title>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/)
    expect(feed).not.toContain('<winning>')
  })

  it('builds absolute links from the configured origin, with no double slash', () => {
    expect(feed).toContain('<link>https://example.com/blog</link>')
    expect(feed).toContain('https://example.com/blog/quotes-and-estimates')
    expect(feed).not.toContain('example.com//')
  })

  it('emits a valid RSS envelope with a self link and RFC-822 dates', () => {
    expect(feed).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    expect(feed).toContain('<rss version="2.0"')
    expect(feed).toContain('rel="self"')
    // Aggregators reject an ISO date here.
    expect(feed).toMatch(/<pubDate>\w{3}, \d{2} \w{3} \d{4}/)
  })

  it('survives an empty blog', () => {
    const empty = renderRssFeed({ siteTitle: 'Blog', siteDescription: '', origin: 'https://example.com', items: [] })
    expect(empty).toContain('</channel>')
    expect(empty).not.toContain('<item>')
  })
})
