import { Schema, model } from 'mongoose'

const DataLifecycleRequestSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['export', 'closure'], required: true, index: true },
  status: { type: String, enum: ['queued', 'processing', 'ready', 'completed', 'failed'], default: 'queued', index: true },
  artifactId: { type: Schema.Types.ObjectId, ref: 'Artifact' },
  requestedAt: { type: Date, default: Date.now, required: true },
  startedAt: Date,
  completedAt: Date,
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  attemptCount: { type: Number, default: 0, min: 0 },
  evidence: { type: Schema.Types.Mixed, default: {} },
  error: { type: String, maxlength: 1_000 },
}, { timestamps: true })

DataLifecycleRequestSchema.index({ organizationId: 1, type: 1, createdAt: -1 })
DataLifecycleRequestSchema.index({ requestedBy: 1, createdAt: -1 })

export default model('DataLifecycleRequest', DataLifecycleRequestSchema)
