import { Schema, model } from 'mongoose';

const WebhookEventSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  provider: { type: String, required: true, index: true },
  sourceId: { type: String, required: true },
  connectionId: { type: Schema.Types.ObjectId, index: true },
  eventId: { type: String, required: true },
  eventType: { type: String, required: true, index: true },
  occurredAt: Date,
  receivedAt: { type: Date, default: Date.now, required: true },
  subject: { type: Schema.Types.Mixed },
  payloadCiphertext: { type: String, required: true, select: false },
  headers: { type: Schema.Types.Mixed },
  status: { type: String, enum: ['received', 'queued', 'processed', 'failed'], default: 'received', index: true },
  workflowIds: [{ type: Schema.Types.ObjectId, ref: 'Workflow' }],
  error: { type: Schema.Types.Mixed },
}, { timestamps: true });

WebhookEventSchema.index({ organizationId: 1, provider: 1, sourceId: 1, eventId: 1 }, { unique: true });

export default model('WebhookEvent', WebhookEventSchema);
