import { Schema, model } from 'mongoose'
const FailedJobSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  jobId: String,
  workflowId: { type: Schema.Types.ObjectId, ref: 'Workflow', index: true },
  reason: String,
  payload: {},
  correlationId: String,
  retryable: Boolean,
}, { timestamps: true })
FailedJobSchema.index({ organizationId: 1, createdAt: -1 })
export default model('FailedJob', FailedJobSchema)
