import { Schema, model } from 'mongoose'

/**
 * One row per (organisation, metric, threshold, billing period).
 *
 * The unique index is the idempotency mechanism: concurrent workers both
 * attempt the insert and exactly one succeeds, so a customer receives the 80%
 * notice once rather than once per chunk of a large batch.
 */
const UsageAlertSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  metric: { type: String, required: true, index: true },
  threshold: { type: Number, required: true, min: 1, max: 100 },
  plan: { type: String, required: true },
  used: { type: Number, required: true, min: 0 },
  limit: { type: Number, required: true, min: 0 },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  fingerprint: { type: String, required: true, maxlength: 64 },
  raisedAt: { type: Date, required: true, default: Date.now, index: true },
  acknowledgedAt: Date,
}, { timestamps: true })

UsageAlertSchema.index({ fingerprint: 1 }, { unique: true })
UsageAlertSchema.index({ organizationId: 1, periodStart: 1, metric: 1 })

export default model('UsageAlert', UsageAlertSchema)
