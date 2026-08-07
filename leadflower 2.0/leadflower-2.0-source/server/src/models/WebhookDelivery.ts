import { Schema, model } from 'mongoose';
const WebhookDeliverySchema = new Schema({
  organizationId: { type: String, required: true, index: true }, webhookEventId: { type: Schema.Types.ObjectId, ref: 'WebhookEvent', required: true, index: true },
  workflowId: { type: Schema.Types.ObjectId, ref: 'Workflow', required: true }, startNodeId: { type: String, required: true }, triggerKind: { type: String, required: true },
  status: { type: String, enum: ['pending', 'queued', 'processed', 'failed'], default: 'pending', index: true }, attempts: { type: Number, default: 0 }, lastError: String,
}, { timestamps: true });
WebhookDeliverySchema.index({ organizationId: 1, webhookEventId: 1, workflowId: 1 }, { unique: true });
export default model('WebhookDelivery', WebhookDeliverySchema);
