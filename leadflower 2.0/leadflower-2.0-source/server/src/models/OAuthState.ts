import { Schema, model } from 'mongoose'
import { platformProviders } from './PlatformConnection'

const OAuthStateSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, ref: 'PlatformConnection', index: true },
  provider: { type: String, enum: platformProviders, required: true },
  stateHash: { type: String, required: true, unique: true, index: true, select: false },
  codeVerifierEncrypted: { type: String, select: false },
  redirectTo: { type: String, maxlength: 500 },
  expiresAt: { type: Date, required: true, index: true },
  usedAt: Date,
}, { timestamps: true })

OAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default model('OAuthState', OAuthStateSchema)
