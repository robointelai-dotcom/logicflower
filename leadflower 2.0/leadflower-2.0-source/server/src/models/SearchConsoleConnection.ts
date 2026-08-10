import { Schema, model } from 'mongoose';

/**
 * A customer's own Google Search Console connection.
 *
 * IMPORTANT: this is NOT the Google Business Profile API.
 *
 * Search Console needs no application to Google and no approval — the customer
 * authorises us against their own property with OAuth, the same way they would
 * connect a calendar. Business Profile is a separate API, granted per
 * application, which can be refused, and it is not part of this module.
 *
 * Conflating the two is easy and expensive: it leads to waiting for an approval
 * that this feature never needed.
 *
 * Tokens are encrypted at rest with the platform keyring, per organisation.
 */
const SearchConsoleConnectionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },

  /** The verified property, e.g. `sc-domain:example.com` or `https://example.com/`. */
  siteUrl: { type: String, default: '' },
  /** Which Google account authorised it, so the operator can see whose it is. */
  connectedEmail: String,

  /**
   * Encrypted refresh token.
   *
   * A refresh token is long-lived and grants ongoing read access to the
   * customer's search data. It is never returned by any endpoint — not even to
   * the operator who created it.
   */
  refreshTokenCipher: { type: String, default: null },
  accessTokenCipher: { type: String, default: null },
  accessTokenExpiresAt: Date,

  status: { type: String, enum: ['connected', 'expired', 'revoked', 'error'], default: 'connected', index: true },
  /**
   * Why it stopped working, in words an operator can act on.
   *
   * A connection that silently returns nothing is worse than one that says it
   * is broken — the operator concludes the feature does not work and stops
   * looking.
   */
  lastError: String,
  lastSyncedAt: Date,
  connectedBy: String,
}, { timestamps: true });

export default model('SearchConsoleConnection', SearchConsoleConnectionSchema);
