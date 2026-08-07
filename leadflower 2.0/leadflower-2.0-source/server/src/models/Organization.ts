import { Schema, model } from 'mongoose'

const OrganizationSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active', index: true },
  timezone: { type: String, default: 'UTC', maxlength: 80 },
  retentionDays: { type: Number, default: 7, min: 7, max: 90 },
  // Open and click tracking records a recipient's behaviour and needs a
  // lawful basis the operator may not have, so it is opt-in per organisation
  // and defaults to off. Delivery and bounce state is operational and is
  // always recorded regardless of this flag.
  engagementTrackingEnabled: { type: Boolean, default: false },
  /**
   * Missed-call text back. Disabled by default: enabling it sends automated SMS
   * to anyone who rings and is not answered, under the operator's own number
   * and at their cost, so it must be a deliberate act rather than something
   * that begins because a webhook was wired up.
   */
  /**
   * Link to the external social publishing service.
   *
   * The workspace API key is per organisation and encrypted with a per-record
   * AAD. It is never selected by default and never defaults to a shared admin
   * key — that key is workspace-scoped, so using the wrong one is a
   * cross-tenant write.
   */
  /**
   * The OPERATOR'S OWN payment provider, collecting money from their customers.
   * Strictly separate from platform billing, which uses the platform's Stripe
   * account via env.STRIPE_SECRET_KEY. Sharing configuration between the two
   * would route a customer's payment into the wrong bank account.
   */
  /**
   * Outbound calling policy. Absent means the conservative default window,
   * which cannot be widened without a recorded legal review.
   */
  callingPolicy: {
    label: String,
    window: {
      startMinute: Number,
      endMinute: Number,
      permittedWeekdays: { type: [Number], default: undefined },
    },
    blackoutDates: { type: [String], default: [] },
    legalReviewRecordedBy: { type: String, default: null },
    legalReviewedAt: { type: Date, default: null },
  },
  payments: {
    provider: { type: String, enum: ['stripe', 'paypal', null], default: null },
    credentialCiphertext: { type: String, select: false },
    livemode: { type: Boolean, default: false },
    linkedAt: Date,
  },
  socialBackend: {
    provider: { type: String, enum: ['trypost', null], default: null },
    workspaceLabel: String,
    workspaceKeyCiphertext: { type: String, select: false },
    linkedAt: Date,
  },
  missedCallTextBack: {
    enabled: { type: Boolean, default: false },
    messageTemplate: { type: String, default: 'Sorry we missed your call. Reply here and we will get straight back to you.' },
    quietHours: {
      enabled: { type: Boolean, default: true },
      startMinute: { type: Number, default: 1_260 },
      endMinute: { type: Number, default: 480 },
    },
    defaultTimeZone: { type: String, default: 'UTC' },
  },
  connectionCount: { type: Number, default: 0, min: 0, select: false },
  ownerCount: { type: Number, default: 1, min: 1, select: false },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  onboardingCompletedAt: Date,
  // Grandfathered pricing (report 24.5 rule 5). A locked organisation is never
  // repriced by a migration, but still receives the entitlements of the tier it
  // pays for — the lock is a price guarantee, not a feature freeze.
  priceLocked: { type: Boolean, default: false, index: true },
  legacyPlanId: { type: String, default: null, maxlength: 200 },
  priceLockedAt: Date,
  priceLockReason: { type: String, maxlength: 300 },
}, { timestamps: true })

export default model('Organization', OrganizationSchema)
