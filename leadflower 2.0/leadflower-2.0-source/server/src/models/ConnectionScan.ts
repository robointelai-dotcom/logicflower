import { Schema, model } from 'mongoose';

const ConnectionScanSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, ref: 'PlatformConnection', required: true, index: true },
  provider: { type: String, required: true },
  reason: { type: String, enum: ['connection', 'reauthorization', 'manual'], default: 'connection' },
  status: { type: String, enum: ['queued', 'running', 'completed', 'failed'], default: 'queued', index: true },
  sampleLimit: { type: Number, required: true, default: 5_000 },
  scannedCount: { type: Number, default: 0 },
  duplicateGroups: { type: Number, default: 0 },
  duplicateRecords: { type: Number, default: 0 },
  invalidEmails: { type: Number, default: 0 },
  invalidPhones: { type: Number, default: 0 },
  missingPrimaryIdentifier: { type: Number, default: 0 },
  truncated: { type: Boolean, default: false },
  startedAt: Date,
  completedAt: Date,
  error: { type: Schema.Types.Mixed },
}, { timestamps: true });

ConnectionScanSchema.index({ organizationId: 1, connectionId: 1, createdAt: -1 });
ConnectionScanSchema.index({ organizationId: 1, status: 1, updatedAt: 1 });

export default model('ConnectionScan', ConnectionScanSchema);
