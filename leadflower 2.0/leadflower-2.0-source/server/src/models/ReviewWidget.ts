import { Schema, model } from 'mongoose';

/**
 * Configuration for a public, embeddable review widget.
 *
 * Addressed by an unguessable key rather than the organisation id, so the
 * public endpoint cannot be walked. Scoped to exactly one organisation, and the
 * endpoint that serves it exposes nothing beyond published reviews — no contact
 * details, no pending or hidden reviews, no counts of what was filtered out.
 */
const ReviewWidgetSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  /** Unguessable public key used by the embed script. */
  publicKey: { type: String, required: true, unique: true },
  layout: { type: String, enum: ['carousel', 'grid', 'list', 'badge'], default: 'carousel' },
  /** Only reviews at or above this rating are shown. */
  minimumRating: { type: Number, default: 4, min: 1, max: 5 },
  maximumReviews: { type: Number, default: 12, min: 1, max: 50 },
  showAggregateRating: { type: Boolean, default: true },
  theme: {
    accentColor: { type: String, default: '#2563eb' },
    darkMode: { type: Boolean, default: false },
  },
  /**
   * Origins permitted to embed. Empty means any, which is the only workable
   * default for an embeddable widget but is recorded so it can be tightened.
   */
  allowedOrigins: { type: [String], default: [] },
  status: { type: String, enum: ['active', 'disabled'], default: 'active', index: true },
  createdBy: String,
}, { timestamps: true });

ReviewWidgetSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export default model('ReviewWidget', ReviewWidgetSchema);
