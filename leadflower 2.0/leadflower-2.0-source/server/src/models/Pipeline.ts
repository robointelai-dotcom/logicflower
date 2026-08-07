import { Schema, model } from 'mongoose';

/**
 * A per-organisation pipeline with ordered stages.
 *
 * Stages are embedded rather than a separate collection: they are small, always
 * read with their pipeline, and their ORDER is the meaningful part. A separate
 * collection would make reordering a multi-document write with no transaction
 * around it.
 *
 * Each stage carries a stable `stageId` that never changes, so renaming
 * "Quoted" to "Proposal Sent" does not orphan every deal in it, and so a
 * sequence trigger bound to a stage keeps working across a rename.
 */
const PipelineStageSchema = new Schema({
  stageId: { type: String, required: true },
  name: { type: String, required: true },
  position: { type: Number, required: true },
  /** Terminal stages close a deal rather than advancing it. */
  outcome: { type: String, enum: ['open', 'won', 'lost'], default: 'open' },
  /** Default probability for forecasting, 0-100. Advisory only. */
  probability: { type: Number, default: 0, min: 0, max: 100 },
  /**
   * Sequence to enrol the deal's contact into when it enters this stage.
   * This is the join between the CRM and the Phase 1 engine.
   */
  enrolSequenceId: { type: Schema.Types.ObjectId, default: null },
  /** Sequence to exit on entry, e.g. stop nurturing once someone is quoted. */
  exitSequenceId: { type: Schema.Types.ObjectId, default: null },
  /**
   * Tasks raised when a deal enters this stage. The human counterpart to the
   * sequence triggers above: entering "Quoted" can both start a chase sequence
   * and raise "call them in 48 hours" against the deal owner.
   */
  taskTemplates: {
    type: [new Schema({
      title: { type: String, required: true },
      dueInHours: { type: Number, default: null },
      priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    }, { _id: false })],
    default: [],
  },
}, { _id: false });

const PipelineSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  description: String,
  stages: { type: [PipelineStageSchema], default: [] },
  isDefault: { type: Boolean, default: false },
  archivedAt: { type: Date, default: null },
  /** Set when the pipeline came from an applied industry snapshot. */
  source: { type: String, default: 'operator' },
  createdBy: String,
}, { timestamps: true });

PipelineSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export default model('Pipeline', PipelineSchema);
