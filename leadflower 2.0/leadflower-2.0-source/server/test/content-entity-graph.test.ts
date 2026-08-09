import { describe, expect, it } from 'vitest'
import {
  assessFreshness, buildArticleGraph, CAPSULE_MAX_WORDS, CAPSULE_MIN_WORDS,
  checkCapsule, FRESHNESS_REVIEW_WEEKS,
} from '../src/services/content/entityGraph'
import { renderFigure } from '../src/services/content/media'

const BASE = {
  title: 'How follow-up timing changes conversion',
  description: 'What we measured across 40,000 enquiries.',
  canonicalUrl: 'https://example.com/blog/follow-up-timing',
  organizationName: 'Acme',
  organizationUrl: 'https://example.com',
  editorial: { datePublished: new Date('2026-01-10'), dateModified: new Date('2026-02-01') },
}

describe('entity graph', () => {
  it('connects the nodes by id rather than listing them side by side', () => {
    // Three unrelated blocks state three facts. A graph states the
    // relationships, and the relationships are what carry meaning.
    const graph: any = buildArticleGraph({
      ...BASE,
      author: { name: 'Priya Raman', jobTitle: 'Head of Engineering', knowsAbout: ['CRM automation'] },
    })
    const article = graph['@graph'].find((node: any) => node['@type'] === 'TechArticle')
    const person = graph['@graph'].find((node: any) => node['@type'] === 'Person')
    expect(article.author['@id']).toBe(person['@id'])
    expect(article.publisher['@id']).toBe(graph['@graph'].find((node: any) => node['@type'] === 'Organization')['@id'])
    expect(person.worksFor['@id']).toBe(article.publisher['@id'])
  })

  it('emits author credentials only where they were recorded', () => {
    const bare: any = buildArticleGraph({ ...BASE, author: { name: 'Priya Raman' } })
    const person = bare['@graph'].find((node: any) => node['@type'] === 'Person')
    // A node claiming expertise nobody entered is a fabrication, not SEO.
    expect(person.knowsAbout).toBeUndefined()
    expect(person.alumniOf).toBeUndefined()
    expect(person.sameAs).toBeUndefined()
    expect(person.name).toBe('Priya Raman')
  })

  it('never claims a review that did not happen', () => {
    const unreviewed: any = buildArticleGraph(BASE)
    const article = unreviewed['@graph'].find((node: any) => node['@type'] === 'TechArticle')
    expect(article.reviewedBy).toBeUndefined()

    const reviewed: any = buildArticleGraph({
      ...BASE,
      editorial: { ...BASE.editorial, dateReviewed: new Date('2026-03-01'), reviewedByName: 'Sam Okafor' },
    })
    expect(reviewed['@graph'].find((node: any) => node['@type'] === 'TechArticle').reviewedBy.name).toBe('Sam Okafor')
  })

  it('omits a reviewer named without a review date, and vice versa', () => {
    // Half a claim is still a claim about editorial process.
    const halfA: any = buildArticleGraph({ ...BASE, editorial: { ...BASE.editorial, reviewedByName: 'Sam Okafor' } })
    expect(halfA['@graph'].find((node: any) => node['@type'] === 'TechArticle').reviewedBy).toBeUndefined()
    const halfB: any = buildArticleGraph({ ...BASE, editorial: { ...BASE.editorial, dateReviewed: new Date() } })
    expect(halfB['@graph'].find((node: any) => node['@type'] === 'TechArticle').reviewedBy).toBeUndefined()
  })

  it('binds the FAQ to the article instead of floating it', () => {
    const graph: any = buildArticleGraph({
      ...BASE,
      capsules: [{ question: 'When should I follow up?', answer: 'Within five minutes.' }],
    })
    const faq = graph['@graph'].find((node: any) => node['@type'] === 'FAQPage')
    const article = graph['@graph'].find((node: any) => node['@type'] === 'TechArticle')
    expect(faq.isPartOf['@id']).toBe(article['@id'])
    expect(faq.mainEntity[0].acceptedAnswer.text).toBe('Within five minutes.')
  })

  it('emits no FAQ node when there are no capsules', () => {
    const graph: any = buildArticleGraph(BASE)
    expect(graph['@graph'].some((node: any) => node['@type'] === 'FAQPage')).toBe(false)
  })

  it('drops empty values rather than emitting null properties', () => {
    const graph: any = buildArticleGraph({ ...BASE, articleSection: '', keywords: [] })
    const article = graph['@graph'].find((node: any) => node['@type'] === 'TechArticle')
    expect('articleSection' in article).toBe(false)
    expect('keywords' in article).toBe(false)
    expect(JSON.stringify(graph)).not.toContain('null')
  })
})

