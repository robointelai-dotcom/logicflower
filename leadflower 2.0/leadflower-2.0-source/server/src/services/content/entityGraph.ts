/**
 * The structured-data graph for an article.
 *
 * WHY A GRAPH RATHER THAN A LIST OF BLOCKS
 *
 * A page that emits an Article block, then a separate Person block, then a
 * separate FAQ block, states three unrelated facts. A retrieval system reading
 * it has to guess that the Person is the author of the Article. A single
 * `@graph` with `@id` references states the relationships explicitly, and the
 * relationships are the part that carries meaning.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO
 *
 * It will not emit a claim the database cannot support. An author with no
 * recorded credentials produces a bare `Person` node with a name, not an
 * invented one; an article with no reviewer produces no review claim at all.
 * Structured data is a set of assertions to search engines and retrieval
 * systems about who wrote something and whether it was checked — asserting a
 * review that never happened is not an SEO technique, it is a false statement
 * about editorial process, and it is the kind that gets a site penalised.
 */

export interface AuthorEntity {
  name: string
  jobTitle?: string
  /** Subjects this person can credibly write about. */
  knowsAbout?: string[]
  alumniOf?: string[]
  /** Verified profiles. Used for `sameAs`, so only real, public URLs belong here. */
  sameAs?: string[]
  description?: string
  imageUrl?: string
}

export interface AnswerCapsule {
  /** The heading this capsule answers. */
  question: string
  /** 40-60 words. Self-contained: it must make sense lifted out of the page. */
  answer: string
}

export interface EditorialLog {
  datePublished?: Date | null
  dateModified?: Date | null
  dateReviewed?: Date | null
  reviewedByName?: string
  reviewedByTitle?: string
}

export interface GraphInput {
  title: string
  description: string
  canonicalUrl: string
  imageUrl?: string | null
  articleSection?: string
  keywords?: string[]
  wordCount?: number
  author?: AuthorEntity | null
  organizationName?: string
  organizationUrl?: string
  organizationLogoUrl?: string
  editorial: EditorialLog
  capsules?: AnswerCapsule[]
  /** Products or services this article is genuinely about. */
  aboutEntities?: Array<{ name: string; url?: string; description?: string }>
}

/** How long before an article is treated as needing a freshness review. */
export const FRESHNESS_REVIEW_WEEKS = 13

export interface FreshnessState {
  weeksSinceReview: number | null
  needsReview: boolean
  reason: string
}

/**
 * Whether an article is due a freshness check.
 *
 * Measured from the last REVIEW, not the last edit. Fixing a typo is not a
 * re-examination of whether the advice still holds, and treating it as one is
 * how a stale article convinces everybody it is current.
 */
export function assessFreshness(editorial: EditorialLog, now: Date = new Date()): FreshnessState {
  const anchor = editorial.dateReviewed ?? editorial.datePublished
  if (!anchor) {
    return { weeksSinceReview: null, needsReview: false, reason: 'Not published yet.' }
  }
  const weeks = Math.floor((now.getTime() - new Date(anchor).getTime()) / (7 * 86_400_000))
  if (!editorial.dateReviewed) {
    return {
      weeksSinceReview: weeks,
      needsReview: weeks >= FRESHNESS_REVIEW_WEEKS,
      reason: weeks >= FRESHNESS_REVIEW_WEEKS
        ? `Published ${weeks} weeks ago and never reviewed since.`
        : 'Published recently.',
    }
  }
  return {
    weeksSinceReview: weeks,
    needsReview: weeks >= FRESHNESS_REVIEW_WEEKS,
    reason: weeks >= FRESHNESS_REVIEW_WEEKS
      ? `Last reviewed ${weeks} weeks ago.`
      : `Reviewed ${weeks} week${weeks === 1 ? '' : 's'} ago.`,
  }
}

function iso(value: Date | null | undefined): string | undefined {
  return value ? new Date(value).toISOString() : undefined
}

/** Drop empty values, so the graph contains no bare or null properties. */
function compact<T extends Record<string, unknown>>(node: T): T {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && !value.length) continue
    if (typeof value === 'string' && !value.trim()) continue
    output[key] = value
  }
  return output as T
}

/**
 * Build the nested graph.
 *
 * Every node carries an `@id` derived from the canonical URL, so the article,
 * its author, the publisher and the FAQ are one connected structure rather than
 * four assertions that happen to share a page.
 */
