import type { SequenceChannel, SequenceDefinition, SequenceStep } from './sequenceDefinition'
import type { SuppressionReason } from './suppression'

/**
 * The data and provider surface the step runner depends on.
 *
 * The runner is written against these interfaces rather than against Mongoose
 * models on purpose. The behaviours that must never regress — a lease that
 * resumes after a crash, two workers producing exactly one send, a step
 * deferring rather than firing at 2am — are properties of the *algorithm*, and
 * an in-memory implementation of these ports proves them deterministically and
 * in milliseconds. The Mongo implementations in `mongoPorts.ts` are then a thin
 * translation layer with no branching logic of its own.
 *
 * This is the same technique `policyTransport` already uses with
 * `ConnectorSafetyStore`.
 */

export type Channel = SequenceChannel

export type StepLeaseStage = 'before_send' | 'send_started'

export interface ClaimedStep {
  id: string
  organizationId: string
  enrolmentId: string
  sequenceId: string
  stepIndex: number
  channel: Channel
  dueAt: Date
  attempts: number
}

export interface ScheduleStepInput {
  organizationId: string
  enrolmentId: string
  sequenceId: string
  stepIndex: number
  channel: Channel
  dueAt: Date
}

export interface LeaseRecoveryResult {
  /** Leases that expired before any provider call; safe to run again. */
  returnedToPending: number
  /** Leases that expired after a provider call began; outcome is unknown. */
  outcomeUnknown: number
}

export interface ScheduledStepStore {
  /**
   * Return expired leases to a safe state. Must run before claiming, and must
   * never blindly retry a step whose provider call had already begun.
   */
  recoverExpiredLeases(now: Date): Promise<LeaseRecoveryResult>
  /**
   * Atomically take ownership of one due step. Two concurrent callers must
   * never both receive the same step.
   */
  claimDueStep(input: { now: Date; leaseOwner: string; leaseMs: number }): Promise<ClaimedStep | null>
  /** Move the lease to the stage where a provider call may have happened. */
  markSendStarted(input: { stepId: string; organizationId: string; leaseOwner: string; leaseMs: number; now: Date }): Promise<boolean>
  complete(input: { stepId: string; organizationId: string; now: Date }): Promise<void>
  cancel(input: { stepId: string; organizationId: string; reason: string; now: Date }): Promise<void>
  /** Push a step forward without consuming an attempt. Used for quiet hours. */
  defer(input: { stepId: string; organizationId: string; dueAt: Date; now: Date }): Promise<void>
  /** Release for a later retry, or fail terminally when `retryAt` is absent. */
  fail(input: { stepId: string; organizationId: string; code: string; message: string; now: Date; retryAt?: Date }): Promise<void>
  markOutcomeUnknown(input: { stepId: string; organizationId: string; code: string; message: string; now: Date }): Promise<void>
  /** Idempotent: a duplicate (enrolment, stepIndex) is a no-op, not an error. */
  schedule(input: ScheduleStepInput): Promise<{ created: boolean; stepId: string }>
  cancelPendingForEnrolment(input: { organizationId: string; enrolmentId: string; reason: string; now: Date }): Promise<number>
}

export type EnrolmentStatus = 'active' | 'completed' | 'exited' | 'failed'
export type ExitReason = 'replied' | 'converted' | 'unsubscribed' | 'bounced' | 'manually_removed' | 'suppressed' | 'sequence_paused'

export interface EnrolmentView {
  id: string
  organizationId: string
  sequenceId: string
  sequenceVersionId: string
  contactId: string
  status: EnrolmentStatus
  stepIndex: number
  timeZone: string
}

export interface EnrolmentStore {
  find(input: { organizationId: string; enrolmentId: string }): Promise<EnrolmentView | null>
  advance(input: { organizationId: string; enrolmentId: string; fromStepIndex: number; toStepIndex: number; nextDueAt: Date | null; now: Date }): Promise<boolean>
  complete(input: { organizationId: string; enrolmentId: string; now: Date }): Promise<void>
  exit(input: { organizationId: string; enrolmentId: string; reason: ExitReason; now: Date }): Promise<void>
  fail(input: { organizationId: string; enrolmentId: string; code: string; message: string; now: Date }): Promise<void>
}

