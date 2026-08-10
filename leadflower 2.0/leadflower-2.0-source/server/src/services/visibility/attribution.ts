/**
 * Where the work actually came from.
 *
 * This is the reason the module exists. Every SEO tool stops at the click; this
 * carries on to the job and its value, because LogicFlower owns the phone call,
 * the missed-call text back, the booking and the deal.
 *
 * THE DECISIONS, MADE DELIBERATELY
 *
 * They are stated here rather than buried, because getting them wrong produces
 * a report that is confidently misleading — which is worse than no report.
 *
 * FIRST TOUCH, NOT LAST. A plumber's customer searches, rings, thinks about it
 * for a week, then books. Last-touch attribution credits "direct" and tells him
 * his listing does nothing, which is the opposite of the truth.
 *
 * A NINETY-DAY WINDOW. Longer than e-commerce would use, because a
 * quote-to-job cycle is longer. Configurable, because a roofer and a
 * hairdresser are not the same business.
 *
 * NEVER GUESS. "Don't know" is a real answer and gets its own row. A report
 * that attributes 100% of revenue is one nobody should trust, and an operator
 * who later discovers it was guessing stops believing the rest of the product.
 */

export const ATTRIBUTION_WINDOW_DAYS = 90

export type VisibilitySource =
  | 'google_listing'
  | 'organic_search'
  | 'website'
  | 'referral'
  | 'paid'
  | 'direct'
  | 'unknown'

export const SOURCE_LABELS: Readonly<Record<VisibilitySource, string>> = Object.freeze({
  google_listing: 'Google listing',
  organic_search: 'Google search',
  website: 'Your website',
  referral: 'Someone else\u2019s website',
  paid: 'Paid ads',
  direct: 'Came to you directly',
  unknown: 'Don\u2019t know',
})

export interface AttributionRow {
  source: VisibilitySource
  label: string
  jobs: number
  valueMinorUnits: number
  /** How many of these arrived as a call nobody answered. */
  missedCalls: number
}

export interface AttributionReport {
  from: string
  to: string
  currency: string
  totals: { jobs: number; valueMinorUnits: number; missedCalls: number }
  rows: AttributionRow[]
  queries: Array<{ query: string; clicks: number; jobs: number }>
  /**
   * True when the workspace has no closed work at all in the period.
   *
   * The screen must say "nothing to show yet" rather than render zeros. Zeros
   * read as a broken report; an empty state reads as an empty month.
   */
  empty: boolean
  /** Stated on the screen, because an unexplained method is not trustworthy. */
  method: string
}

interface Models {
  Contact: any
  ContactActivity: any
  Deal: any
}

/**
 * The first source recorded for a contact, within the window.
 *
 * Returns `unknown` when nothing was recorded. It does NOT fall back to
 * `direct` — "we do not know" and "they came directly" are different facts, and
 * conflating them inflates whichever channel the fallback names.
 */
export async function firstTouchFor(input: {
  organizationId: string
  contactId: string
  before: Date
  windowDays?: number
  models: Pick<Models, 'ContactActivity'>
}): Promise<{ source: VisibilitySource; query?: string; landingPage?: string }> {
  const windowStart = new Date(input.before.getTime() - (input.windowDays ?? ATTRIBUTION_WINDOW_DAYS) * 86_400_000)

  const activity: any = await input.models.ContactActivity.findOne({
    organizationId: input.organizationId,
    contactId: input.contactId,
    visibilitySource: { $exists: true, $ne: null },
    createdAt: { $gte: windowStart, $lte: input.before },
  }).sort({ createdAt: 1 }).select('visibilitySource visibilityQuery visibilityLandingPage').lean()

  if (!activity?.visibilitySource) return { source: 'unknown' }
  return {
    source: activity.visibilitySource as VisibilitySource,
    query: activity.visibilityQuery || undefined,
    landingPage: activity.visibilityLandingPage || undefined,
  }
}

export async function attributionReport(input: {
  organizationId: string
  from: Date
  to: Date
  windowDays?: number
  models: Models
}): Promise<AttributionReport> {
  const { Deal, ContactActivity } = input.models

  // Won deals only. An open deal is not revenue and counting it would flatter
  // every channel equally.
  const deals: any[] = await Deal.find({
    organizationId: input.organizationId,
    status: 'won',
    updatedAt: { $gte: input.from, $lte: input.to },
  }).select('contactId valueMinorUnits currency updatedAt').limit(5_000).lean()

  const rows = new Map<VisibilitySource, AttributionRow>()
  const queryTotals = new Map<string, { clicks: number; jobs: number }>()
  let currency = 'USD'

  for (const deal of deals) {
    if (deal.currency) currency = deal.currency

    const touch = deal.contactId
      ? await firstTouchFor({
        organizationId: input.organizationId,
        contactId: String(deal.contactId),
        before: new Date(deal.updatedAt),
        windowDays: input.windowDays,
        models: { ContactActivity },
      })
      : { source: 'unknown' as VisibilitySource }

    const row = rows.get(touch.source) ?? {
      source: touch.source,
      label: SOURCE_LABELS[touch.source],
      jobs: 0,
      valueMinorUnits: 0,
      missedCalls: 0,
    }
    row.jobs += 1
    row.valueMinorUnits += Number(deal.valueMinorUnits || 0)

    // The event every competitor is blind to, and the one worth naming on the
    // screen: a call the owner could not answer that still became a job.
    if (deal.contactId) {
      const missed = await ContactActivity.countDocuments({
        organizationId: input.organizationId,
        contactId: deal.contactId,
        type: 'missed_call',
      })
      if (missed > 0) row.missedCalls += 1
    }

    rows.set(touch.source, row)

    if (touch.query) {
      const entry = queryTotals.get(touch.query) ?? { clicks: 0, jobs: 0 }
      entry.jobs += 1
      queryTotals.set(touch.query, entry)
    }
  }

  const ordered = [...rows.values()].sort((a, b) => {
    // "Don't know" sits last regardless of size. It is context, not a channel,
    // and putting it at the top would read as the best performing source.
    if (a.source === 'unknown') return 1
    if (b.source === 'unknown') return -1
    return b.valueMinorUnits - a.valueMinorUnits
  })

  const totals = ordered.reduce((sum, row) => ({
    jobs: sum.jobs + row.jobs,
    valueMinorUnits: sum.valueMinorUnits + row.valueMinorUnits,
    missedCalls: sum.missedCalls + row.missedCalls,
  }), { jobs: 0, valueMinorUnits: 0, missedCalls: 0 })

  return {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    currency,
    totals,
    rows: ordered,
    queries: [...queryTotals.entries()]
      .map(([query, entry]) => ({ query, clicks: entry.clicks, jobs: entry.jobs }))
      .sort((a, b) => b.jobs - a.jobs)
      .slice(0, 20),
    empty: totals.jobs === 0,
    method: `Counted from work marked won in this period, credited to the first source recorded for that customer within ${input.windowDays ?? ATTRIBUTION_WINDOW_DAYS} days before the job closed. Work we could not trace is shown as "Don't know" rather than assigned to a guess.`,
  }
}
