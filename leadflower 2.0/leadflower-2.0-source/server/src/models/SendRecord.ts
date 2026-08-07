import { Schema, model } from 'mongoose';

/**
 * The record of one message on one channel for one enrolment step.
 *
 * Written BEFORE the provider call and updated with the outcome after. The
 * ordering is the whole point: if the record is written after the call and the
 * worker dies in between, the next worker sees no record and sends again. A
 * duplicate insert failing is a correct refusal to double-send.
 *
 * Duplicate-send prevention is enforced by the database, not by application
 * logic, because application logic cannot see the other worker.
 */
const SendRecordSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  enrolmentId: { type: Schema.Types.ObjectId, required: true, index: true },
  sequenceId: { type: Schema.Types.ObjectId, required: true },
  contactId: { type: Schema.Types.ObjectId, required: true, index: true },
  stepIndex: { type: Number, required: true },
  channel: { type: String, enum: ['email', 'sms', 'whatsapp'], required: true },
  status: {
    type: String,
    enum: ['queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed', 'suppressed', 'outcome_unknown'],
    default: 'queued',
    index: true,
  },
  /** Redacted for display. The full address lives on the Contact record. */
  recipientPreview: String,
  /** Keyed digest of the recipient, for correlating provider callbacks. */
  recipientDigest: { type: String, index: true },
  messagingIdentityId: { type: Schema.Types.ObjectId, default: null },
  provider: String,
  providerMessageId: { type: String, index: true },
  /** Unguessable token used by the tracking and unsubscribe endpoints. */
  trackingToken: { type: String, index: true },
  queuedAt: { type: Date, default: Date.now },
  sentAt: Date,
  deliveredAt: Date,
  openedAt: Date,
  clickedAt: Date,
  bouncedAt: Date,
  failedAt: Date,
  bounceType: { type: String, enum: ['hard', 'soft', 'complaint', null], default: null },
  suppressionReason: String,
  error: {
    code: String,
    message: String,
  },
}, { timestamps: true });

/**
 * The duplicate-send guard required by the build specification. Two workers
 * claiming the same step must produce exactly one send; the loser gets
 * E11000 and stops.
 */
SendRecordSchema.index({ organizationId: 1, enrolmentId: 1, stepIndex: 1, channel: 1 }, { unique: true });
SendRecordSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

export default model('SendRecord', SendRecordSchema);
