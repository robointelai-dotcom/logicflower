import { Schema, model } from 'mongoose'

const OrganizationSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active', index: true },
  timezone: { type: String, default: 'UTC', maxlength: 80 },
  retentionDays: { type: Number, default: 7, min: 7, max: 90 },
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
