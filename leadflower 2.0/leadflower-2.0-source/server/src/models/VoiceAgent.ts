import { Schema, model } from 'mongoose';

/** A voice agent's identity and lifecycle. Executable content lives in VoiceAgentVersion. */
const VoiceAgentSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  description: String,
  status: { type: String, enum: ['draft', 'active', 'paused', 'archived'], default: 'draft', index: true },
  latestVersion: { type: Number, default: 0 },
  publishedVersionId: { type: Schema.Types.ObjectId, default: null },
  createdBy: String,
}, { timestamps: true });

VoiceAgentSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export default model('VoiceAgent', VoiceAgentSchema);
