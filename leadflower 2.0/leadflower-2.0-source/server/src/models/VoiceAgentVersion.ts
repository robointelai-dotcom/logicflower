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
  direction: { type: String, enum: ['inbound', 'outbound'], default: 'outbound' },
  agentType: { type: String, enum: ['sales_representative', 'support_agent', 'lead_engagement'], default: 'lead_engagement' },
  tone: String,
  goal: String,
  background: String,
  /** Only a sales representative follows this. */
  script: String,
  welcomeMessage: String,
  welcomeMessageDelaySeconds: { type: Number, default: 2 },
  voicemailDetection: { type: Boolean, default: false },
  voicemailAction: { type: String, enum: ['leave_message', 'hang_up'], default: 'hang_up' },
  voicemailMessage: String,
  machineTimeoutSeconds: { type: Number, default: 10 },
  /**
   * What the agent must refuse, and the words to say instead.
   *
   * The platform's answer resolution falls through script, instructions and
   * knowledge base to the language model's own general knowledge — so an
   * under-instructed agent improvises rather than declining. These are the
   * explicit stops.
   */
  restrictedTopics: { type: [{ topic: String, refusalWording: String }], default: [] },
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
