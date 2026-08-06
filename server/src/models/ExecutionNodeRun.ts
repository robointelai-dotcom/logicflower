import { Schema, model } from 'mongoose';

const ExecutionNodeRunSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  executionId: { type: Schema.Types.ObjectId, ref: 'Execution', required: true, index: true },
  nodeId: { type: String, required: true },
  idempotencyKey: { type: String, required: true },
  status: { type: String, enum: ['processing', 'succeeded', 'failed', 'outcome_unknown'], default: 'processing', index: true },
  startedAt: { type: Date, default: Date.now },
  finishedAt: Date,
  result: { type: Schema.Types.Mixed },
  error: { type: Schema.Types.Mixed },
}, { timestamps: true });

ExecutionNodeRunSchema.index({ organizationId: 1, executionId: 1, nodeId: 1 }, { unique: true });
export default model('ExecutionNodeRun', ExecutionNodeRunSchema);
