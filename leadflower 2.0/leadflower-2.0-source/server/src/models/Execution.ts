import { Schema, model } from 'mongoose';

const StepSchema = new Schema({
  nodeId: String,
  type: String,
  startedAt: Date,
  finishedAt: Date,
  status: String,
  logs: [String],
  output: {},
  error: {},
  attempt: Number,
}, { _id: false });

const ExecSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  workflowId: { type: Schema.Types.ObjectId, ref: 'Workflow', index: true },
  workflowVersionId: { type: Schema.Types.ObjectId, ref: 'WorkflowVersion', index: true },
  retryOfExecutionId: { type: Schema.Types.ObjectId, ref: 'Execution', index: true },
  definitionHash: String,
  correlationId: { type: String, required: true, index: true },
  status: { type: String, index: true },
  startedAt: Date,
  finishedAt: Date,
  durationMs: Number,
  input: {},
  inputCiphertext: { type: String, select: false },
  output: {},
  error: {},
  steps: [StepSchema],
  stateCiphertext: { type: String, select: false },
  checkpoint: { type: Schema.Types.Mixed, default: {} },
  currentNodeId: String,
  stepCount: { type: Number, default: 0 },
  cancelRequestedAt: Date,
  cancelRequestedBy: String,
}, { timestamps: true });

// Ensure createdAt is indexed for faster queries
ExecSchema.index({ createdAt: -1 });
ExecSchema.index({ organizationId: 1, createdAt: -1 });
ExecSchema.index({ organizationId: 1, workflowId: 1, createdAt: -1 });

export default model('Execution', ExecSchema);
