import { Schema, model } from 'mongoose'

const SupportAccessRequestSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  reason: { type: String, required: true, maxlength: 1_000 },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'expired'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true, index: true },
  decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  decidedAt: Date,
  decisionNote: { type: String, maxlength: 1_000 },
  // Intentionally false: this record is consent evidence only and does not grant impersonation.
  dataAccessEnabled: { type: Boolean, default: false, immutable: true },
}, { timestamps: true })

SupportAccessRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 })

export default model('SupportAccessRequest', SupportAccessRequestSchema)