describe('freshness', () => {
  it('measures from the last review, not the last edit', () => {
    // Fixing a typo is not a re-examination of whether the advice still holds.
    const stale = assessFreshness({
      datePublished: new Date('2025-01-01'),
      dateModified: new Date(),
      dateReviewed: new Date('2025-06-01'),
    }, new Date('2026-03-01'))
    expect(stale.needsReview).toBe(true)
    expect(stale.reason).toMatch(/Last reviewed/)
  })

  it('flags an old article that has never been reviewed', () => {
    const never = assessFreshness({ datePublished: new Date('2025-01-01') }, new Date('2026-03-01'))
    expect(never.needsReview).toBe(true)
    expect(never.reason).toMatch(/never been reviewed|never reviewed/)
  })

  it('leaves a recent article alone', () => {
    const fresh = assessFreshness({ datePublished: new Date('2026-02-20'), dateReviewed: new Date('2026-02-20') }, new Date('2026-03-01'))
    expect(fresh.needsReview).toBe(false)
  })

  it('says nothing about an unpublished draft', () => {
    expect(assessFreshness({}).needsReview).toBe(false)
  })

  it('uses a review window of a quarter', () => {
    expect(FRESHNESS_REVIEW_WEEKS).toBe(13)
  })
})

describe('answer capsules', () => {
  const good = Array(50).fill('word').join(' ')

  it('accepts a capsule inside the word bounds', () => {
    expect(checkCapsule(good).ok).toBe(true)
  })

  it('rejects one too short to carry its own qualifier', () => {
    const result = checkCapsule('Follow up fast.')
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toContain(String(CAPSULE_MIN_WORDS))
  })

  it('rejects one long enough to be truncated mid-thought', () => {
    const result = checkCapsule(Array(90).fill('word').join(' '))
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toContain(String(CAPSULE_MAX_WORDS))
  })

  it('rejects a capsule that cannot survive being lifted out', () => {
    // "As mentioned above" makes no sense once quoted away from the page.
    for (const opener of ['As mentioned above, ', 'This means that ', 'It follows that ']) {
      expect(checkCapsule(opener + good).ok).toBe(false)
    }
  })
})

describe('figure markup', () => {
  const figure = renderFigure({
    urls: { 'webp-480': '/i/a-480.webp', 'webp-960': '/i/a-960.webp', 'avif-480': '/i/a-480.avif' },
    widths: [480, 960],
    formats: ['avif', 'webp'],
    fallbackUrl: '/i/a.jpg',
    alt: 'A chart showing reply time against conversion',
    caption: 'Conversion falls sharply after the first five minutes.',
    originalWidth: 1200,
    originalHeight: 800,
  })

  it('offers modern formats before the fallback', () => {
    expect(figure.indexOf('image/avif')).toBeLessThan(figure.indexOf('image/webp'))
    expect(figure.indexOf('image/webp')).toBeLessThan(figure.indexOf('<img'))
  })

  it('declares intrinsic size so the page does not jump', () => {
    expect(figure).toContain('width="1200"')
    expect(figure).toContain('height="800"')
  })

  it('keeps alt and caption distinct', () => {
    // Duplicating one into the other makes a screen reader say it twice.
    expect(figure).toContain('alt="A chart showing reply time against conversion"')
    expect(figure).toContain('Conversion falls sharply')
    expect(figure).not.toContain('alt="Conversion falls sharply')
  })

  it('escapes attributes', () => {
    const hostile = renderFigure({
      urls: {}, widths: [], formats: [], fallbackUrl: '/i/a.jpg',
      alt: '" onerror="alert(1)', caption: '<script>alert(1)</script>',
    })
    expect(hostile).not.toContain('onerror="alert')
    expect(hostile).not.toContain('<script>')
  })

  it('emits no figcaption when there is nothing to caption', () => {
    const plain = renderFigure({ urls: {}, widths: [], formats: [], fallbackUrl: '/i/a.jpg', alt: 'A chart' })
    expect(plain).not.toContain('<figcaption>')
  })
})
