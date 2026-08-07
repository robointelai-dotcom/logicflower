import { Schema, model } from 'mongoose';

/**
 * A durable, persisted intent to run one step of one enrolment at one time.
 *
 * This collection is the reason the sequence engine can wait for days. The
 * workflow engine's `control.delay` parks a BullMQ job in Redis, which is fine
 * for seconds and unsafe for weeks: a Redis flush loses every pending wait, and
 * nothing in the system notices. Here, MongoDB is the source of truth and Redis
 * is only a work queue. Losing Redis entirely must lose nothing — the scheduler
 * re-derives its work from `dueAt` on this collection.
 *
 * The lease fields follow the two-stage pattern in batchService: `before_send`
 * means no provider call has been attempted and the step is safe to return to
 * `pending`; `send_started` means a message may already be with a provider, so
 * an expired lease resolves to `outcome_unknown` and waits for a human or a
 * delivery callback rather than blindly re-sending.
 */
const ScheduledStepSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  enrolmentId: { type: Schema.Types.ObjectId, required: true, index: true },
  sequenceId: { type: Schema.Types.ObjectId, required: true },
  stepIndex: { type: Number, required: true },
  channel: { type: String, enum: ['email', 'sms', 'whatsapp'], required: true },
  dueAt: { type: Date, required: true },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'cancelled', 'failed', 'outcome_unknown'],
    default: 'pending',
    index: true,
  },
  leaseStage: { type: String, enum: ['before_send', 'send_started', null], default: null },
  leaseExpiresAt: { type: Date, default: null },
  /** Which worker holds the lease. Diagnostic only; correctness rests on the atomic claim. */
  leaseOwner: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  /** Set when a step was moved forward out of a quiet window, for operator visibility. */
  deferredFrom: { type: Date, default: null },
  deferralCount: { type: Number, default: 0 },
  startedAt: Date,
  finishedAt: Date,
  lastError: {
    code: String,
    message: String,
    at: Date,
  },
}, { timestamps: true });

/**
 * Exactly one scheduled step per enrolment step. Two triggers racing to
 * schedule the same step produce one row and one duplicate-key error, rather
 * than two rows and two sends.
 */
ScheduledStepSchema.index({ organizationId: 1, enrolmentId: 1, stepIndex: 1 }, { unique: true });
/** The claim query: due, pending, oldest first. */
ScheduledStepSchema.index({ status: 1, dueAt: 1 });
/** Lease-recovery sweep. */
ScheduledStepSchema.index({ status: 1, leaseExpiresAt: 1 });

export default model('ScheduledStep', ScheduledStepSchema);
