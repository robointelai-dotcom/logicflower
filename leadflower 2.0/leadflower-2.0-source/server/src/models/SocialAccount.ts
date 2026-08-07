import { Schema, model } from 'mongoose';

/**
 * A connected social platform account.
 *
 * `publishState` is provenance, not aspiration. It starts at `unimplemented`
 * for every platform and may only reach `available` from a recorded live probe
 * against an approved app — the same rule the connector capability model
 * applies: absence of evidence resolves to unavailable, never to available.
 *
 * An account can therefore be connected, named and selected in a composer long
 * before anything can actually be posted to it, and the UI must say so rather
 * than implying otherwise.
 */
const SocialAccountSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  platform: {
    type: String,
    enum: ['facebook_page', 'instagram_business', 'linkedin_page', 'tiktok', 'pinterest', 'google_business_profile'],
    required: true,
  },
  /** Platform-side identifier: page id, location id, board id. */
  externalAccountId: { type: String, required: true },
  displayName: { type: String, required: true },
  status: { type: String, enum: ['connected', 'disconnected', 'error'], default: 'connected', index: true },
  publishState: { type: String, enum: ['unimplemented', 'unverified', 'available'], default: 'unimplemented' },
  /** Encrypted credential envelope. Never selected by default. */
  credentialsCiphertext: { type: String, select: false },
  /** Scopes the PROVIDER returned, never scopes that were merely requested. */
  grantedScopes: { type: [String], default: [] },
  lastProbeAt: Date,
  lastProbeDetail: String,
  createdBy: String,
}, { timestamps: true });

SocialAccountSchema.index({ organizationId: 1, platform: 1, externalAccountId: 1 }, { unique: true });

export default model('SocialAccount', SocialAccountSchema);
