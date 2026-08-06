import { Schema, model } from 'mongoose'

const WorkflowVersionSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  workflowId: { type: Schema.Types.ObjectId, ref: 'Workflow', index: true },
  version: { type: Number, index: true },
  snapshot: {},
  comment: String
}, { timestamps: true })

WorkflowVersionSchema.index({ organizationId: 1, workflowId: 1, version: -1 }, { unique: true })

export default model('WorkflowVersion', WorkflowVersionSchema)
