import { Schema, model } from 'mongoose';

/**
 * One call.
 *
 * Transcripts are ENCRYPTED at rest with a per-record AAD. A call transcript is
 * the most sensitive artefact this system produces: it is a verbatim record of
 * what a person said, captured without them typing it, and in the healthcare
 * vertical it will contain things nobody intended to store.
 *
 * Recordings are referenced, never held. The audio stays with the telephony
 * provider under a retention policy this system records and enforces by
 * requesting deletion; copying it here would double the number of places a
 * recording has to be found and destroyed.
 */
const VoiceCallSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, default: null, index: true },
  dealId: { type: Schema.Types.ObjectId, default: null },
  /** Pinned at dial time. Editing the agent cannot change this. */
  voiceAgentId: { type: Schema.Types.ObjectId, default: null },
  voiceAgentVersionId: { type: Schema.Types.ObjectId, default: null },
  agentDefinitionHash: String,
  direction: { type: String, enum: ['outbound', 'inbound'], required: true },
  status: {
    type: String,
    enum: ['queued', 'blocked', 'dialing', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'cancelled'],
    default: 'queued',
    index: true,
  },
  /** Why a call was refused before dialling. Never blank when status is blocked. */
  blockedReason: String,
  toNumberPreview: String,
  providerCallId: { type: String, index: true },
  provider: String,
  startedAt: Date,
  answeredAt: Date,
  endedAt: Date,
  durationSeconds: { type: Number, default: 0 },

  /** Evidence that the required announcements were made. */
  disclosures: {
    aiDisclosureSpokenAt: Date,
    recordingConsentSpokenAt: Date,
    recordingEnabled: { type: Boolean, default: false },
  },
  /** Set when the recipient asked not to be called again, mid-call. */
  optedOutAt: { type: Date, default: null },
  optOutPhraseMatched: String,

  /** Encrypted transcript envelope. Never selected by default. */
  transcriptCiphertext: { type: String, select: false },
  /** Encrypted AI summary envelope. Never selected by default. */
  summaryCiphertext: { type: String, select: false },
  /** Provider-side recording identifier. The audio is not copied here. */
  recordingReference: String,
  recordingDeletedAt: { type: Date, default: null },

  outcomeTags: { type: [String], default: [] },
  /**
   * Sentiment as reported by the provider, with its source recorded. Presented
   * as a provider's opinion, never as a fact about how the person felt.
   */
  sentiment: {
    label: { type: String, enum: ['positive', 'neutral', 'negative', null], default: null },
    source: String,
  },
  /** When transcript and recording must be destroyed. */
  retainUntil: { type: Date, default: null },
  lastError: { code: String, message: String, at: Date },
}, { timestamps: true });

VoiceCallSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
VoiceCallSchema.index({ organizationId: 1, contactId: 1, createdAt: -1 });
VoiceCallSchema.index({ retainUntil: 1 });

export default model('VoiceCall', VoiceCallSchema);
