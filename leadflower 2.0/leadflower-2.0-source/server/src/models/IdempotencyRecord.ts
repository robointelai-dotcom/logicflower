import { Schema, model } from 'mongoose'

const IdempotencyRecordSchema = new Schema({
  scope: { type: String, required: true, index: true },
  key: { type: String, required: true },
  method: { type: String, required: true },
  route: { type: String, required: true },
  requestHash: { type: String, required: true },
  state: { type: String, enum: ['processing', 'completed'], default: 'processing' },
  processingExpiresAt: { type: Date, required: true, index: true },
  responseStatus: Number,
  responseBody: Schema.Types.Mixed,
  expiresAt: { type: Date, required: true, index: true },
}, { timestamps: true })

IdempotencyRecordSchema.index({ scope: 1, key: 1 }, { unique: true })
IdempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default model('IdempotencyRecord', IdempotencyRecordSchema)
