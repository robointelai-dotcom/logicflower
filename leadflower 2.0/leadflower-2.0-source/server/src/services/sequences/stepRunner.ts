import {
  DispatchError,
  TERMINAL_SEND_STATUSES,
  type ClaimedStep,
  type ExitReason,
  type SequencePorts,
} from './ports'
import { deferForQuietHours, isWithinQuietHours, nextStepDueAt, normaliseTimeZone } from './scheduleArithmetic'
import type { SequenceDefinition, SequenceStep } from './sequenceDefinition'

/**
 * Running one due step.
 *
 * The order of operations in `runClaimedStep` is the safety property of this
 * whole subsystem, so it is stated once here and then followed exactly:
 *
 *   1. Claim atomically, with a lease. Only one worker holds a step.
 *   2. Re-read the enrolment and the pinned version. Both may have changed
 *      since the step was scheduled, possibly days ago.
 *   3. Evaluate exit conditions BEFORE doing anything else. A contact who
 *      unsubscribed yesterday must not receive today's step.
 *   4. Defer for quiet hours. Deferral is not a failure and does not consume an
 *      attempt; the step keeps its place and fires when sending resumes.
 *   5. Reserve the send in the database, before the provider call. A duplicate
 *      key here means another worker already owns this send: stop, do not send.
 *   6. Only now move the lease to `send_started` and call the provider.
 *   7. Record the outcome, then advance the enrolment and schedule the next
 *      step.
 *
 * Steps 5 and 6 are the pair that prevents double-sending. Reversing them —
 * calling the provider and then writing the record — means a crash in between
 * loses all evidence that a message went out, and the retry sends it again.
 */

export type StepOutcomeKind =
  | 'idle'
  | 'sent'
  | 'deferred'
  | 'exited'
  | 'completed'
  | 'cancelled'
  | 'duplicate_suppressed'
  | 'failed'
  | 'outcome_unknown'

export interface StepOutcome {
  kind: StepOutcomeKind
  stepId?: string
  enrolmentId?: string
  reason?: string
}

const DEFAULT_LEASE_MS = 120_000
/** Attempts before a step is failed terminally rather than retried. */
export const MAX_STEP_ATTEMPTS = 5
/** Backoff for retryable dispatch failures, in minutes, by attempt number. */
const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60]

function retryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MINUTES.length) - 1
  return (RETRY_BACKOFF_MINUTES[index] ?? 60) * 60_000
}

function recipientFor(channel: string, contact: { email?: string; phone?: string }): string {
  return String((channel === 'email' ? contact.email : contact.phone) || '').trim()
}

function redactedRecipient(channel: string, address: string): string {
  if (!address) return ''
  if (channel === 'email') {
    const [local = '', domain = ''] = address.split('@')
    return domain ? `${local.slice(0, 1)}***@${domain}` : '***'
  }
  return address.length <= 8 ? `${address.slice(0, 2)}***` : `${address.slice(0, 5)}***${address.slice(-4)}`
}

/**
 * Where does the next step's clock start?
 *
 * From the moment this step completed, not from when it was originally due. A
 * step deferred overnight for quiet hours should not compress the gap before
 * the following step down to nothing.
 */
export function planNextStep(input: {
  definition: SequenceDefinition
  completedStepIndex: number
  completedAt: Date
  timeZone: string
}): { nextStepIndex: number; nextStep: SequenceStep; dueAt: Date } | null {
  const nextStepIndex = input.completedStepIndex + 1
  const nextStep = input.definition.steps[nextStepIndex]
  if (!nextStep) return null
  const dueAt = nextStepDueAt({
    from: input.completedAt,
    wait: nextStep.wait,
    quietHours: input.definition.quietHours,
    timeZone: input.timeZone,
  })
  return { nextStepIndex, nextStep, dueAt }
}

async function exitEnrolment(ports: SequencePorts, input: {
  organizationId: string
  enrolmentId: string
  stepId: string
  reason: ExitReason
  now: Date
}): Promise<StepOutcome> {
  await ports.steps.cancel({ stepId: input.stepId, organizationId: input.organizationId, reason: input.reason, now: input.now })
  await ports.steps.cancelPendingForEnrolment({ organizationId: input.organizationId, enrolmentId: input.enrolmentId, reason: input.reason, now: input.now })
  await ports.enrolments.exit({ organizationId: input.organizationId, enrolmentId: input.enrolmentId, reason: input.reason, now: input.now })
  return { kind: 'exited', stepId: input.stepId, enrolmentId: input.enrolmentId, reason: input.reason }
}

