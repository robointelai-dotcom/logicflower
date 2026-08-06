import { Schema, model } from 'mongoose';

const MonitoringRunSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  provider: { type: String, required: true },
  connectionId: { type: Schema.Types.ObjectId, index: true },
  status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running', index: true },
  startedAt: { type: Date, default: Date.now },
  finishedAt: Date,
  summary: { type: Schema.Types.Mixed, default: {} },
  error: { type: Schema.Types.Mixed },
  correlationId: { type: String, required: true },
}, { timestamps: true });

MonitoringRunSchema.index({ organizationId: 1, createdAt: -1 });
export default model('MonitoringRun', MonitoringRunSchema);