export interface VersionView {
  id: string
  sequenceStatus: 'draft' | 'active' | 'paused' | 'archived'
  definition: SequenceDefinition
}

export interface VersionStore {
  find(input: { organizationId: string; sequenceVersionId: string }): Promise<VersionView | null>
}

export interface ContactView {
  id: string
  email?: string
  phone?: string
  timeZone?: string
  firstName?: string
  lastName?: string
  name?: string
  fields: Record<string, unknown>
}

export interface ContactStore {
  find(input: { organizationId: string; contactId: string }): Promise<ContactView | null>
}

export type SendStatus = 'queued' | 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'failed' | 'suppressed' | 'outcome_unknown'

/** Statuses that prove a message reached, or may have reached, the recipient. */
export const TERMINAL_SEND_STATUSES: ReadonlySet<SendStatus> = new Set<SendStatus>([
  'sent', 'delivered', 'opened', 'clicked', 'bounced', 'suppressed', 'outcome_unknown',
])

export interface SendReservation {
  sendRecordId: string
  status: SendStatus
  /** False when a record already existed, which is how a double-send is caught. */
  created: boolean
  trackingToken: string
}

export interface SendLedger {
  /**
   * Write the intent to send BEFORE the provider is called. The unique index on
   * (organizationId, enrolmentId, stepIndex, channel) is what makes this a
   * guard rather than a hint.
   */
  reserve(input: {
    organizationId: string
    enrolmentId: string
    sequenceId: string
    contactId: string
    stepIndex: number
    channel: Channel
    recipientPreview: string
    recipientDigest: string
    messagingIdentityId: string | null
    now: Date
  }): Promise<SendReservation>
  markSent(input: { organizationId: string; sendRecordId: string; provider: string; providerMessageId?: string; now: Date }): Promise<void>
  markFailed(input: { organizationId: string; sendRecordId: string; code: string; message: string; now: Date }): Promise<void>
  markSuppressed(input: { organizationId: string; sendRecordId: string; reason: string; now: Date }): Promise<void>
  markOutcomeUnknown(input: { organizationId: string; sendRecordId: string; code: string; message: string; now: Date }): Promise<void>
}

export interface SuppressionPort {
  /** Resolves to a reason when the address must not be contacted. */
  check(input: { organizationId: string; channel: Channel; address: string }): Promise<{
    normalisedAddress: string
    addressDigest: string
    suppressedReason: SuppressionReason | 'unresolvable_address' | null
  }>
}

export interface DispatchRequest {
  organizationId: string
  channel: Channel
  step: SequenceStep
  contact: ContactView
  recipient: string
  enrolmentId: string
  stepIndex: number
  sendRecordId: string
  trackingToken: string
}

export interface DispatchResult {
  provider: string
  providerMessageId?: string
}

export class DispatchError extends Error {
  readonly code: string
  /** Retryable means: we can prove no message left, so sending again is safe. */
  readonly retryable: boolean
  /** True when a provider call began and its outcome cannot be established. */
  readonly outcomeUnknown: boolean
  constructor(input: { code: string; message: string; retryable?: boolean; outcomeUnknown?: boolean }) {
    super(input.message)
    this.name = 'DispatchError'
    this.code = input.code
    this.retryable = Boolean(input.retryable)
    this.outcomeUnknown = Boolean(input.outcomeUnknown)
  }
}

export interface ChannelDispatcher {
  send(request: DispatchRequest): Promise<DispatchResult>
}

export interface SequencePorts {
  steps: ScheduledStepStore
  enrolments: EnrolmentStore
  versions: VersionStore
  contacts: ContactStore
  sends: SendLedger
  suppression: SuppressionPort
  dispatcher: ChannelDispatcher
  now: () => Date
}

export type { SequenceDefinition, SequenceStep }
