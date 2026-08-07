import { Schema, model } from 'mongoose';

/**
 * An immutable snapshot of an agent's script and disclosures.
 *
 * Pinned per call. Editing an agent must not change what a call already in
 * progress will say — the same guarantee WorkflowVersion gives an Execution and
 * SequenceVersion gives an enrolment, and it matters more here: after a
 * complaint, the question is "what exactly did it say to them", and the answer
 * has to be a document nobody could have edited since.
 */
const VoiceAgentVersionSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  voiceAgentId: { type: Schema.Types.ObjectId, required: true, index: true },
  version: { type: Number, required: true },
  definitionHash: { type: String, required: true },
  prompt: { type: String, required: true },
  voiceId: String,
  language: { type: String, default: 'en' },
  permittedActions: { type: [String], default: [] },
  maxCallSeconds: { type: Number, default: 300 },
  disclosures: {
    aiDisclosureText: { type: String, required: true },
    recordingEnabled: { type: Boolean, default: false },
    recordingConsentText: String,
    optOutPhrases: { type: [String], default: [] },
  },
  createdBy: String,
}, { timestamps: true });

VoiceAgentVersionSchema.index({ organizationId: 1, voiceAgentId: 1, version: 1 }, { unique: true });

export default model('VoiceAgentVersion', VoiceAgentVersionSchema);
