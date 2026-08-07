import { Schema, model } from 'mongoose';

/**
 * A free-text note against a contact.
 *
 * Separate from the Contact document rather than an array on it, because notes
 * grow without bound and an array field would make every contact read carry
 * the entire history.
 */
const ContactNoteSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, required: true, index: true },
  body: { type: String, required: true },
  authorUserId: String,
  authorName: String,
  pinned: { type: Boolean, default: false },
}, { timestamps: true });

ContactNoteSchema.index({ organizationId: 1, contactId: 1, createdAt: -1 });

export default model('ContactNote', ContactNoteSchema);
