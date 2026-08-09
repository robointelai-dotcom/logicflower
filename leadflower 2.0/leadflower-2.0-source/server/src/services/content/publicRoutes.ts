/**
 * Every public page, for the sitemap.
 *
 * WHY THIS IS A LIST RATHER THAN A CRAWL
 *
 * The application is a single-page bundle; there is no directory of HTML files
 * to walk. So the sitemap is built from a declared list, and a declared list
 * drifts — somebody adds a page and forgets this file, and the page is never
 * indexed.
 *
 * `content-public-routes.test.ts` guards against exactly that: it reads the
 * client's router and its help content and fails when either contains a public
 * page missing here. The list is maintained by hand; the test makes forgetting
 * it a build failure rather than a silent absence from search.
 */

export interface PublicRoute {
  path: string
  /**
   * Relative importance, 0.0–1.0. Only meaningful as a comparison between our
   * own pages; it says nothing to a search engine about other sites.
   */
  priority: number
  changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly'
}

/** Marketing and support pages that are not database-driven. */
export const STATIC_PUBLIC_ROUTES: PublicRoute[] = [
  { path: '/', priority: 1.0, changefreq: 'weekly' },
  { path: '/blog', priority: 0.8, changefreq: 'daily' },
  { path: '/help', priority: 0.7, changefreq: 'weekly' },
]

/**
 * Help article slugs.
 *
 * Duplicated from `client/src/help/content.ts` because the server cannot import
 * from the client bundle. The test named above fails the build if the two lists
 * diverge, so the duplication cannot rot unnoticed.
 *
 * These are worth indexing: "why is activate greyed out" is a real search, and
 * the answer is one of these pages.
 */
export const HELP_ARTICLE_SLUGS = [
  'what-is-logicflower',
  'setting-up-your-workspace',
  'today-screen',
  'inbox-and-replies',
  'contacts-and-fields',
  'using-tags',
  'importing-contacts',
  'what-is-a-pipeline',
  'what-is-a-sequence',
  'writing-sequence-steps',
  'unknown-send-outcomes',
  'workflows-explained',
  'booking-pages',
  'collecting-reviews',
  'social-posting',
  'ai-calling-safety',
  'writing-a-voice-agent',
  'who-can-see-your-data',
  'agency-access',
  'managing-clients',
] as const

/**
 * Landing pages, each written for one search intent.
 *
 * Duplicated from `client/src/marketing/pages.ts` for the same reason as the
 * help slugs: the server cannot import from the client bundle, and the test
 * fails the build if the two lists diverge.
 */
export const MARKETING_ROUTES: PublicRoute[] = [
  { path: '/features/missed-call-text-back', priority: 0.9, changefreq: 'monthly' },
  { path: '/features/follow-up-automation', priority: 0.9, changefreq: 'monthly' },
  { path: '/solutions/crm-for-trades', priority: 0.8, changefreq: 'monthly' },
  { path: '/compare/logicflower-vs-per-action-pricing', priority: 0.8, changefreq: 'monthly' },
]

export function helpRoutes(): PublicRoute[] {
  return HELP_ARTICLE_SLUGS.map((slug) => ({
    path: `/help/${slug}`,
    priority: 0.5,
    changefreq: 'monthly' as const,
  }))
}

/**
 * Breadcrumbs for a page.
 *
 * Emitted as `BreadcrumbList` so a search result shows the trail rather than a
 * bare URL. Built from the path so it cannot describe a hierarchy the site does
 * not actually have.
 */
export function breadcrumbsFor(input: { path: string; title: string; origin: string }): Record<string, unknown> | null {
  const segments = input.path.split('/').filter(Boolean)
  if (!segments.length) return null

  const origin = input.origin.replace(/\/$/, '')
  const labels: Record<string, string> = { blog: 'Blog', help: 'Help centre' }
  const items: Array<{ name: string; url: string }> = [{ name: 'Home', url: `${origin}/` }]

  let walked = ''
  segments.forEach((segment, index) => {
    walked += `/${segment}`
    const last = index === segments.length - 1
    items.push({
      name: last ? input.title : (labels[segment] ?? segment.replace(/-/g, ' ')),
      url: `${origin}${walked}`,
    })
  })

  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  }
}
