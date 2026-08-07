import { Schema, model } from 'mongoose'

export const quotaMetrics = ['workflow_execution', 'contact_processed'] as const
export type QuotaMetric = typeof quotaMetrics[number]

const UsageCounterSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  metric: { type: String, enum: quotaMetrics, required: true, index: true },
  periodStart: { type: Date, required: true, index: true },
  periodEnd: { type: Date, required: true },
  plan: { type: String, enum: ['free', 'starter', 'agency', 'scale'], required: true },
  limit: { type: Number, required: true, min: 0 },
  used: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true })

UsageCounterSchema.index({ organizationId: 1, metric: 1, periodStart: 1 }, { unique: true })
UsageCounterSchema.index({ organizationId: 1, periodEnd: 1 })

export default model('UsageCounter', UsageCounterSchema)
