import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { breadcrumbsFor, HELP_ARTICLE_SLUGS, helpRoutes, MARKETING_ROUTES, STATIC_PUBLIC_ROUTES } from '../src/services/content/publicRoutes'

const CLIENT = path.join(__dirname, '../../client/src')

/**
 * The sitemap is built from a hand-maintained list, because a single-page
 * bundle has no directory of HTML files to crawl. A hand-maintained list rots:
 * somebody adds a page, forgets the manifest, and the page is never indexed.
 *
 * These make forgetting it a build failure instead of a silent absence from
 * search results.
 */
describe('the sitemap manifest matches the application', () => {
  const helpContent = fs.readFileSync(path.join(CLIENT, 'help/content.ts'), 'utf8')
  const router = fs.readFileSync(path.join(CLIENT, 'main.tsx'), 'utf8')

  const actualHelpSlugs = [...helpContent.matchAll(/^\s*slug: '([a-z0-9-]+)',$/gm)].map((match) => match[1]!)

  it('lists every help article that exists', () => {
    for (const slug of actualHelpSlugs) {
      expect(HELP_ARTICLE_SLUGS, `help article "${slug}" is missing from the sitemap manifest`).toContain(slug as any)
    }
  })

  it('lists no help article that does not exist', () => {
    // A sitemap entry for a deleted page produces a 404 in Search Console and
    // erodes trust in the whole file.
    for (const slug of HELP_ARTICLE_SLUGS) {
      expect(actualHelpSlugs, `manifest lists "${slug}" but no such article exists`).toContain(slug)
    }
  })

  it('covers every public marketing route in the router', () => {
    // Public routes are those outside the authenticated shell. Parameterised
    // ones are covered by their database-driven entries instead.
    const publicPaths = ['/', '/blog', '/help']
    const declared = STATIC_PUBLIC_ROUTES.map((route) => route.path)
    for (const routePath of publicPaths) {
      expect(router).toContain(`path: '${routePath}'`)
      expect(declared, `${routePath} is public but absent from the sitemap`).toContain(routePath)
    }
  })

  it('lists every marketing landing page that exists', () => {
    const marketing = fs.readFileSync(path.join(CLIENT, 'marketing/pages.ts'), 'utf8')
    const slugs = [...marketing.matchAll(/^\s*slug: '([a-z0-9-]+)',$/gm)].map((match) => match[1]!)
    const declared = MARKETING_ROUTES.map((route) => route.path)
    for (const slug of slugs) {
      expect(declared.some((routePath) => routePath.endsWith(`/${slug}`)),
        `landing page "${slug}" is missing from the sitemap`).toBe(true)
    }
    expect(declared).toHaveLength(slugs.length)
  })

  it('gives the homepage the highest priority and help articles the lowest', () => {
    const home = STATIC_PUBLIC_ROUTES.find((route) => route.path === '/')!
    expect(home.priority).toBe(1.0)
    expect(helpRoutes()[0]!.priority).toBeLessThan(home.priority)
  })

  it('produces a route per help article', () => {
    expect(helpRoutes()).toHaveLength(HELP_ARTICLE_SLUGS.length)
    expect(helpRoutes()[0]!.path).toMatch(/^\/help\//)
  })
})

describe('breadcrumbs', () => {
  const origin = 'https://example.com'

  it('describes the real trail to an article', () => {
    const trail: any = breadcrumbsFor({ path: '/blog/follow-up-timing', title: 'Follow-up timing', origin })
    expect(trail['@type']).toBe('BreadcrumbList')
    expect(trail.itemListElement.map((item: any) => item.name)).toEqual(['Home', 'Blog', 'Follow-up timing'])
    expect(trail.itemListElement.map((item: any) => item.position)).toEqual([1, 2, 3])
  })

  it('builds absolute URLs with no double slash', () => {
    const trail: any = breadcrumbsFor({ path: '/help/using-tags', title: 'Tags', origin: 'https://example.com/' })
    for (const item of trail.itemListElement) {
      expect(item.item).toMatch(/^https:\/\/example\.com\//)
      expect(item.item).not.toContain('example.com//')
    }
  })

  it('emits nothing for the homepage, which has no trail', () => {
    // A single-item breadcrumb describes a hierarchy that does not exist.
    expect(breadcrumbsFor({ path: '/', title: 'Home', origin })).toBeNull()
  })
})
