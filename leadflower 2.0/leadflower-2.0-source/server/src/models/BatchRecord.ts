import { Schema, model } from 'mongoose';

const BatchRecordSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  batchJobId: { type: Schema.Types.ObjectId, ref: 'BatchJob', required: true, index: true },
  rowNumber: { type: Number, required: true },
  dedupeKey: { type: String, index: true },
  contentHash: { type: String, required: true },
  status: { type: String, enum: ['pending', 'processing', 'succeeded', 'failed', 'skipped', 'duplicate', 'invalid', 'outcome_unknown'], default: 'pending', index: true },
  leaseExpiresAt: Date,
  leaseStage: { type: String, enum: ['before_remote', 'remote_started'] },
  inputCiphertext: { type: String, required: true, select: false },
  normalizedCiphertext: { type: String, select: false },
  beforeStateCiphertext: { type: String, select: false },
  result: { type: Schema.Types.Mixed },
  error: { type: Schema.Types.Mixed },
  attempts: { type: Number, default: 0 },
  startedAt: Date,
  finishedAt: Date,
}, { timestamps: true });

BatchRecordSchema.index({ organizationId: 1, batchJobId: 1, rowNumber: 1 }, { unique: true });
BatchRecordSchema.index({ organizationId: 1, batchJobId: 1, status: 1, rowNumber: 1 });

export default model('BatchRecord', BatchRecordSchema);
