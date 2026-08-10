/**
 * Drafting an article from work the business actually did.
 *
 * WHY THIS IS NOT "AI BLOGGING"
 *
 * Google's scaled-content-abuse policy targets content produced at volume
 * primarily to rank, and it explicitly does not matter whether a person or a
 * machine wrote it. Sites doing that have been deindexed rather than demoted.
 *
 * The asymmetry matters: the risk sits on the CUSTOMER'S domain, not ours. A
 * plumber who disappears from Google because of a feature we shipped loses his
 * livelihood, and he would be right to blame us.
 *
 * The defence is not caution about wording. It is that the article is built
 * from something a language model cannot fabricate — what this business did
 * last month. That is also why competitors cannot copy it: the jobs, the
 * questions and the reviews are in a CRM only we hold.
 *
 * Generic:      "10 tips for choosing a plumber."  Worthless; everyone has it.
 * From the work: "We replaced a boiler in a 1930s terrace in Adyar last week.
 *                Here is what it cost and what we found behind the old unit."
 */

export interface JobSource {
  title: string
  /** What kind of work. */
  service?: string
  place?: string
  valueMinorUnits?: number
  currency?: string
  closedAt?: Date | null
  notes?: string[]
}

export interface QuestionSource {
  question: string
  askedCount: number
}

export interface ReviewSource {
  rating: number
  body: string
}

export interface DraftSources {
  jobs: JobSource[]
  questions: QuestionSource[]
  reviews: ReviewSource[]
}

export interface DraftRefusal {
  ok: false
  reason: string
}

export interface DraftBrief {
  ok: true
  /** The specific job this article is about. */
  job: JobSource
  suggestedTitle: string
  /** What the writer must cover, drawn from real material. */
  points: string[]
  /** Questions to answer inside the piece, taken from the inbox. */
  questions: string[]
  /** Words customers themselves used, so the article sounds like the trade. */
  vocabulary: string[]
  /** True where the trade needs a named human reviewer before publishing. */
  requiresReview: boolean
  reviewReason?: string
}

/**
 * Trades where an article can constitute advice.
 *
 * Not a legal classification — a prompt to involve a named human, using the
 * `dateReviewed` and `reviewedByName` fields the article schema already has.
 */
const REGULATED_TYPES = new Set([
  'Dentist', 'Physician', 'MedicalClinic', 'Optician', 'Pharmacy', 'VeterinaryCare',
  'LegalService', 'AccountingService', 'InsuranceAgency',
])

/** How many articles a business should publish in a month. */
export const MAX_ARTICLES_PER_MONTH = 2

export interface DraftRequest {
  sources: DraftSources
  businessType?: string
  publishedThisMonth: number
  maxPerMonth?: number
}

/**
 * Decide whether there is an article here, and what it should contain.
 *
 * Returns a REFUSAL rather than a thin draft when there is nothing real to
 * write about. That refusal is the whole safety mechanism, and it is why it is
 * not configurable: made optional, somebody switches it off and generates
 * filler on a customer's domain.
 */
export function briefFromWork(request: DraftRequest): DraftBrief | DraftRefusal {
  const max = request.maxPerMonth ?? MAX_ARTICLES_PER_MONTH

  if (request.publishedThisMonth >= max) {
    return {
      ok: false,
      reason: `You have already published ${request.publishedThisMonth} article${request.publishedThisMonth === 1 ? '' : 's'} this month. Publishing more often is the pattern search engines penalise, so we stop at ${max}.`,
    }
  }

  const jobs = (request.sources.jobs ?? []).filter((job) => job.title?.trim())
  if (!jobs.length) {
    return {
      ok: false,
      reason: 'Nothing worth writing about this month — no completed work to draw on. An article about nothing in particular is the kind search engines have spent two years demoting.',
    }
  }

  /*
   * The most interesting job, not the most recent.
   *
   * Value is a rough proxy for substance: a bigger job usually had more to it,
   * and there is more to say. Notes break the tie, because a job somebody wrote
   * notes about is one where something happened.
   */
  const job = [...jobs].sort((a, b) => {
    const notes = (b.notes?.length ?? 0) - (a.notes?.length ?? 0)
    if (notes !== 0) return notes
    return Number(b.valueMinorUnits ?? 0) - Number(a.valueMinorUnits ?? 0)
  })[0]!

  const questions = (request.sources.questions ?? [])
    .filter((entry) => entry.askedCount > 1)
    .sort((a, b) => b.askedCount - a.askedCount)
    .slice(0, 3)
    .map((entry) => entry.question)

  // Words customers themselves used. Keeps the article sounding like the trade
  // rather than like marketing copy about the trade.
  const vocabulary = [...new Set(
    (request.sources.reviews ?? [])
      .filter((review) => review.rating >= 4 && review.body)
      .flatMap((review) => review.body.toLowerCase().match(/\b[a-z]{5,}\b/g) ?? [])
      .filter((word) => !['thanks', 'thank', 'really', 'great', 'would', 'their', 'there'].includes(word)),
  )].slice(0, 12)

  const points: string[] = []
  if (job.place) points.push(`Where it was — ${job.place} — and anything about the property that mattered`)
  if (job.service) points.push(`What the job actually involved: ${job.service}`)
  points.push('What you found once you started, and whether it changed the quote')
  if (job.valueMinorUnits) points.push('What it cost, and what the price included')
  points.push('What somebody with the same problem should do first')
  for (const note of (job.notes ?? []).slice(0, 3)) points.push(`From your notes: ${note}`)

  const requiresReview = Boolean(request.businessType && REGULATED_TYPES.has(request.businessType))

  return {
    ok: true,
    job,
    suggestedTitle: job.place
      ? `${job.service || job.title} in ${job.place}: what it involved and what it cost`
      : `${job.service || job.title}: what it involved and what it cost`,
    points,
    questions,
    vocabulary,
    requiresReview,
    reviewReason: requiresReview
      ? 'This trade gives advice people act on. Somebody qualified must read and sign off the article before it is published, and their name is recorded with it.'
      : undefined,
  }
}

/**
 * Whether a finished draft may be published.
 *
 * Separate from drafting on purpose: a brief can be produced freely, but
 * publishing is the moment the customer's domain is at risk.
 */
export function canPublishDraft(input: {
  body: string
  requiresReview: boolean
  reviewedByName?: string
  dateReviewed?: Date | null
  approvedByUser: boolean
}): { ok: boolean; reason?: string } {
  if (!input.approvedByUser) {
    // Same discipline as sequences: nothing reaches the public until a person
    // says so.
    return { ok: false, reason: 'A person has to approve an article before it is published.' }
  }
  if (String(input.body ?? '').trim().split(/\s+/).length < 150) {
    return { ok: false, reason: 'Too short to be worth publishing. Under about 150 words it reads as filler, which is what gets a site demoted.' }
  }
  if (input.requiresReview && !(input.reviewedByName && input.dateReviewed)) {
    return {
      ok: false,
      reason: 'This trade gives advice people act on, so the article needs a named reviewer and a review date before it goes live.',
    }
  }
  return { ok: true }
}
