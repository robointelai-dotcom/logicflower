import { Schema, model } from 'mongoose'

const PasswordResetSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, index: true, select: false },
  expiresAt: { type: Date, required: true, index: true },
  usedAt: Date,
  requestedIp: { type: String, maxlength: 128 },
}, { timestamps: true })

PasswordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default model('PasswordReset', PasswordResetSchema)
