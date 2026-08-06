import { Schema, model } from 'mongoose';

const WebhookKeySchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  workflowId: { type: Schema.Types.ObjectId, ref: 'Workflow' },
  key: { type: String, unique: true, index: true },
  label: String,
  enabled: { type: Boolean, default: true },
  hmacSecretCiphertext: { type: String, select: false },
  provider: { type: String, default: 'generic' },
  connectionId: { type: Schema.Types.ObjectId },
}, { timestamps: true });

WebhookKeySchema.index({ organizationId: 1, key: 1 }, { unique: true });

export default model('WebhookKey', WebhookKeySchema);
