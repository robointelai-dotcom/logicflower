import { Schema, model } from 'mongoose'

const ConnectionDeletionTaskSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, ref: 'PlatformConnection', required: true, index: true },
  provider: { type: String, required: true },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending', index: true },
  scheduledFor: { type: Date, default: Date.now, index: true },
  credentialsDeleteAt: { type: Date, required: true, index: true },
  completedAt: Date,
  credentialDeletedAt: Date,
  cachedDataDeletedAt: Date,
  attemptCount: { type: Number, default: 0 },
  lastAttemptAt: Date,
  error: { type: String, maxlength: 1_000 },
}, { timestamps: true })

ConnectionDeletionTaskSchema.index({ organizationId: 1, connectionId: 1 }, { unique: true })

export default model('ConnectionDeletionTask', ConnectionDeletionTaskSchema)
