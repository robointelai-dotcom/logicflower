import { Schema, model } from 'mongoose';

const Any = new Schema({ any: {} }, { strict: false, _id: false });

const WorkflowSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  description: { type: String, trim: true, maxlength: 2_000 },
  status: { type: String, enum: ['draft','published','paused','archived'], default: 'draft', index: true },
  nodes: { type: [Any], default: [] },
  edges: { type: [Any], default: [] },
  createdBy: { type: String },
  schemaVersion: { type: Number, default: 2 },
  publishedVersion: { type: Schema.Types.ObjectId, ref: 'WorkflowVersion' },
  definitionHash: String,
  archivedAt: Date,
}, { timestamps: true });

WorkflowSchema.index({ organizationId: 1, updatedAt: -1 });
WorkflowSchema.index({ organizationId: 1, status: 1 });

export default model('Workflow', WorkflowSchema);
