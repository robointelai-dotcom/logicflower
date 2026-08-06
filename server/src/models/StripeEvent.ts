import { Schema, model } from 'mongoose'

const StripeEventSchema = new Schema({
  eventId: { type: String, required: true, unique: true, index: true },
  type: { type: String, required: true, index: true },
  state: { type: String, enum: ['processing', 'processed', 'failed'], default: 'processing' },
  processingUntil: { type: Date, required: true },
  processedAt: Date,
  error: { type: String, maxlength: 1_000 },
  expiresAt: { type: Date, required: true, index: true },
}, { timestamps: true })

StripeEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default model('StripeEvent', StripeEventSchema)
