import { Schema, model } from 'mongoose'

export const aiConnectionProviders = ['openai', 'anthropic', 'googleai'] as const
export type AiConnectionProvider = typeof aiConnectionProviders[number]

export const AI_CONSENT_TERMS_VERSION = '2026-08-01'

const AiConnectionConsentSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, ref: 'PlatformConnection', required: true, index: true },
  provider: { type: String, enum: aiConnectionProviders, required: true, index: true },
  enabled: { type: Boolean, required: true, default: false, index: true },
  allowedModels: { type: [String], required: true, default: [] },
  maxInputTokens: { type: Number, required: true, min: 512, max: 32_768, default: 8_192 },
  maxOutputTokens: { type: Number, required: true, min: 1, max: 4_096, default: 1_024 },
  termsVersion: { type: String, required: true, maxlength: 40, default: AI_CONSENT_TERMS_VERSION },
  consentedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  consentedAt: Date,
  revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  revokedAt: Date,
}, { timestamps: true })

AiConnectionConsentSchema.index({ organizationId: 1, connectionId: 1 }, { unique: true })
AiConnectionConsentSchema.index({ organizationId: 1, enabled: 1, provider: 1 })

export default model('AiConnectionConsent', AiConnectionConsentSchema)
