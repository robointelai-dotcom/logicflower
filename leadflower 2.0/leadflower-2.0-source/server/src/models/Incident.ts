import { Schema, model } from 'mongoose';

const IncidentSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  provider: { type: String, required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, index: true },
  externalWorkflowId: String,
  type: { type: String, required: true, index: true },
  severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'warning', index: true },
  status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open', index: true },
  title: { type: String, required: true },
  description: String,
  evidence: { type: Schema.Types.Mixed },
  fingerprint: { type: String, required: true },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  resolvedAt: Date,
}, { timestamps: true });

IncidentSchema.index({ organizationId: 1, fingerprint: 1, status: 1 });
IncidentSchema.index({ organizationId: 1, createdAt: -1 });
export default model('Incident', IncidentSchema);
