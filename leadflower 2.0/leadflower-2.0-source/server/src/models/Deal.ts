import { Schema, model } from 'mongoose';

/**
 * An opportunity against a contact.
 *
 * Deliberately minimal — contact, pipeline, stage, value, expected close,
 * owner — because a deal model that tries to be Salesforce becomes a project of
 * its own, and none of it serves the follow-up engine that is the actual
 * product.
 *
 * Value is held in minor units with an explicit currency. Floating-point
 * currency arithmetic loses fractions, and a pipeline total that is a few cents
 * out is one nobody trusts.
 */
const DealSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, required: true, index: true },
  pipelineId: { type: Schema.Types.ObjectId, required: true, index: true },
  stageId: { type: String, required: true },
  title: { type: String, required: true },
  valueMinorUnits: { type: Number, default: 0 },
  currency: { type: String, default: 'USD' },
  expectedCloseAt: { type: Date, default: null },
  ownerUserId: { type: String, default: null, index: true },
  status: { type: String, enum: ['open', 'won', 'lost'], default: 'open', index: true },
  lostReason: String,
  closedAt: { type: Date, default: null },
  /** When the deal last changed stage, for ageing reports. */
  stageEnteredAt: { type: Date, default: Date.now },
  createdBy: String,
}, { timestamps: true });

DealSchema.index({ organizationId: 1, pipelineId: 1, stageId: 1, updatedAt: -1 });
DealSchema.index({ organizationId: 1, status: 1, expectedCloseAt: 1 });

export default model('Deal', DealSchema);
