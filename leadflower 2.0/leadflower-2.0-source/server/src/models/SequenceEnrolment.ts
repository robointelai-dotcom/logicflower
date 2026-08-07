import { Schema, model } from 'mongoose';

/**
 * One contact's progress through one pinned sequence version.
 *
 * Distinct from Execution on purpose. An Execution is a single workflow run
 * measured in seconds; an enrolment is a relationship with a person that lasts
 * weeks and must survive process restarts, deploys and Redis loss.
 *
 * The partial unique index is the enrolment-level duplicate guard: a contact
 * cannot be actively enrolled in the same sequence twice, however many triggers
 * fire. Completed and exited enrolments are excluded so a contact can be
 * legitimately re-enrolled later.
 */
const SequenceEnrolmentSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  sequenceId: { type: Schema.Types.ObjectId, required: true, index: true },
  /** Pinned at enrolment. Editing the sequence cannot change this. */
  sequenceVersionId: { type: Schema.Types.ObjectId, required: true },
  sequenceVersion: { type: Number, required: true },
  contactId: { type: Schema.Types.ObjectId, required: true, index: true },
  status: { type: String, enum: ['active', 'completed', 'exited', 'failed'], default: 'active', index: true },
  /** Index of the next step to run. Equals the step count when complete. */
  stepIndex: { type: Number, default: 0 },
  nextDueAt: { type: Date, default: null },
  exitReason: {
    type: String,
    enum: ['replied', 'converted', 'unsubscribed', 'bounced', 'manually_removed', 'suppressed', 'sequence_paused', null],
    default: null,
  },
  exitedAt: Date,
  completedAt: Date,
  /** Timezone snapshot so a mid-sequence contact edit cannot retime pending steps. */
  timeZone: { type: String, default: 'UTC' },
  /** How this enrolment started: a poll, a webhook, a manual action, an import. */
  source: { type: String, default: 'manual' },
  lastError: {
    code: String,
    message: String,
    at: Date,
  },
  enrolledBy: String,
}, { timestamps: true });

SequenceEnrolmentSchema.index(
  { organizationId: 1, sequenceId: 1, contactId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
SequenceEnrolmentSchema.index({ organizationId: 1, status: 1, nextDueAt: 1 });
SequenceEnrolmentSchema.index({ organizationId: 1, contactId: 1, createdAt: -1 });

export default model('SequenceEnrolment', SequenceEnrolmentSchema);
