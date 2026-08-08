import { Schema, model } from 'mongoose'
import { quotaMetrics } from './UsageCounter'

/**
 * A sellable package.
 *
 * WHY THIS EXISTS
 *
 * The four plans were literals in `services/entitlements.ts` and
 * `routes/billing.ts`. Changing a price, a quota or a trial length meant a code
 * change, a review, a build and a deploy — so in practice the operator could
 * not run a promotion, could not offer a customer a bespoke quota, and could
 * not correct a limit without shipping. That is not a SaaS admin surface; it is
 * a constant.
 *
 * WHAT THIS IS NOT
 *
 * It is deliberately NOT a replacement for the `plan` enum on Subscription and
 * UsageCounter. Those four codes are woven through Stripe metadata, usage
 * counters already written, and plan policy. Ripping them out would be a data
 * migration across live billing records to gain nothing a customer can see.
 * Instead every package declares which `tier` it bills as, and the tier remains
 * the compatibility surface while the PACKAGE carries the commercial terms.
 *
 * VERSIONING AND GRANDFATHERING
 *
 * A package is never edited in place once customers are on it — editing would
 * silently reprice everyone who bought it. `code` identifies the product line
 * and `version` the revision; publishing a change creates a new version and
 * leaves existing subscribers pointed at theirs. `Organization.priceLocked`
 * already expresses the price guarantee; this expresses what they are locked
 * to.
 */

export const packageStatuses = ['draft', 'active', 'archived'] as const
export type PackageStatus = typeof packageStatuses[number]

export const billingIntervals = ['month', 'year'] as const
export type BillingInterval = typeof billingIntervals[number]

/** The tiers the rest of the system already understands. */
export const packageTiers = ['free', 'starter', 'agency', 'scale'] as const

const QuotaSchema = new Schema({
  metric: { type: String, enum: quotaMetrics, required: true },
  /**
   * Included units per billing period. Zero means the feature is unavailable on
   * this package; it does NOT mean unlimited — unlimited is expressed by
   * `unlimited`, because a limit of 0 meaning "infinite" is how quota bugs
   * become free compute.
   */
  included: { type: Number, required: true, min: 0 },
  unlimited: { type: Boolean, default: false },
  /** Price per unit beyond `included`, in minor units. Null refuses overage. */
  overageMinorUnits: { type: Number, default: null, min: 0 },
}, { _id: false })

const PackageSchema = new Schema({
  /** Stable product line identifier, e.g. `starter`. Unique with `version`. */
  code: { type: String, required: true, lowercase: true, trim: true, maxlength: 60, index: true },
  version: { type: Number, required: true, min: 1, default: 1 },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, maxlength: 1_000 },
  status: { type: String, enum: packageStatuses, default: 'draft', index: true },

  /** Which existing plan tier this package bills and meters as. */
  tier: { type: String, enum: packageTiers, required: true, index: true },

  /**
   * Price in MINOR units. Never a float: 19.99 stored as a double becomes
   * 19.989999999999998 and an invoice total that is a penny out is a support
   * ticket and, in some jurisdictions, a compliance problem.
   */
  priceMinorUnits: { type: Number, required: true, min: 0 },
  currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3, default: 'USD' },
  interval: { type: String, enum: billingIntervals, default: 'month' },
  trialDays: { type: Number, default: 0, min: 0, max: 365 },

  /** The Stripe price this package sells through, when it is sold online. */
  stripePriceId: { type: String, default: null, maxlength: 200 },

  quotas: { type: [QuotaSchema], default: [] },
  /** Named capability flags the product reads, e.g. `voice`, `social`. */
  features: { type: [String], default: [] },

  /** Seats included; null means seats are not counted on this package. */
  includedSeats: { type: Number, default: null, min: 1 },

  /**
   * Whether this package may be self-served at checkout. A bespoke package
   * negotiated for one customer is assigned by an administrator and must not
   * appear on the public pricing page.
   */
  publiclySelectable: { type: Boolean, default: false, index: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  publishedAt: Date,
  archivedAt: Date,
  /** Set when this version supersedes another, for migration reporting. */
  supersedesVersion: { type: Number, default: null },
}, { timestamps: true })

// One row per (code, version). Publishing a revision adds a version rather than
// mutating the row customers are already attached to.
PackageSchema.index({ code: 1, version: 1 }, { unique: true })
PackageSchema.index({ status: 1, publiclySelectable: 1 })

export default model('Package', PackageSchema)
