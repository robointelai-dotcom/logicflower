import { Schema, model } from 'mongoose';

const NotificationChannelSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  type: { type: String, enum: ['email', 'slack', 'webhook'], required: true },
  name: { type: String, required: true },
  enabled: { type: Boolean, default: true },
  config: { type: Schema.Types.Mixed, required: true },
  secretCiphertext: { type: String, select: false },
  minimumSeverity: { type: String, enum: ['info', 'warning', 'critical'], default: 'warning' },
  events: { type: [String], default: ['incident.created'] },
  status: { type: String, enum: ['unverified', 'verified', 'disabled', 'error'], default: 'unverified' },
  verifiedAt: Date,
  lastTestedAt: Date,
  destinationMasked: String,
}, { timestamps: true });

NotificationChannelSchema.index({ organizationId: 1, createdAt: -1 });
export default model('NotificationChannel', NotificationChannelSchema);
