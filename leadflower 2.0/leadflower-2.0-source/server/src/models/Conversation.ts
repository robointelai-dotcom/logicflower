import { Schema, model } from 'mongoose';

/**
 * One thread per contact, spanning every channel.
 *
 * Per contact, not per channel, and that is the design decision the inbox rests
 * on. A small business owner does not think "the SMS thread with Priya" and
 * "the email thread with Priya" — they think about Priya. Splitting by channel
 * also means a reply on WhatsApp does not visibly answer a question asked over
 * email, and the operator loses the thread of their own conversation.
 *
 * The document holds thread state only. Message content lives in Message, so a
 * conversation list can be rendered without decrypting anything.
 */
const ConversationSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, required: true, index: true },
  status: { type: String, enum: ['open', 'snoozed', 'closed'], default: 'open', index: true },
  /** Channels that have carried at least one message in this thread. */
  channels: { type: [String], default: [] },
  assigneeUserId: { type: String, default: null, index: true },
  lastMessageAt: { type: Date, default: null },
  lastInboundAt: { type: Date, default: null },
  lastOutboundAt: { type: Date, default: null },
  /**
   * Preview of the most recent message, redacted and truncated. Held here so a
   * list view needs no decryption; it is a summary, never the record.
   */
  lastMessagePreview: { type: String, default: null },
  lastMessageDirection: { type: String, enum: ['inbound', 'outbound', null], default: null },
  /** Unread inbound messages. Reset when a human opens the thread. */
  unreadCount: { type: Number, default: 0 },
  snoozedUntil: { type: Date, default: null },
}, { timestamps: true });

/** One thread per contact. The upsert that creates it relies on this. */
ConversationSchema.index({ organizationId: 1, contactId: 1 }, { unique: true });
ConversationSchema.index({ organizationId: 1, status: 1, lastMessageAt: -1 });
ConversationSchema.index({ organizationId: 1, assigneeUserId: 1, status: 1, lastMessageAt: -1 });

export default model('Conversation', ConversationSchema);
