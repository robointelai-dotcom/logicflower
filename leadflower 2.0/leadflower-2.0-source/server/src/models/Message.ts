import { Schema, model } from 'mongoose';

/**
 * A single message in a conversation, inbound or outbound.
 *
 * Distinct from SendRecord, deliberately. SendRecord is the delivery ledger:
 * its unique index is the duplicate-send guard, and it exists per enrolment
 * step. Message is the human-readable thread, and it covers inbound traffic
 * that has no send record at all. An outbound sequence send produces both, with
 * `sendRecordId` linking them.
 *
 * Bodies are ENCRYPTED AT REST with a per-record AAD. The build specification
 * requires technical controls suitable for handling health information, and a
 * message log is where the sensitive content actually accumulates — a clinic's
 * inbox will contain symptoms and appointment reasons whatever the product
 * intends. Encryption here is not a compliance claim; it is one of the controls
 * that makes such a claim possible for an operator running their own programme.
 */
const MessageSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  conversationId: { type: Schema.Types.ObjectId, required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, required: true, index: true },
  direction: { type: String, enum: ['inbound', 'outbound'], required: true },
  channel: { type: String, enum: ['email', 'sms', 'whatsapp', 'webchat'], required: true },
  /** Encrypted envelope. Never selected by default. */
  bodyCiphertext: { type: String, select: false },
  /** Encrypted envelope for an email subject. Never selected by default. */
  subjectCiphertext: { type: String, select: false },
  /** Redacted, truncated preview for list views. Safe to render broadly. */
  preview: { type: String, default: null },
  /** Redacted counterparty address, e.g. "j***@example.com". */
  addressPreview: { type: String, default: null },
  /** Provider's identifier, used to make ingestion idempotent. */
  providerMessageId: { type: String, default: null },
  provider: String,
  /** Set on outbound messages that came from a sequence step. */
  sendRecordId: { type: Schema.Types.ObjectId, default: null },
  enrolmentId: { type: Schema.Types.ObjectId, default: null },
  /** Set on outbound messages a human typed into the inbox. */
  authorUserId: { type: String, default: null },
  status: {
    type: String,
    enum: ['received', 'queued', 'sent', 'delivered', 'failed'],
    default: 'received',
  },
  occurredAt: { type: Date, default: Date.now },
}, { timestamps: true });

MessageSchema.index({ organizationId: 1, conversationId: 1, occurredAt: -1 });
/**
 * Ingestion idempotence. Providers retry webhooks; without this a redelivered
 * inbound message appears twice in the thread and, worse, fires the reply exit
 * condition twice.
 */
MessageSchema.index(
  { organizationId: 1, channel: 1, providerMessageId: 1 },
  { unique: true, partialFilterExpression: { providerMessageId: { $type: 'string' } } },
);

export default model('Message', MessageSchema);
