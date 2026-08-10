import { Schema, model } from 'mongoose';

/**
 * A question customers actually asked, and the business's answer.
 *
 * The source is the inbox, not a keyword tool. Twelve people asking "do you do
 * emergency callouts on Sunday" in their own words is better research than any
 * volume estimate, and it is data only this product holds.
 *
 * Answers are bounded at 40-60 words by `checkCapsule`: shorter usually drops
 * the qualifier that makes the answer true, longer gets truncated mid-thought
 * by whatever quotes it.
 */
const AnswerCapsuleSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true, index: true },

  question: { type: String, required: true },
  answer: { type: String, default: '' },

  /** How many inbound messages clustered to this question. */
  askedCount: { type: Number, default: 1 },
  lastAskedAt: Date,
  /** Verbatim examples, so the operator can see what people actually wrote. */
  examples: { type: [String], default: [] },

  status: { type: String, enum: ['suggested', 'answered', 'published', 'dismissed'], default: 'suggested', index: true },
  publishedAt: Date,
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });

AnswerCapsuleSchema.index({ organizationId: 1, status: 1, askedCount: -1 });

export default model('AnswerCapsule', AnswerCapsuleSchema);
