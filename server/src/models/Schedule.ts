import { Schema, model } from 'mongoose'

const ScheduleSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  workflowId: { type: Schema.Types.ObjectId, ref: 'Workflow', index: true },
  nodeId: String,
  cron: { type: String, required: true },
  timezone: { type: String, default: 'UTC' },
  enabled: { type: Boolean, default: true },
  jobName: { type: String, index: true }
}, { timestamps: true })

ScheduleSchema.index({ organizationId: 1, workflowId: 1, nodeId: 1 }, { unique: true })

export default model('Schedule', ScheduleSchema)
