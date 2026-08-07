import { Schema, model } from 'mongoose';

/**
 * A durable, persisted intent to publish one post at one time.
 *
 * Deliberately the same shape as ScheduledStep, and for the same reason: a
 * scheduled post may sit for weeks, and parking that wait in Redis means a
 * restart loses a customer's content calendar silently. MongoDB is the source
 * of truth; Redis is a work queue.
 *
 * The two-stage lease is also the same. `before_publish` means no platform call
 * was attempted and the post may be retried; `publish_started` means a call
 * began and its outcome cannot be established, which for social publishing
 * matters more than for messaging — a blind retry posts the same content to a
 * customer's public profile twice.
 */
const ScheduledPostSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  socialPostId: { type: Schema.Types.ObjectId, required: true, index: true },
  dueAt: { type: Date, required: true },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'cancelled', 'failed', 'outcome_unknown'],
    default: 'pending',
    index: true,
  },
  leaseStage: { type: String, enum: ['before_publish', 'publish_started', null], default: null },
  leaseExpiresAt: { type: Date, default: null },
  leaseOwner: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  startedAt: Date,
  finishedAt: Date,
  lastError: { code: String, message: String, at: Date },
}, { timestamps: true });

/** One scheduled publish per post. */
ScheduledPostSchema.index({ organizationId: 1, socialPostId: 1 }, { unique: true });
ScheduledPostSchema.index({ status: 1, dueAt: 1 });
ScheduledPostSchema.index({ status: 1, leaseExpiresAt: 1 });

export default model('ScheduledPost', ScheduledPostSchema);
