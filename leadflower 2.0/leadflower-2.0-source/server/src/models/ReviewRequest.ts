import { Schema, model } from 'mongoose';

/**
 * An invitation to leave a review, sent to one contact.
 *
 * The unique index is the anti-nagging control. Without it, a contact who
 * completes three jobs in a month gets three review requests, and a stage
 * change that fires twice sends two. Repeated review requests are the fastest
 * way to make a customer mute a business.
 *
 * The token is the identifier for the public submission page: unguessable, and
 * single-use in the sense that a submitted request cannot be resubmitted.
 */
const ReviewRequestSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, required: true, index: true },
  dealId: { type: Schema.Types.ObjectId, default: null },
  channel: { type: String, enum: ['email', 'sms'], required: true },
  token: { type: String, required: true, unique: true },
  status: {
    type: String,
    enum: ['pending', 'sent', 'submitted', 'failed', 'suppressed', 'expired'],
    default: 'pending',
    index: true,
  },
  reviewId: { type: Schema.Types.ObjectId, default: null },
  sentAt: Date,
  submittedAt: Date,
  expiresAt: { type: Date, default: null },
  failureReason: String,
  source: { type: String, default: 'manual' },
}, { timestamps: true });

/**
 * One outstanding request per contact. Partial, so a contact can legitimately
 * be asked again after a long interval once the previous one is resolved.
 */
ReviewRequestSchema.index(
  { organizationId: 1, contactId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'sent'] } } },
);
ReviewRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

export default model('ReviewRequest', ReviewRequestSchema);
