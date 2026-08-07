import { Schema, model } from 'mongoose';

/**
 * A queued outbound call attempt.
 *
 * Same durable-lease shape as ScheduledStep and ScheduledPost, for the same
 * reason. The two-stage lease matters most of all here: `dial_started` means a
 * call may already be ringing a real person's phone, and a blind retry rings
 * them twice.
 *
 * `earliestAt` carries deferrals. A job blocked by a calling window is pushed
 * to the next permitted local instant rather than dropped, so a lead generated
 * at 10pm is called at 9am rather than lost.
 */
const DialerJobSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, required: true, index: true },
  voiceAgentId: { type: Schema.Types.ObjectId, required: true },
  dealId: { type: Schema.Types.ObjectId, default: null },
  earliestAt: { type: Date, required: true },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'cancelled', 'failed', 'blocked', 'outcome_unknown'],
    default: 'pending',
    index: true,
  },
  leaseStage: { type: String, enum: ['before_dial', 'dial_started', null], default: null },
  leaseExpiresAt: { type: Date, default: null },
  leaseOwner: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 3 },
  deferralCount: { type: Number, default: 0 },
  blockedReason: String,
  voiceCallId: { type: Schema.Types.ObjectId, default: null },
  /** 'speed_to_lead' | 'stage_change' | 'manual' | 'campaign'. */
  source: { type: String, default: 'manual' },
  /** Caller ID to dial from. Must be registered for outbound in the jurisdiction. */
  fromNumber: { type: String, default: null },
  /**
   * Explicit assertion that a lawful basis for calling this contact exists.
   * Not inferred from the presence of a phone number — a number in a CRM is
   * not permission — so it must be set deliberately when the job is queued.
   */
  consentRecorded: { type: Boolean, default: false },
  lastError: { code: String, message: String, at: Date },
}, { timestamps: true });

/** One outstanding job per contact per agent: a retriggered event does not double-dial. */
DialerJobSchema.index(
  { organizationId: 1, contactId: 1, voiceAgentId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'processing'] } } },
);
DialerJobSchema.index({ status: 1, earliestAt: 1 });
DialerJobSchema.index({ status: 1, leaseExpiresAt: 1 });

export default model('DialerJob', DialerJobSchema);