export function buildArticleGraph(input: GraphInput): Record<string, unknown> {
  const base = input.canonicalUrl.replace(/#.*$/, '')
  const ids = {
    article: `${base}#article`,
    author: `${base}#author`,
    organization: `${input.organizationUrl || base}#organization`,
    website: `${input.organizationUrl || base}#website`,
    faq: `${base}#faq`,
  }

  const nodes: Array<Record<string, unknown>> = []

  const organization = compact({
    '@type': 'Organization',
    '@id': ids.organization,
    name: input.organizationName,
    url: input.organizationUrl,
    logo: input.organizationLogoUrl ? compact({ '@type': 'ImageObject', url: input.organizationLogoUrl }) : undefined,
  })
  if (organization.name) nodes.push(organization)

  let authorRef: Record<string, unknown> | undefined
  if (input.author?.name) {
    // Credentials are emitted only where they exist. An author node claiming
    // expertise nobody recorded is a fabrication, not optimisation.
    nodes.push(compact({
      '@type': 'Person',
      '@id': ids.author,
      name: input.author.name,
      jobTitle: input.author.jobTitle,
      description: input.author.description,
      image: input.author.imageUrl,
      knowsAbout: input.author.knowsAbout,
      alumniOf: input.author.alumniOf?.map((name) => compact({ '@type': 'Organization', name })),
      sameAs: input.author.sameAs,
      worksFor: organization.name ? { '@id': ids.organization } : undefined,
    }))
    authorRef = { '@id': ids.author }
  }

  const article = compact({
    '@type': 'TechArticle',
    '@id': ids.article,
    headline: input.title,
    description: input.description,
    url: input.canonicalUrl,
    mainEntityOfPage: { '@type': 'WebPage', '@id': base },
    image: input.imageUrl ? [input.imageUrl] : undefined,
    datePublished: iso(input.editorial.datePublished),
    dateModified: iso(input.editorial.dateModified ?? input.editorial.datePublished),
    author: authorRef,
    publisher: organization.name ? { '@id': ids.organization } : undefined,
    articleSection: input.articleSection,
    keywords: input.keywords,
    wordCount: input.wordCount,
    inLanguage: 'en',
    // What the article is about, linked to the product entities rather than
    // restated as loose keywords.
    about: input.aboutEntities?.length
      ? input.aboutEntities.map((entity) => compact({ '@type': 'Thing', name: entity.name, url: entity.url, description: entity.description }))
      : undefined,
    // A reviewer is claimed ONLY when one was recorded.
    ...(input.editorial.dateReviewed && input.editorial.reviewedByName
      ? {
        reviewedBy: compact({
          '@type': 'Person',
          name: input.editorial.reviewedByName,
          jobTitle: input.editorial.reviewedByTitle,
        }),
      }
      : {}),
  })
  nodes.push(article)

  // The capsules are the article's own answers, so the FAQ is bound to it by id
  // rather than floating as an unrelated block.
  const capsules = (input.capsules ?? []).filter((capsule) => capsule.question.trim() && capsule.answer.trim())
  if (capsules.length) {
    nodes.push({
      '@type': 'FAQPage',
      '@id': ids.faq,
      mainEntity: capsules.map((capsule) => ({
        '@type': 'Question',
        name: capsule.question,
        acceptedAnswer: { '@type': 'Answer', text: capsule.answer },
      })),
      isPartOf: { '@id': ids.article },
    })
  }

  return { '@context': 'https://schema.org', '@graph': nodes }
}

/* ----------------------------------------------------------- search intent */

export type SearchIntent = 'informational' | 'commercial' | 'transactional' | 'navigational'

export interface IntentGuidance {
  /** What this article should be trying to do. */
  goal: string
  /** Checks worth passing before publishing. */
  checks: Array<{ label: string; met: boolean; advice: string }>
}

/**
 * Turn a declared search intent into something the editor acts on.
 *
 * The field previously existed as a label nobody used. An intent is only
 * worth recording if it changes what the article contains: somebody arriving
 * from "what is missed call text back" wants an answer in the first screen,
 * and somebody arriving from "missed call text back pricing" wants to know
 * what it costs and how to start. The same article cannot serve both well.
 *
 * These are prompts, not gates. Publishing is never blocked on them — an
 * editor who has a reason to ignore one is usually right, and a rule that
 * blocks publication gets worked around rather than followed.
 */
export function guidanceForIntent(input: {
  intent: SearchIntent | null | undefined
  capsuleCount: number
  hasInformationGain: boolean
  wordCount: number
  bodyText: string
}): IntentGuidance | null {
  if (!input.intent) return null
  const body = String(input.bodyText || '').toLowerCase()
  const mentions = (...terms: string[]) => terms.some((term) => body.includes(term))

  switch (input.intent) {
    case 'informational':
      return {
        goal: 'Answer the question in the first screen, then earn the rest of the read.',
        checks: [
          {
            label: 'Has an answer capsule',
            met: input.capsuleCount > 0,
            advice: 'Somebody searching a question wants the answer before they scroll. A capsule gives it to them, and gives a retrieval system something to quote.',
          },
          {
            label: 'Says something only you can say',
            met: input.hasInformationGain,
            advice: 'An informational piece that repeats what is already on the first page of results has no reason to outrank it. Record what this is based on.',
          },
          {
            label: 'Long enough to be useful',
            met: input.wordCount >= 600,
            advice: 'Under about 600 words an explanatory article usually leaves the follow-up question unanswered.',
          },
        ],
      }
    case 'commercial':
      return {
        goal: 'Help somebody choose. They are comparing, not learning.',
        checks: [
          {
            label: 'Compares against something',
            met: mentions('versus', ' vs ', 'compared', 'alternative', 'instead of'),
            advice: 'Somebody at this stage is weighing options. An article that never mentions the alternative is not helping them decide.',
          },
          {
            label: 'States a limitation',
            met: mentions('however', 'not suitable', 'downside', 'trade-off', 'does not', 'cannot', 'limitation'),
            advice: 'A comparison with no drawbacks reads as marketing and is trusted accordingly. Name what this is not good for.',
          },
          {
            label: 'Has an answer capsule',
            met: input.capsuleCount > 0,
            advice: 'A summary of the recommendation is what gets quoted in a comparison result.',
          },
        ],
      }
    case 'transactional':
      return {
        goal: 'Remove whatever is between them and starting.',
        checks: [
          {
            label: 'Says what it costs',
            met: mentions('price', 'pricing', 'cost', 'free', 'per month'),
            advice: 'Somebody ready to buy will leave to find the price. Say it, or say plainly why you cannot.',
          },
          {
            label: 'Says how to start',
            met: mentions('sign up', 'get started', 'start free', 'book a', 'try it'),
            advice: 'End with the next step. At this stage a missing call to action is the whole failure.',
          },
        ],
      }
    case 'navigational':
      return {
        goal: 'Get them where they were going, quickly.',
        checks: [
          {
            label: 'Short enough to scan',
            met: input.wordCount <= 800,
            advice: 'Somebody who searched for a specific page wants that page. Long prose in the way is friction.',
          },
        ],
      }
    default:
      return null
  }
}

/* ------------------------------------------------------- capsule validation */

export const CAPSULE_MIN_WORDS = 40
export const CAPSULE_MAX_WORDS = 60

export interface CapsuleCheck {
  words: number
  ok: boolean
  issues: string[]
}

/**
 * Check an answer capsule.
 *
 * The word bounds are not arbitrary house style. A capsule exists to be lifted
 * whole and quoted; under forty words it usually omits the qualifier that makes
 * it true, and over sixty it gets truncated mid-thought by whatever is quoting
 * it. Both failures put words in your mouth.
 */
export function checkCapsule(answer: string): CapsuleCheck {
  const text = String(answer ?? '').trim()
  const words = text ? text.split(/\s+/).length : 0
  const issues: string[] = []

  if (words < CAPSULE_MIN_WORDS) issues.push(`Too short at ${words} words. Aim for ${CAPSULE_MIN_WORDS}–${CAPSULE_MAX_WORDS}, or the qualifier that makes it true gets left out.`)
  if (words > CAPSULE_MAX_WORDS) issues.push(`Too long at ${words} words. Over ${CAPSULE_MAX_WORDS} it gets truncated mid-thought by whatever quotes it.`)

  // A capsule that begins "As mentioned above" cannot survive being lifted out.
  if (/^(as (mentioned|noted|discussed)|as (we|i) (said|explained)|this|these|that|those|it)\b/i.test(text)) {
    issues.push('Starts with a back-reference. A capsule is quoted on its own, away from whatever it refers to.')
  }

  return { words, ok: !issues.length, issues }
}
