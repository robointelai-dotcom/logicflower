import { Schema, model } from 'mongoose';

/**
 * An immutable, executable snapshot of a sequence.
 *
 * Nothing in this document is updated after creation. Publishing a change
 * creates a new version; enrolments already running keep pointing at the old
 * one until they finish. `definitionHash` is the canonical hash of the steps,
 * so an operator can prove which content a given enrolment actually ran.
 */
const SequenceStepSchema = new Schema({
  stepIndex: { type: Number, required: true },
  channel: { type: String, enum: ['email', 'sms', 'whatsapp'], required: true },
  /** Wait before this step, measured from the previous step's completion. */
  wait: {
    kind: { type: String, enum: ['immediate', 'duration', 'time_of_day'], required: true },
    minutes: Number,
    hour: Number,
    minute: Number,
    afterMinutes: Number,
  },
  /** Sending identity to use. Resolved at send time and re-checked per send. */
  messagingIdentityId: { type: Schema.Types.ObjectId, default: null },
  subjectTemplate: String,
  bodyTemplate: String,
  /** WhatsApp only: an approved template name and its ordered variables. */
  whatsappTemplate: {
    name: String,
    languageCode: String,
    variables: { type: [String], default: undefined },
  },
}, { _id: false });

const SequenceVersionSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  sequenceId: { type: Schema.Types.ObjectId, required: true, index: true },
  version: { type: Number, required: true },
  definitionHash: { type: String, required: true },
  steps: { type: [SequenceStepSchema], default: [] },
  /**
   * Conditions that remove a contact from this sequence. Evaluated before
   * every step, never only at enrolment.
   */
  exitConditions: {
    onReply: { type: Boolean, default: true },
    onConverted: { type: Boolean, default: true },
    onUnsubscribed: { type: Boolean, default: true },
    onBounced: { type: Boolean, default: true },
  },
  quietHours: {
    enabled: { type: Boolean, default: false },
    startMinute: { type: Number, default: 1_260 },
    endMinute: { type: Number, default: 480 },
  },
  /** Used when a contact has no timezone of its own. */
  defaultTimeZone: { type: String, default: 'UTC' },
  createdBy: String,
}, { timestamps: true });

SequenceVersionSchema.index({ organizationId: 1, sequenceId: 1, version: 1 }, { unique: true });

export default model('SequenceVersion', SequenceVersionSchema);
