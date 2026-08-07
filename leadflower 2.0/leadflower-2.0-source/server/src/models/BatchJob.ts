import { Schema, model } from 'mongoose';

const BatchJobSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  createdBy: String,
  name: { type: String, required: true, trim: true, maxlength: 160 },
  provider: { type: String, required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, index: true },
  operation: { type: String, required: true },
  status: {
    type: String,
    enum: ['draft', 'previewing', 'preview_ready', 'approved', 'queued', 'running', 'paused', 'cancel_requested', 'cancelled', 'completed', 'completed_with_errors', 'failed'],
    default: 'draft',
    index: true,
  },
  dryRunRequired: { type: Boolean, default: true },
  dryRunCompletedAt: Date,
  approvedAt: Date,
  approvedBy: String,
  previewHash: String,
  source: { type: Schema.Types.Mixed, default: {} },
  options: { type: Schema.Types.Mixed, default: {} },
  stats: {
    total: { type: Number, default: 0 },
    valid: { type: Number, default: 0 },
    duplicate: { type: Number, default: 0 },
    invalid: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
    processing: { type: Number, default: 0 },
    succeeded: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
  },
  chunkSize: { type: Number, default: 100, min: 1, max: 1_000 },
  checkpoint: { type: Schema.Types.Mixed, default: {} },
  artifacts: { type: Schema.Types.Mixed, default: {} },
  startedAt: Date,
  finishedAt: Date,
  error: { type: Schema.Types.Mixed },
  correlationId: { type: String, required: true, index: true },
}, { timestamps: true });

BatchJobSchema.index({ organizationId: 1, createdAt: -1 });
BatchJobSchema.index({ organizationId: 1, status: 1, updatedAt: 1 });

export default model('BatchJob', BatchJobSchema);
