import { Schema, model } from 'mongoose';

/**
 * A URL redirect on the public site.
 *
 * Kept in the database rather than in code so that whoever changes a slug can
 * preserve the old link without a deployment — which is the difference between
 * a rename that keeps its search ranking and one that loses it.
 */
const RedirectSchema = new Schema({
  /** Path only, leading slash, no origin. */
  fromPath: { type: String, required: true, unique: true },
  toPath: { type: String, required: true },
  /** 301 for a permanent move, 302 when the original will return. */
  statusCode: { type: Number, enum: [301, 302], default: 301 },
  hits: { type: Number, default: 0 },
  lastHitAt: Date,
  note: String,
  createdBy: String,
}, { timestamps: true });

export default model('Redirect', RedirectSchema);
