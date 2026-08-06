import { Schema, model } from 'mongoose'

export const platformProviders = ['ghl', 'hubspot', 'klaviyo', 'activecampaign', 'google', 'openai', 'anthropic', 'googleai', 'generic'] as const
export type PlatformProvider = typeof platformProviders[number]

const PlatformConnectionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  provider: { type: String, enum: platformProviders, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  externalAccountId: { type: String, trim: true, maxlength: 240 },
  status: { type: String, enum: ['pending', 'active', 'degraded', 'disconnecting', 'revoked', 'error'], default: 'pending', index: true },
  encryptedCredentials: { type: String, required: true, select: false },
  credentialVersion: { type: Number, default: 1, min: 1, select: false },
  refreshLeaseOwner: { type: String, select: false },
  refreshLeaseUntil: { type: Date, select: false },
  scopes: { type: [String], default: [] },
  // Scope provenance. `scopes` is retained for backward compatibility and is
  // the union of what is known; `grantedScopes` holds ONLY strings the provider
  // itself returned. Capability resolution reads grantedScopes + scopeSource.
  grantedScopes: { type: [String], default: [] },
  requestedScopes: { type: [String], default: [] },
  scopeSource: {
    type: String,
    enum: ['provider_token_response', 'live_probe', 'operator_claimed', 'requested_not_confirmed'],
    default: 'requested_not_confirmed',
    index: true,
  },
  scopeObservedAt: Date,
  tokenExpiresAt: Date,
  lastHealthyAt: Date,
  lastError: { type: String, maxlength: 1_000 },
  slotReleasedAt: { type: Date, select: false },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true })

PlatformConnectionSchema.index({ organizationId: 1, provider: 1, externalAccountId: 1 }, { unique: true, sparse: true })
PlatformConnectionSchema.index({ organizationId: 1, status: 1 })

export default model('PlatformConnection', PlatformConnectionSchema)
