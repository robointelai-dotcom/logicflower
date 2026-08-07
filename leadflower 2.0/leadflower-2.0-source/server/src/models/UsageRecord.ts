import { Schema, model } from 'mongoose'

const UsageRecordSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  metric: { type: String, required: true, enum: ['workflow_execution', 'contact_processed', 'api_call', 'storage_byte', 'ai_request', 'ai_input_token', 'ai_output_token'], index: true },
  quantity: { type: Number, required: true, min: 0 },
  occurredAt: { type: Date, default: Date.now, index: true },
  idempotencyKey: { type: String, required: true },
  source: { type: String, maxlength: 120 },
  metadata: { type: Schema.Types.Mixed, default: {} },
  plan: { type: String, enum: ['free', 'starter', 'agency', 'scale'] },
  periodStart: Date,
  periodEnd: Date,
  counterUsed: { type: Number, min: 0 },
  counterLimit: { type: Number, min: 0 },
}, { timestamps: true })

UsageRecordSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true })
UsageRecordSchema.index({ organizationId: 1, metric: 1, occurredAt: -1 })

export default model('UsageRecord', UsageRecordSchema)
