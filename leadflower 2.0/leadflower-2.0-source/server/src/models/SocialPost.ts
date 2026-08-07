import { Schema, model } from 'mongoose';

/**
 * One composed post, targeting one or more platforms.
 *
 * The composer is single but the outcome is per-target: a post may publish to
 * Facebook and fail on Instagram, and modelling a single post-level status
 * would make that unrepresentable. Each target therefore carries its own status
 * and its own error.
 */
const PostTargetSchema = new Schema({
  socialAccountId: { type: Schema.Types.ObjectId, required: true },
  platform: { type: String, required: true },
  /** Per-platform caption override. Falls back to the shared caption. */
  captionOverride: { type: String, default: null },
  status: {
    type: String,
    enum: ['pending', 'publishing', 'published', 'failed', 'blocked', 'cancelled'],
    default: 'pending',
  },
  /** `blocked` means the platform is not implemented or not approved. */
  blockedReason: String,
  externalPostId: String,
  externalPostUrl: String,
  publishedAt: Date,
  lastError: { code: String, message: String, at: Date },
}, { _id: false });

const SocialPostSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  /**
   * Optional contact this post relates to — a review turned into a post, a
   * completed job. Drives the unified timeline: the post appears on the
   * contact's activity feed even though it lives in a different system.
   */
  contactId: { type: Schema.Types.ObjectId, default: null, index: true },
  caption: { type: String, default: '' },
  /** Artifact ids for uploaded media, resolved through the existing store. */
  mediaArtifactIds: { type: [Schema.Types.ObjectId], default: [] },
  targets: { type: [PostTargetSchema], default: [] },
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'publishing', 'completed', 'partially_failed', 'failed', 'cancelled'],
    default: 'draft',
    index: true,
  },
  scheduledFor: { type: Date, default: null },
  /** Timezone the schedule was set in, so the calendar renders as intended. */
  timeZone: { type: String, default: 'UTC' },
  publishedAt: Date,
  createdBy: String,
}, { timestamps: true });

SocialPostSchema.index({ organizationId: 1, status: 1, scheduledFor: 1 });
SocialPostSchema.index({ organizationId: 1, scheduledFor: -1 });

export default model('SocialPost', SocialPostSchema);
