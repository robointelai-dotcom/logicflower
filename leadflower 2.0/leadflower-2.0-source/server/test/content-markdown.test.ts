import { describe, expect, it } from 'vitest'
import { escapeHtml, renderMarkdown, slugify, slugifyHeading } from '../src/services/content/markdown'

/**
 * The renderer's output goes onto a public, unauthenticated, indexed page. Its
 * one job is to never emit a tag it did not construct itself.
 */
describe('markdown rendering safety', () => {
  it('escapes raw HTML rather than passing it through', () => {
    const { html } = renderMarkdown('<script>alert(1)</script>\n\nHello.')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes markup inside a code block', () => {
    // Where somebody is most likely to paste markup they expect to SEE.
    const { html } = renderMarkdown('```\n<img src=x onerror=alert(1)>\n```')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
    expect(html).toContain('<pre><code>')
  })

  it('refuses a javascript: link and leaves it as text', () => {
    const { html } = renderMarkdown('[click me](javascript:alert(1))')
    expect(html).not.toContain('href="javascript')
    expect(html).not.toContain('<a href')
  })

  it('refuses a data: URL, which can carry a script inside an SVG', () => {
    const { html } = renderMarkdown('![x](data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pjwvc2NyaXB0Pjwvc3ZnPg==)')
    // No tag is emitted. The URL survives as inert visible text, which is
    // harmless and better than silently deleting an author's content — they can
    // see what was rejected and why.
    expect(html).not.toContain('<img')
    expect(html).not.toContain('src=')
  })

  it('refuses a protocol-relative URL', () => {
    // "//evil.example" inherits the page's scheme and leaves the site.
    const { html } = renderMarkdown('[go](//evil.example/path)')
    expect(html).not.toContain('<a href')
  })

  it('permits http, https, mailto and site-relative links', () => {
    for (const url of ['https://example.com', 'http://example.com', 'mailto:hi@example.com', '/pricing']) {
      expect(renderMarkdown(`[link](${url})`).html).toContain('<a href=')
    }
  })

  it('marks external links noopener, so the opened page cannot navigate the opener', () => {
    const external = renderMarkdown('[out](https://example.com)').html
    expect(external).toContain('rel="noopener nofollow"')
    // A site-relative link is our own page and needs neither.
    expect(renderMarkdown('[in](/pricing)').html).not.toContain('noopener')
  })

  it('escapes an image alt attribute', () => {
    const { html } = renderMarkdown('![" onerror="alert(1)](https://example.com/a.png)')
    expect(html).not.toContain('onerror="alert')
    expect(html).toContain('&quot;')
  })
})

describe('markdown structure', () => {
  it('renders headings with anchors and reports them for a contents list', () => {
    const { html, headings } = renderMarkdown('## First part\n\nText.\n\n### Detail\n\nMore.')
    expect(html).toContain('<h2 id="first-part">')
    expect(html).toContain('<h3 id="detail">')
    expect(headings).toEqual([
      { level: 2, text: 'First part', id: 'first-part' },
      { level: 3, text: 'Detail', id: 'detail' },
    ])
  })

  it('gives repeated headings distinct anchors', () => {
    // Otherwise every anchor after the first jumps to the wrong place.
    const { headings } = renderMarkdown('## Setup\n\na\n\n## Setup\n\nb\n\n## Setup\n\nc')
    expect(new Set(headings.map((heading) => heading.id)).size).toBe(3)
  })

  it('renders lists, quotes, rules and inline formatting', () => {
    expect(renderMarkdown('- one\n- two').html).toContain('<ul>')
    expect(renderMarkdown('1. one\n2. two').html).toContain('<ol>')
    expect(renderMarkdown('> quoted').html).toContain('<blockquote>')
    expect(renderMarkdown('---').html).toContain('<hr>')
    expect(renderMarkdown('**bold**').html).toContain('<strong>bold</strong>')
    expect(renderMarkdown('`code`').html).toContain('<code>code</code>')
  })

  it('estimates reading time and never returns zero', () => {
    expect(renderMarkdown('one word').readingMinutes).toBe(1)
    expect(renderMarkdown('').readingMinutes).toBe(1)
    expect(renderMarkdown(Array(600).fill('word').join(' ')).readingMinutes).toBe(3)
  })

  it('survives empty and malformed input', () => {
    for (const input of ['', '   ', '```unterminated', '## ', '[](', '![](']) {
      expect(() => renderMarkdown(input)).not.toThrow()
    }
  })
})

describe('slugs', () => {
  it('produces clean URL segments', () => {
    expect(slugify('How to Win More Jobs in 2026')).toBe('how-to-win-more-jobs-in-2026')
    expect(slugify("A Plumber's Guide")).toBe('a-plumbers-guide')
    expect(slugify('  Spaces   Everywhere  ')).toBe('spaces-everywhere')
  })

  it('returns empty for input with nothing usable, rather than a stray dash', () => {
    for (const input of ['', '!!!', '---', '   ']) expect(slugify(input)).toBe('')
  })

  it('bounds length so a long title cannot produce an unusable URL', () => {
    expect(slugify('word '.repeat(60)).length).toBeLessThanOrEqual(80)
    expect(slugifyHeading('word '.repeat(60)).length).toBeLessThanOrEqual(60)
  })
})

describe('escapeHtml', () => {
  it('escapes every character that can break out of markup or an attribute', () => {
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  it('escapes ampersands first, so entities are not double-broken', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})
