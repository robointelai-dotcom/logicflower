import { Schema, model } from 'mongoose';

/**
 * A customer review.
 *
 * `publishState` governs the public widget absolutely. The widget is
 * unauthenticated, so anything marked published is world-readable forever, and
 * the default is therefore NOT published: a review appears publicly only when
 * someone has decided it should.
 *
 * `source` distinguishes a review collected through this system from one
 * imported from a platform. That matters legally as well as editorially —
 * several review platforms restrict redisplay of their content, and an operator
 * needs to know which is which before embedding a widget.
 */
const ReviewSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, default: null, index: true },
  dealId: { type: Schema.Types.ObjectId, default: null },
  rating: { type: Number, required: true, min: 1, max: 5 },
  body: { type: String, default: '' },
  /** Display name as the reviewer gave it. Never an email address. */
  authorName: { type: String, default: 'Customer' },
  source: { type: String, enum: ['first_party', 'google', 'facebook', 'imported'], default: 'first_party' },
  externalReviewId: { type: String, default: null },
  /** Not published by default: the widget is public and permanent. */
  publishState: { type: String, enum: ['pending', 'published', 'hidden'], default: 'pending', index: true },
  publishedAt: { type: Date, default: null },
  moderatedBy: String,
  reply: {
    body: String,
    repliedAt: Date,
    repliedBy: String,
  },
  submittedAt: { type: Date, default: Date.now },
}, { timestamps: true });

ReviewSchema.index({ organizationId: 1, publishState: 1, submittedAt: -1 });
ReviewSchema.index({ organizationId: 1, rating: 1, publishState: 1 });
ReviewSchema.index(
  { organizationId: 1, source: 1, externalReviewId: 1 },
  { unique: true, partialFilterExpression: { externalReviewId: { $type: 'string' } } },
);

export default model('Review', ReviewSchema);
