import { Schema, model } from 'mongoose'

/**
 * An invoice, as the platform operator sees it.
 *
 * The system had a Subscription and a Stripe billing portal and nothing in
 * between: an administrator answering "why has this customer not paid" had to
 * open Stripe, find the customer by email, and hope the email matched. There
 * was no record on this side at all, so a failed payment was invisible to
 * support until the customer complained.
 *
 * These records MIRROR Stripe; they do not replace it. Stripe remains the
 * authority on what was charged and collected — this is a queryable local copy
 * so the admin surface can list, filter and reconcile without a round trip, and
 * so support can see payment state without being given Stripe access.
 */

export const invoiceStatuses = ['draft', 'open', 'paid', 'uncollectible', 'void'] as const
export type InvoiceStatus = typeof invoiceStatuses[number]

const InvoiceLineSchema = new Schema({
  description: { type: String, required: true, maxlength: 300 },
  quantity: { type: Number, default: 1, min: 0 },
  /** Minor units, as everywhere else money is stored. */
  unitAmountMinorUnits: { type: Number, required: true },
  amountMinorUnits: { type: Number, required: true },
  /** Set when the line is metered overage rather than subscription fee. */
  metric: { type: String, default: null },
}, { _id: false })

const InvoiceSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  /** Stripe's identifier. Unique and sparse: a comped invoice has none. */
  stripeInvoiceId: { type: String, unique: true, sparse: true, index: true },
  number: { type: String, maxlength: 60, index: true },
  status: { type: String, enum: invoiceStatuses, default: 'draft', index: true },

  currency: { type: String, uppercase: true, minlength: 3, maxlength: 3, default: 'USD' },
  subtotalMinorUnits: { type: Number, default: 0 },
  taxMinorUnits: { type: Number, default: 0 },
  totalMinorUnits: { type: Number, default: 0 },
  amountPaidMinorUnits: { type: Number, default: 0 },
  amountRefundedMinorUnits: { type: Number, default: 0 },

  lines: { type: [InvoiceLineSchema], default: [] },

  periodStart: Date,
  periodEnd: Date,
  dueAt: Date,
  paidAt: Date,
  voidedAt: Date,

  /**
   * Why a payment failed, in the provider's own words.
   *
   * Stored verbatim rather than mapped to an internal code: a support agent
   * needs to read "the card was declined by the issuer" and tell the customer
   * to call their bank, and any mapping we invent will eventually disagree with
   * what the customer sees on their statement.
   */
  lastPaymentError: { type: String, default: null, maxlength: 500 },
  attemptCount: { type: Number, default: 0, min: 0 },

  /** Set when an operator wrote the invoice off deliberately. */
  compedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  compedReason: { type: String, maxlength: 500 },

  hostedInvoiceUrl: { type: String, maxlength: 500 },
}, { timestamps: true })

InvoiceSchema.index({ organizationId: 1, createdAt: -1 })
InvoiceSchema.index({ status: 1, dueAt: 1 })

export default model('Invoice', InvoiceSchema)