/**
 * Execute a step that has already been claimed.
 *
 * Split from `runNextDueStep` so a test can drive a specific step without
 * racing the claim query, and so the claim can be exercised on its own.
 */
export async function runClaimedStep(ports: SequencePorts, claimed: ClaimedStep, options: { leaseOwner: string; leaseMs?: number } = { leaseOwner: 'worker' }): Promise<StepOutcome> {
  const now = ports.now()
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const organizationId = claimed.organizationId

  const enrolment = await ports.enrolments.find({ organizationId, enrolmentId: claimed.enrolmentId })
  if (!enrolment) {
    await ports.steps.cancel({ stepId: claimed.id, organizationId, reason: 'enrolment_missing', now })
    return { kind: 'cancelled', stepId: claimed.id, reason: 'enrolment_missing' }
  }
  if (enrolment.status !== 'active') {
    // The enrolment was exited or completed between scheduling and now — by an
    // operator, a reply signal or a suppression event. The step is void.
    await ports.steps.cancel({ stepId: claimed.id, organizationId, reason: `enrolment_${enrolment.status}`, now })
    return { kind: 'cancelled', stepId: claimed.id, enrolmentId: enrolment.id, reason: `enrolment_${enrolment.status}` }
  }
  if (enrolment.stepIndex !== claimed.stepIndex) {
    // A scheduled step that no longer matches the enrolment's cursor is stale.
    // Running it would either repeat a step or skip one.
    await ports.steps.cancel({ stepId: claimed.id, organizationId, reason: 'step_superseded', now })
    return { kind: 'cancelled', stepId: claimed.id, enrolmentId: enrolment.id, reason: 'step_superseded' }
  }

  const version = await ports.versions.find({ organizationId, sequenceVersionId: enrolment.sequenceVersionId })
  if (!version) {
    await ports.steps.fail({ stepId: claimed.id, organizationId, code: 'SEQUENCE_VERSION_MISSING', message: 'The pinned sequence version could not be loaded', now })
    await ports.enrolments.fail({ organizationId, enrolmentId: enrolment.id, code: 'SEQUENCE_VERSION_MISSING', message: 'The pinned sequence version could not be loaded', now })
    return { kind: 'failed', stepId: claimed.id, enrolmentId: enrolment.id, reason: 'SEQUENCE_VERSION_MISSING' }
  }

  // A paused sequence stops sending immediately. Enrolments are exited rather
  // than left pending, so an operator who pauses does not discover a backlog
  // firing when they resume weeks later.
  if (version.sequenceStatus === 'paused' || version.sequenceStatus === 'archived') {
    return exitEnrolment(ports, { organizationId, enrolmentId: enrolment.id, stepId: claimed.id, reason: 'sequence_paused', now })
  }

  const step = version.definition.steps[claimed.stepIndex]
  if (!step) {
    // The enrolment has run past the end of its pinned version.
    await ports.steps.complete({ stepId: claimed.id, organizationId, now })
    await ports.enrolments.complete({ organizationId, enrolmentId: enrolment.id, now })
    return { kind: 'completed', stepId: claimed.id, enrolmentId: enrolment.id }
  }

  const timeZone = normaliseTimeZone(enrolment.timeZone || version.definition.defaultTimeZone)

  // Quiet hours are evaluated against the moment of execution, not the moment
  // the step was scheduled. A step that was due at 20:55 but is only picked up
  // at 21:05 must still respect the window.
  if (isWithinQuietHours(now, version.definition.quietHours, timeZone)) {
    const resumeAt = deferForQuietHours(now, version.definition.quietHours, timeZone)
    await ports.steps.defer({ stepId: claimed.id, organizationId, dueAt: resumeAt, now })
    return { kind: 'deferred', stepId: claimed.id, enrolmentId: enrolment.id, reason: 'quiet_hours' }
  }

  const contact = await ports.contacts.find({ organizationId, contactId: enrolment.contactId })
  if (!contact) {
    return exitEnrolment(ports, { organizationId, enrolmentId: enrolment.id, stepId: claimed.id, reason: 'manually_removed', now })
  }

  const address = recipientFor(step.channel, contact)
  if (!address) {
    // No address on this channel is a permanent condition for this contact, not
    // a transient error. Retrying it every hour for five hours helps nobody.
    return exitEnrolment(ports, { organizationId, enrolmentId: enrolment.id, stepId: claimed.id, reason: 'suppressed', now })
  }

  // Exit condition: suppression, checked before every send on every channel.
  // Unsubscribes, hard bounces and complaints all arrive here, so honouring
  // this one check honours onUnsubscribed and onBounced together.
  const suppression = await ports.suppression.check({ organizationId, channel: step.channel, address })
  if (suppression.suppressedReason) {
    const reason: ExitReason = suppression.suppressedReason === 'unsubscribed'
      ? 'unsubscribed'
      : suppression.suppressedReason === 'hard_bounce'
        ? 'bounced'
        : 'suppressed'
    return exitEnrolment(ports, { organizationId, enrolmentId: enrolment.id, stepId: claimed.id, reason, now })
  }

  // Reserve before dispatch. This is the duplicate-send guard.
  const reservation = await ports.sends.reserve({
    organizationId,
    enrolmentId: enrolment.id,
    sequenceId: enrolment.sequenceId,
    contactId: contact.id,
    stepIndex: claimed.stepIndex,
    channel: step.channel,
    recipientPreview: redactedRecipient(step.channel, suppression.normalisedAddress || address),
    recipientDigest: suppression.addressDigest,
    messagingIdentityId: step.messagingIdentityId,
    now,
  })

  if (!reservation.created && TERMINAL_SEND_STATUSES.has(reservation.status)) {
    // Another worker already sent this, or a previous attempt's outcome cannot
    // be established. Either way, sending now would be a duplicate. Advance the
    // enrolment rather than stalling it: the message is out.
    await ports.steps.complete({ stepId: claimed.id, organizationId, now })
    const advanced = await advanceAfterSend(ports, { enrolment, version, claimedStepIndex: claimed.stepIndex, timeZone, now })
    return { ...advanced, kind: 'duplicate_suppressed', stepId: claimed.id, enrolmentId: enrolment.id, reason: reservation.status }
  }

  const movedToSending = await ports.steps.markSendStarted({ stepId: claimed.id, organizationId, leaseOwner: options.leaseOwner, leaseMs, now })
  if (!movedToSending) {
    // The lease was lost — almost certainly to a recovery sweep that already
    // reclassified this step. Do not call the provider without a held lease.
    return { kind: 'cancelled', stepId: claimed.id, enrolmentId: enrolment.id, reason: 'lease_lost' }
  }

  try {
    const result = await ports.dispatcher.send({
      organizationId,
      channel: step.channel,
      step,
      contact,
      recipient: suppression.normalisedAddress || address,
      enrolmentId: enrolment.id,
      stepIndex: claimed.stepIndex,
      sendRecordId: reservation.sendRecordId,
      trackingToken: reservation.trackingToken,
    })
    const sentAt = ports.now()
    await ports.sends.markSent({ organizationId, sendRecordId: reservation.sendRecordId, provider: result.provider, providerMessageId: result.providerMessageId, now: sentAt })
    await ports.steps.complete({ stepId: claimed.id, organizationId, now: sentAt })
    const advanced = await advanceAfterSend(ports, { enrolment, version, claimedStepIndex: claimed.stepIndex, timeZone, now: sentAt })
    return { ...advanced, kind: advanced.kind === 'completed' ? 'completed' : 'sent', stepId: claimed.id, enrolmentId: enrolment.id }
  } catch (error: any) {
    const failedAt = ports.now()
    const dispatchError = error instanceof DispatchError
      ? error
      : new DispatchError({ code: 'DISPATCH_FAILED', message: String(error?.message || 'Provider dispatch failed'), outcomeUnknown: true })

    if (dispatchError.outcomeUnknown) {
      // A call that began and did not return a verdict may have delivered. The
      // only safe action is to stop and surface it: an automatic retry here is
      // how a customer receives the same message twice.
      await ports.sends.markOutcomeUnknown({ organizationId, sendRecordId: reservation.sendRecordId, code: dispatchError.code, message: dispatchError.message, now: failedAt })
      await ports.steps.markOutcomeUnknown({ stepId: claimed.id, organizationId, code: dispatchError.code, message: dispatchError.message, now: failedAt })
      return { kind: 'outcome_unknown', stepId: claimed.id, enrolmentId: enrolment.id, reason: dispatchError.code }
    }

    await ports.sends.markFailed({ organizationId, sendRecordId: reservation.sendRecordId, code: dispatchError.code, message: dispatchError.message, now: failedAt })
    const attempts = claimed.attempts + 1
    if (dispatchError.retryable && attempts < MAX_STEP_ATTEMPTS) {
      await ports.steps.fail({
        stepId: claimed.id,
        organizationId,
        code: dispatchError.code,
        message: dispatchError.message,
        now: failedAt,
        retryAt: new Date(failedAt.getTime() + retryDelayMs(attempts)),
      })
      return { kind: 'failed', stepId: claimed.id, enrolmentId: enrolment.id, reason: `${dispatchError.code}:retry_scheduled` }
    }
    await ports.steps.fail({ stepId: claimed.id, organizationId, code: dispatchError.code, message: dispatchError.message, now: failedAt })
    await ports.enrolments.fail({ organizationId, enrolmentId: enrolment.id, code: dispatchError.code, message: dispatchError.message, now: failedAt })
    return { kind: 'failed', stepId: claimed.id, enrolmentId: enrolment.id, reason: dispatchError.code }
  }
}

