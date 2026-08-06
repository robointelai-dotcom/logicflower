import { Schema, model } from 'mongoose'

const SessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  currentOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },
  refreshTokenHash: { type: String, required: true, unique: true, index: true, select: false },
  previousRefreshTokenHash: { type: String, select: false },
  previousRefreshValidUntil: { type: Date, select: false },
  userAgent: { type: String, maxlength: 512 },
  ipAddress: { type: String, maxlength: 128 },
  lastUsedAt: { type: Date, default: Date.now },
  authenticatedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },
  revokedAt: { type: Date, index: true },
  revokeReason: { type: String, maxlength: 120 },
}, { timestamps: true })

SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
SessionSchema.index({ userId: 1, revokedAt: 1 })

export default model('Session', SessionSchema)
