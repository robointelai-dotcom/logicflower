import { Schema, model } from 'mongoose';

/**
 * A customer's own website, paired with their workspace.
 *
 * The token this holds can WRITE content and RECEIVE events. It can never read
 * contacts, messages or deals — so if the customer's WordPress is compromised,
 * and small business sites regularly are, nothing about THEIR customers leaks
 * through it.
 */
const SiteConnectionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },

  siteUrl: String,
  platform: { type: String, enum: ['wordpress', 'manual', 'other'], default: 'wordpress' },
  pluginVersion: String,

  /**
   * Hashed, never stored in the clear.
   *
   * A token readable from the database is one a database backup leaks. It is
   * shown to the operator exactly once, at pairing.
   */
  siteTokenHash: { type: String, default: null, index: true },
  tokenIssuedAt: Date,

  /**
   * Short-lived pairing code.
   *
   * Four characters, a dash, four — readable over the phone to whoever looks
   * after the site. Single use, fifteen minutes, and hashed like the token.
   */
  pairingCodeHash: { type: String, default: null },
  pairingExpiresAt: Date,

  status: { type: String, enum: ['unpaired', 'pairing', 'connected', 'revoked'], default: 'unpaired', index: true },
  lastSeenAt: Date,
  connectedBy: String,
}, { timestamps: true });

export default model('SiteConnection', SiteConnectionSchema);
