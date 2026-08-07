import { Schema, model } from 'mongoose';

/**
 * "Do not contact this person on this channel."
 *
 * Two properties matter more than anything else about this collection.
 *
 * 1. It is checked before EVERY send on EVERY channel. A suppression list that
 *    is consulted on some paths is not a suppression list.
 *
 * 2. It is NEVER purged. Retention sweeps, organisation data-lifecycle erasure
 *    and manual cleanup all skip it. Deleting the record that says "this person
 *    asked us to stop" is worse than useless: it silently re-permits contact
 *    and converts a handled unsubscribe into a regulatory complaint. There is
 *    deliberately no TTL index here and no delete path outside an explicit,
 *    audited operator action.
 *
 * The address is stored as a keyed digest plus a redacted preview rather than
 * in clear, so the list is queryable without being a harvestable contact
 * database.
 */
const SuppressionEntrySchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  channel: { type: String, enum: ['email', 'sms', 'whatsapp'], required: true },
  /** HMAC of the normalised address. Deterministic, so it can be indexed. */
  addressDigest: { type: String, required: true },
  /** e.g. "j***@example.com" or "+9477***4567". Display only. */
  addressPreview: String,
  reason: {
    type: String,
    enum: ['unsubscribed', 'hard_bounce', 'complaint', 'manual', 'invalid_address'],
    required: true,
  },
  source: { type: String, default: 'system' },
  /** The send that produced this entry, where one exists. */
  sendRecordId: { type: Schema.Types.ObjectId, default: null },
  note: String,
  createdBy: String,
}, { timestamps: true });

SuppressionEntrySchema.index({ organizationId: 1, channel: 1, addressDigest: 1 }, { unique: true });
SuppressionEntrySchema.index({ organizationId: 1, createdAt: -1 });

export default model('SuppressionEntry', SuppressionEntrySchema);