async function advanceAfterSend(ports: SequencePorts, input: {
  enrolment: { id: string; organizationId: string; sequenceId: string }
  version: { definition: SequenceDefinition }
  claimedStepIndex: number
  timeZone: string
  now: Date
}): Promise<StepOutcome> {
  const plan = planNextStep({
    definition: input.version.definition,
    completedStepIndex: input.claimedStepIndex,
    completedAt: input.now,
    timeZone: input.timeZone,
  })
  const organizationId = input.enrolment.organizationId

  if (!plan) {
    await ports.enrolments.advance({
      organizationId,
      enrolmentId: input.enrolment.id,
      fromStepIndex: input.claimedStepIndex,
      toStepIndex: input.claimedStepIndex + 1,
      nextDueAt: null,
      now: input.now,
    })
    await ports.enrolments.complete({ organizationId, enrolmentId: input.enrolment.id, now: input.now })
    return { kind: 'completed', enrolmentId: input.enrolment.id }
  }

  // Advance the cursor first, then schedule. A scheduled step whose index does
  // not match the enrolment cursor is treated as stale and cancelled, so
  // scheduling before advancing would race against the worker picking it up.
  await ports.enrolments.advance({
    organizationId,
    enrolmentId: input.enrolment.id,
    fromStepIndex: input.claimedStepIndex,
    toStepIndex: plan.nextStepIndex,
    nextDueAt: plan.dueAt,
    now: input.now,
  })
  await ports.steps.schedule({
    organizationId,
    enrolmentId: input.enrolment.id,
    sequenceId: input.enrolment.sequenceId,
    stepIndex: plan.nextStepIndex,
    channel: plan.nextStep.channel,
    dueAt: plan.dueAt,
  })
  return { kind: 'sent', enrolmentId: input.enrolment.id }
}

/**
 * Claim and run one due step, if there is one.
 *
 * Recovery runs first, every pass. A worker that starts after a crash must
 * reclassify the previous worker's abandoned leases before it competes for new
 * work, or an abandoned step sits at `processing` until someone notices.
 */
export async function runNextDueStep(ports: SequencePorts, options: { leaseOwner: string; leaseMs?: number }): Promise<StepOutcome> {
  const now = ports.now()
  await ports.steps.recoverExpiredLeases(now)
  const claimed = await ports.steps.claimDueStep({ now, leaseOwner: options.leaseOwner, leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS })
  if (!claimed) return { kind: 'idle' }
  return runClaimedStep(ports, claimed, options)
}

/** Drain up to `max` due steps. Returns as soon as there is nothing due. */
export async function runDueSteps(ports: SequencePorts, options: { leaseOwner: string; leaseMs?: number; max?: number }): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = []
  const max = Math.max(1, Math.min(options.max ?? 50, 500))
  for (let index = 0; index < max; index += 1) {
    const outcome = await runNextDueStep(ports, options)
    if (outcome.kind === 'idle') break
    outcomes.push(outcome)
  }
  return outcomes
}
