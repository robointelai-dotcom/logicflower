import { Schema, model } from 'mongoose'

export type UserStatus = 'active' | 'suspended' | 'deleted'

const UserSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  displayName: { type: String, required: true, trim: true, maxlength: 120 },
  passwordHash: { type: String, required: true, select: false },
  status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active', index: true },
  platformRole: { type: String, enum: ['user', 'support', 'admin', 'owner'], default: 'user', index: true },
  emailVerifiedAt: Date,
  passwordChangedAt: Date,
  failedLoginCount: { type: Number, default: 0, min: 0, select: false },
  lockUntil: { type: Date, select: false },
  mfaEnabled: { type: Boolean, default: false },
  mfaSecretEncrypted: { type: String, select: false },
  mfaPendingSecretEncrypted: { type: String, select: false },
  mfaRecoveryCodeHashes: { type: [String], default: [], select: false },
  // Rolling ring of recently consumed TOTP codes. Capped by $slice on write so
  // the document cannot grow without bound.
  mfaUsedCodes: {
    type: [{ hash: { type: String, required: true }, usedAt: { type: Date, required: true } }],
    default: [],
    select: false,
  },
  mfaLastCodeHash: { type: String, select: false },
  mfaLastCodeUsedAt: { type: Date, select: false },
  lastLoginAt: Date,
}, { timestamps: true, minimize: false })

export default model('User', UserSchema)
