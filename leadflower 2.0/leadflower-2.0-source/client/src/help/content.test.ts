import { describe, expect, it } from 'vitest'
import { articleBySlug, articleForRoute, HELP_ARTICLES, HELP_CATEGORIES, searchArticles } from './content'

/**
 * Help that contradicts the product is worse than no help, because somebody
 * follows it. These check the structure holds together.
 */
describe('help content', () => {
  it('has a unique slug per article', () => {
    const slugs = HELP_ARTICLES.map((article) => article.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('puts every article in a real category', () => {
    const categories = new Set(HELP_CATEGORIES.map((category) => category.id))
    for (const article of HELP_ARTICLES) expect(categories.has(article.category)).toBe(true)
  })

  it('leaves no category empty, so the index has no blank section', () => {
    for (const category of HELP_CATEGORIES) {
      expect(HELP_ARTICLES.some((article) => article.category === category.id)).toBe(true)
    }
  })

  it('gives every article the headings a reader expects', () => {
    for (const article of HELP_ARTICLES) {
      expect(article.title.length).toBeGreaterThan(3)
      expect(article.summary.length).toBeGreaterThan(10)
      expect(article.whatItIs.length).toBeGreaterThan(30)
      expect(article.whyUseIt.length).toBeGreaterThan(20)
      expect(article.steps.length).toBeGreaterThan(0)
    }
  })

  it('never links to an article that does not exist', () => {
    // A dead "related" link is the fastest way to lose a reader's trust.
    for (const article of HELP_ARTICLES) {
      for (const slug of article.related ?? []) {
        expect(articleBySlug(slug), `${article.slug} links to missing ${slug}`).toBeDefined()
      }
    }
  })

  it('never links an article to itself', () => {
    for (const article of HELP_ARTICLES) {
      expect(article.related ?? []).not.toContain(article.slug)
    }
  })

  it('maps each route to exactly one article, for the contextual link', () => {
    const routes = HELP_ARTICLES.map((article) => article.route).filter(Boolean)
    expect(new Set(routes).size).toBe(routes.length)
    expect(articleForRoute('/pipeline')?.slug).toBe('what-is-a-pipeline')
    expect(articleForRoute('/nowhere')).toBeUndefined()
  })

  it('finds articles by the phrase somebody would actually type', () => {
    // People search for what went wrong, not for the feature name — so search
    // covers problems and terminology too.
    expect(searchArticles('greyed out').length).toBeGreaterThan(0)
    expect(searchArticles('blocked').length).toBeGreaterThan(0)
    expect(searchArticles('buffer').length).toBeGreaterThan(0)
    expect(searchArticles('unknown outcome').length).toBeGreaterThan(0)
  })

  it('ignores a query too short to be meaningful', () => {
    for (const query of ['', ' ', 'a']) expect(searchArticles(query)).toEqual([])
  })

  it('covers the four screens that confused a real reviewer', () => {
    // Every one of these produced a "what is this for?" in the first
    // walkthrough of the deployed application.
    for (const route of ['/pipeline', '/sequences', '/voice', '/inbox']) {
      expect(articleForRoute(route), `no help for ${route}`).toBeDefined()
    }
  })
})
