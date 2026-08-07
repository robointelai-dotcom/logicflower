import { Schema, model } from 'mongoose';

/**
 * A follow-up sequence definition.
 *
 * The document holds identity and lifecycle only. The executable content lives
 * in SequenceVersion, and an enrolment pins a version — so editing a sequence
 * never changes what an in-flight enrolment will do. This mirrors the
 * Workflow/WorkflowVersion split already used by the execution engine.
 */
const SequenceSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  description: String,
  status: { type: String, enum: ['draft', 'active', 'paused', 'archived'], default: 'draft', index: true },
  /** Highest version number ever created for this sequence. */
  latestVersion: { type: Number, default: 0 },
  /** The version new enrolments are pinned to. Null while the sequence is a draft. */
  publishedVersionId: { type: Schema.Types.ObjectId, default: null },
  publishedAt: Date,
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });

SequenceSchema.index({ organizationId: 1, name: 1 }, { unique: true });
SequenceSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });

export default model('Sequence', SequenceSchema);
