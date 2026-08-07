import { Schema, model } from 'mongoose';

const WorkflowSnapshotSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  provider: { type: String, required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, index: true },
  externalWorkflowId: { type: String, required: true },
  name: String,
  status: String,
  hash: { type: String, required: true },
  canonicalCiphertext: { type: String, required: true, select: false },
  capturedAt: { type: Date, default: Date.now, required: true },
  sourceUpdatedAt: Date,
}, { timestamps: true });

WorkflowSnapshotSchema.index({ organizationId: 1, provider: 1, connectionId: 1, externalWorkflowId: 1, capturedAt: -1 });
WorkflowSnapshotSchema.index({ organizationId: 1, provider: 1, connectionId: 1, externalWorkflowId: 1, hash: 1 }, { unique: true });

export default model('WorkflowSnapshot', WorkflowSnapshotSchema);
