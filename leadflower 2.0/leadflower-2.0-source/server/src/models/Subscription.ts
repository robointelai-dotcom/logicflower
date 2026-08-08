import { Schema, model } from 'mongoose'

const SubscriptionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, unique: true, index: true },
  stripeCustomerId: { type: String, unique: true, sparse: true, index: true },
  stripeSubscriptionId: { type: String, unique: true, sparse: true, index: true },
  plan: { type: String, enum: ['free', 'starter', 'agency', 'scale'], default: 'free' },
  status: { type: String, enum: ['inactive', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'], default: 'inactive', index: true },
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
  cancelAtPeriodEnd: { type: Boolean, default: false },
  seats: { type: Number, default: 1, min: 1 },

  /**
   * The package this subscription is actually on.
   *
   * `plan` above stays as the four-tier code the billing, metering and Stripe
   * paths already speak. `packageId` points at the commercial terms an
   * administrator can edit without a deploy. Null means the customer predates
   * package management and is served by the built-in defaults for their tier,
   * which is the behaviour they have today.
   */
  packageId: { type: Schema.Types.ObjectId, ref: 'Package', default: null, index: true },
  /** Pinned so a package revision never silently reprices an existing customer. */
  packageVersion: { type: Number, default: null },

  /**
   * Per-customer quota overrides, keyed by metric.
   *
   * The reason this exists: a customer rings up mid-month having hit a limit,
   * and the operator needs to raise it for that one customer now. Without this
   * the only options are to move them to a bigger plan they do not want or to
   * edit the package and raise it for everybody.
   *
   * An override always WINS over the package. It is recorded with who set it
   * and why, because "who gave this account ten times the quota" is a question
   * that gets asked during a revenue review.
   */
  quotaOverrides: {
    type: [{
      metric: { type: String, required: true },
      included: { type: Number, required: true, min: 0 },
      unlimited: { type: Boolean, default: false },
      reason: { type: String, maxlength: 300 },
      setBy: { type: Schema.Types.ObjectId, ref: 'User' },
      setAt: { type: Date, default: Date.now },
      expiresAt: { type: Date, default: null },
    }],
    default: [],
  },

  trialEndsAt: { type: Date, default: null, index: true },
  /** Administrative pause, distinct from Stripe's own paused status. */
  suspendedAt: { type: Date, default: null },
  suspendedReason: { type: String, maxlength: 300 },
}, { timestamps: true })

export default model('Subscription', SubscriptionSchema)
