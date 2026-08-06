import { Schema, model } from 'mongoose';

const WorkflowDryRunApprovalSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  workflowId: { type: Schema.Types.ObjectId, ref: 'Workflow', required: true, index: true },
  workflowVersionId: { type: Schema.Types.ObjectId, ref: 'WorkflowVersion', required: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  definitionHash: { type: String, required: true },
  payloadHash: { type: String, required: true },
  planHash: { type: String, required: true },
  startNodeId: String,
  createdBy: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: true },
  consumedAt: Date,
  consumedExecutionId: { type: Schema.Types.ObjectId, ref: 'Execution' },
  purgeAt: { type: Date, required: true },
}, { timestamps: true });

WorkflowDryRunApprovalSchema.index({ organizationId: 1, workflowId: 1, createdAt: -1 });
WorkflowDryRunApprovalSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export default model('WorkflowDryRunApproval', WorkflowDryRunApprovalSchema);
