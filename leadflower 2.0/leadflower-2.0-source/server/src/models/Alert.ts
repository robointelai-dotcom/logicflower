import { Schema, model } from 'mongoose';

const AlertSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  incidentId: { type: Schema.Types.ObjectId, ref: 'Incident', required: true, index: true },
  channelId: { type: Schema.Types.ObjectId, ref: 'NotificationChannel', required: true },
  status: { type: String, enum: ['queued', 'sending', 'sent', 'failed', 'suppressed'], default: 'queued', index: true },
  attemptCount: { type: Number, default: 0 },
  lastAttemptAt: Date,
  nextAttemptAt: Date,
  sentAt: Date,
  response: { type: Schema.Types.Mixed },
  error: { type: Schema.Types.Mixed },
  dedupeKey: { type: String, required: true },
}, { timestamps: true });

AlertSchema.index({ organizationId: 1, dedupeKey: 1 }, { unique: true });
export default model('Alert', AlertSchema);
