import { describe, expect, it } from 'vitest'
import { DispatchError, type ClaimedStep, type EnrolmentView, type VersionView } from '../src/services/sequences/ports'
import { runClaimedStep, runDueSteps, runNextDueStep } from '../src/services/sequences/stepRunner'
import { canonicaliseSequenceDefinition } from '../src/services/sequences/sequenceDefinition'
import { localMinuteOfDay } from '../src/services/sequences/scheduleArithmetic'
import { createHarness, type TestHarness } from './support/sequenceTestPorts'

const ORG = 'org-1'
const OTHER_ORG = 'org-2'
const IST = 'Asia/Kolkata'

function definition(overrides: Partial<Parameters<typeof canonicaliseSequenceDefinition>[0]> = {}) {
  return canonicaliseSequenceDefinition({
    steps: [
      { channel: 'email', wait: { kind: 'immediate' }, subjectTemplate: 'Hello {{contact.firstName}}', bodyTemplate: 'First touch' },
      { channel: 'sms', wait: { kind: 'duration', minutes: 3 * 24 * 60 }, bodyTemplate: 'Second touch' },
      { channel: 'email', wait: { kind: 'duration', minutes: 60 }, subjectTemplate: 'Last', bodyTemplate: 'Third touch' },
    ],
    ...(overrides as Record<string, unknown>),
  })
}

function seed(harness: TestHarness, options: {
  definitionOverrides?: Record<string, unknown>
  sequenceStatus?: VersionView['sequenceStatus']
  timeZone?: string
  organizationId?: string
} = {}) {
  const organizationId = options.organizationId ?? ORG
  const version: VersionView = {
    id: 'version-1',
    sequenceStatus: options.sequenceStatus ?? 'active',
    definition: definition(options.definitionOverrides),
  }
  harness.versions.seed(version)
  const enrolment: EnrolmentView = {
    id: 'enrolment-1',
    organizationId,
    sequenceId: 'sequence-1',
    sequenceVersionId: 'version-1',
    contactId: 'contact-1',
    status: 'active',
    stepIndex: 0,
    timeZone: options.timeZone ?? 'UTC',
  }
  harness.enrolments.seed(enrolment)
  harness.contacts.seed(organizationId, {
    id: 'contact-1',
    email: 'lead@example.com',
    phone: '+919876543210',
    firstName: 'Asha',
    fields: {},
  })
  return { version, enrolment, organizationId }
}

async function scheduleFirstStep(harness: TestHarness, organizationId = ORG) {
  return harness.steps.schedule({
    organizationId,
    enrolmentId: 'enrolment-1',
    sequenceId: 'sequence-1',
    stepIndex: 0,
    channel: 'email',
    dueAt: harness.clock.now(),
  })
}

describe('sequence step runner', () => {
  it('sends a due step, advances the cursor and schedules the next step', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)

    const outcome = await runNextDueStep(harness, { leaseOwner: 'worker-a' })

    expect(outcome.kind).toBe('sent')
    expect(harness.dispatcher.calls).toHaveLength(1)
    expect(harness.dispatcher.calls[0]?.recipient).toBe('lead@example.com')
    expect(harness.sends.sentCount()).toBe(1)

    const enrolment = await harness.enrolments.find({ organizationId: ORG, enrolmentId: 'enrolment-1' })
    expect(enrolment?.stepIndex).toBe(1)

    // The next step is scheduled three days out, not run now.
    const pending = [...harness.steps.rows.values()].filter((row) => row.status === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.stepIndex).toBe(1)
    expect((pending[0]?.dueAt.getTime() ?? 0) - harness.clock.now().getTime()).toBe(3 * 24 * 60 * 60_000)

    // Nothing else is due, so a second pass is idle rather than sending again.
    expect((await runNextDueStep(harness, { leaseOwner: 'worker-a' })).kind).toBe('idle')
    expect(harness.dispatcher.calls).toHaveLength(1)
  })

  it('does not fire a step before it is due, and fires it afterwards', async () => {
    const harness = createHarness()
    seed(harness)
    await harness.steps.schedule({
      organizationId: ORG,
      enrolmentId: 'enrolment-1',
      sequenceId: 'sequence-1',
      stepIndex: 0,
      channel: 'email',
      dueAt: new Date(harness.clock.now().getTime() + 3 * 24 * 60 * 60_000),
    })

    expect((await runNextDueStep(harness, { leaseOwner: 'worker-a' })).kind).toBe('idle')
    expect(harness.dispatcher.calls).toHaveLength(0)

    harness.clock.advanceMinutes(3 * 24 * 60)
    expect((await runNextDueStep(harness, { leaseOwner: 'worker-a' })).kind).toBe('sent')
    expect(harness.dispatcher.calls).toHaveLength(1)
  })

  it('resumes a step after a crash mid-wait and still fires it at the right time', async () => {
    // The acceptance test the build specification names: kill the process
    // mid-wait, restart, the step still fires. The wait lives in MongoDB, so
    // losing the worker (and with it any Redis job) loses nothing.
    const harness = createHarness()
    seed(harness)
    await harness.steps.schedule({
      organizationId: ORG,
      enrolmentId: 'enrolment-1',
      sequenceId: 'sequence-1',
      stepIndex: 0,
      channel: 'email',
      dueAt: new Date(harness.clock.now().getTime() + 2 * 24 * 60 * 60_000),
    })

    // "Restart" the worker repeatedly during the wait. Nothing fires early and
    // nothing is lost.
    for (let restart = 0; restart < 3; restart += 1) {
      harness.clock.advanceMinutes(8 * 60)
      expect((await runNextDueStep(harness, { leaseOwner: `worker-${restart}` })).kind).toBe('idle')
    }
    expect(harness.dispatcher.calls).toHaveLength(0)

    harness.clock.advanceMinutes(2 * 24 * 60)
    const outcome = await runNextDueStep(harness, { leaseOwner: 'worker-after-restart' })
    expect(outcome.kind).toBe('sent')
    expect(harness.dispatcher.calls).toHaveLength(1)
  })

  it('returns a lease abandoned before the provider call to pending, and runs it once', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)

    // Worker A claims the step and dies before dispatching.
    const claimed = await harness.steps.claimDueStep({ now: harness.clock.now(), leaseOwner: 'worker-a', leaseMs: 60_000 })
    expect(claimed).not.toBeNull()
    harness.steps.simulateCrash()
    expect(harness.dispatcher.calls).toHaveLength(0)

    // The lease expires. Worker B recovers it: no send was attempted, so the
    // step is safe to run.
    harness.clock.advanceMinutes(5)
    const recovery = await harness.steps.recoverExpiredLeases(harness.clock.now())
    expect(recovery).toEqual({ returnedToPending: 1, outcomeUnknown: 0 })

    const outcome = await runNextDueStep(harness, { leaseOwner: 'worker-b' })
    expect(outcome.kind).toBe('sent')
    expect(harness.dispatcher.calls).toHaveLength(1)
  })

  it('records outcome_unknown rather than re-sending when a lease expires after dispatch began', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)

    // Worker A gets as far as the provider call and then dies.
    const claimed = await harness.steps.claimDueStep({ now: harness.clock.now(), leaseOwner: 'worker-a', leaseMs: 60_000 })
    await harness.steps.markSendStarted({ stepId: claimed!.id, organizationId: ORG, leaseOwner: 'worker-a', leaseMs: 60_000, now: harness.clock.now() })
    harness.steps.simulateCrash()

    harness.clock.advanceMinutes(5)
    const recovery = await harness.steps.recoverExpiredLeases(harness.clock.now())
    expect(recovery).toEqual({ returnedToPending: 0, outcomeUnknown: 1 })

    // The step is not reclaimed, because a message may already be with the
    // provider and a retry would be a duplicate to a real person.
    expect((await runNextDueStep(harness, { leaseOwner: 'worker-b' })).kind).toBe('idle')
    expect(harness.dispatcher.calls).toHaveLength(0)
    expect([...harness.steps.rows.values()][0]?.status).toBe('outcome_unknown')
  })

  /**
   * Duplicate-send prevention has three independent gates, and each is tested
   * on its own below rather than through one scenario that happens to exercise
   * whichever fires first:
   *
   *   1. The atomic claim — two workers polling for work cannot take the same
   *      step.
   *   2. The lease compare-and-swap — a worker that no longer holds the lease
   *      cannot reach the provider, even holding a valid-looking step.
   *   3. The unique send record — a step whose message already went out is not
   *      sent again, whatever the scheduler believes.
   */
  it('gate 1: two workers polling concurrently produce exactly one send', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)

    // Interleave the two claims so both are inside the claim query together.
    let release: (() => void) | null = null
    const bothArrived = new Promise<void>((resolve) => { release = resolve })
    let arrivals = 0
    harness.steps.hook = async (operation) => {
      if (operation !== 'claimDueStep') return
      arrivals += 1
      if (arrivals === 1) await bothArrived
      else release?.()
    }

    const [first, second] = await Promise.all([
      runNextDueStep(harness, { leaseOwner: 'worker-a' }),
      runNextDueStep(harness, { leaseOwner: 'worker-b' }),
    ])

    expect(harness.dispatcher.calls).toHaveLength(1)
    expect(harness.sends.sentCount()).toBe(1)
    expect([first.kind, second.kind].sort()).toEqual(['idle', 'sent'])

    const enrolment = await harness.enrolments.find({ organizationId: ORG, enrolmentId: 'enrolment-1' })
    expect(enrolment?.stepIndex).toBe(1)
  })

  it('gate 2: a worker holding a stale claim cannot dispatch after another worker takes the lease', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)

    // Worker A claims legitimately, then worker B is handed the same step
    // descriptor — the situation a split brain or a duplicated queue message
    // would produce.
    const claimed = await harness.steps.claimDueStep({ now: harness.clock.now(), leaseOwner: 'worker-a', leaseMs: 60_000 })
    const stale: ClaimedStep = { ...claimed! }

    const [aOutcome, bOutcome] = await Promise.all([
      runClaimedStep(harness, claimed!, { leaseOwner: 'worker-a' }),
      runClaimedStep(harness, stale, { leaseOwner: 'worker-b' }),
    ])

    expect(harness.dispatcher.calls).toHaveLength(1)
    expect(harness.sends.sentCount()).toBe(1)
    expect(aOutcome.kind).toBe('sent')
    expect(bOutcome.kind).toBe('cancelled')
    expect(bOutcome.reason).toBe('lease_lost')
  })

  it('gate 3: a step whose message already went out is never dispatched again', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)

    // First pass sends and advances.
    await runNextDueStep(harness, { leaseOwner: 'worker-a' })
    expect(harness.dispatcher.calls).toHaveLength(1)

    // Now simulate the state a botched recovery would leave behind: the step is
    // pending again and the enrolment cursor has been wound back, so every
    // scheduler-level check would wave this through.
    const row = [...harness.steps.rows.values()].find((candidate) => candidate.stepIndex === 0)!
    row.status = 'pending'
    row.leaseStage = null
    row.leaseOwner = null
    row.leaseExpiresAt = null
    const enrolmentRow = harness.enrolments.rows.get('enrolment-1')!
    enrolmentRow.stepIndex = 0

    const outcome = await runNextDueStep(harness, { leaseOwner: 'worker-b' })

    // The send record is what stops it.
    expect(outcome.kind).toBe('duplicate_suppressed')
    expect(harness.dispatcher.calls).toHaveLength(1)
    expect(harness.sends.sentCount()).toBe(1)
  })

  it('refuses to dispatch when the lease was lost to a recovery sweep', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)
    const claimed = await harness.steps.claimDueStep({ now: harness.clock.now(), leaseOwner: 'worker-a', leaseMs: 60_000 })

    // A sweep hands the step to someone else while worker A is still working.
    harness.clock.advanceMinutes(5)
    await harness.steps.recoverExpiredLeases(harness.clock.now())
    await harness.steps.claimDueStep({ now: harness.clock.now(), leaseOwner: 'worker-b', leaseMs: 60_000 })

    const outcome = await runClaimedStep(harness, claimed!, { leaseOwner: 'worker-a' })
    expect(outcome.kind).toBe('cancelled')
    expect(outcome.reason).toBe('lease_lost')
    expect(harness.dispatcher.calls).toHaveLength(0)
  })

  it('defers a step that comes due inside quiet hours instead of sending or skipping it', async () => {
    // 22:00 in Kolkata is 16:30 UTC, inside a 21:00–08:00 local quiet window.
    const harness = createHarness('2026-03-01T16:30:00.000Z')
    seed(harness, { timeZone: IST, definitionOverrides: { quietHours: { enabled: true, startMinute: 21 * 60, endMinute: 8 * 60 } } })
    await scheduleFirstStep(harness)

    const outcome = await runNextDueStep(harness, { leaseOwner: 'worker-a' })
    expect(outcome.kind).toBe('deferred')
    expect(outcome.reason).toBe('quiet_hours')
    expect(harness.dispatcher.calls).toHaveLength(0)

    // Not skipped: still pending, moved to the next permitted local window.
    const row = [...harness.steps.rows.values()][0]!
    expect(row.status).toBe('pending')
    expect(row.deferralCount).toBe(1)
    expect(localMinuteOfDay(row.dueAt, IST)).toBe(8 * 60)

    // A deferral must not consume the retry budget.
    expect(row.attempts).toBe(0)

    // When the window opens, it sends.
    harness.clock.set(row.dueAt)
    expect((await runNextDueStep(harness, { leaseOwner: 'worker-a' })).kind).toBe('sent')
    expect(harness.dispatcher.calls).toHaveLength(1)
  })

  it('exits an enrolment when the recipient is on the suppression list', async () => {
    const harness = createHarness()
    seed(harness)
    harness.suppression.suppress(ORG, 'email', 'lead@example.com', 'unsubscribed')
    await scheduleFirstStep(harness)

    const outcome = await runNextDueStep(harness, { leaseOwner: 'worker-a' })
    expect(outcome.kind).toBe('exited')
    expect(outcome.reason).toBe('unsubscribed')
    expect(harness.dispatcher.calls).toHaveLength(0)

    const enrolment = await harness.enrolments.find({ organizationId: ORG, enrolmentId: 'enrolment-1' })
    expect(enrolment?.status).toBe('exited')
    // No orphaned pending steps left behind to fire later.
    expect([...harness.steps.rows.values()].every((row) => row.status === 'cancelled')).toBe(true)
  })

  it('checks suppression on every channel, not only on the first step', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)
    await runNextDueStep(harness, { leaseOwner: 'worker-a' })
    expect(harness.dispatcher.calls).toHaveLength(1)

    // The contact opts out of SMS between step 1 and step 2.
    harness.suppression.suppress(ORG, 'sms', '+919876543210', 'unsubscribed')
    harness.clock.advanceMinutes(3 * 24 * 60)

    const outcome = await runNextDueStep(harness, { leaseOwner: 'worker-a' })
    expect(outcome.kind).toBe('exited')
    expect(harness.dispatcher.calls).toHaveLength(1)
  })

  it('stops sending when the sequence is paused mid-enrolment', async () => {
    const harness = createHarness()
    const { version } = seed(harness)
    await scheduleFirstStep(harness)
    await runNextDueStep(harness, { leaseOwner: 'worker-a' })
    expect(harness.dispatcher.calls).toHaveLength(1)

    harness.versions.seed({ ...version, sequenceStatus: 'paused' })
    harness.clock.advanceMinutes(3 * 24 * 60)

    const outcome = await runNextDueStep(harness, { leaseOwner: 'worker-a' })
    expect(outcome.kind).toBe('exited')
    expect(outcome.reason).toBe('sequence_paused')
    expect(harness.dispatcher.calls).toHaveLength(1)
  })

  it('cancels a step whose index no longer matches the enrolment cursor', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)
    // The enrolment has already moved past step 0.
    await harness.enrolments.advance({ organizationId: ORG, enrolmentId: 'enrolment-1', fromStepIndex: 0, toStepIndex: 1, nextDueAt: null, now: harness.clock.now() })

    const outcome = await runNextDueStep(harness, { leaseOwner: 'worker-a' })
    expect(outcome.kind).toBe('cancelled')
    expect(outcome.reason).toBe('step_superseded')
    expect(harness.dispatcher.calls).toHaveLength(0)
  })

  it('retries a dispatch failure that provably sent nothing, with backoff', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)
    harness.dispatcher.failWith = new DispatchError({ code: 'SMTP_CONNECT_FAILED', message: 'connection refused', retryable: true })

    const first = await runNextDueStep(harness, { leaseOwner: 'worker-a' })
    expect(first.kind).toBe('failed')
    expect(first.reason).toBe('SMTP_CONNECT_FAILED:retry_scheduled')

    const row = [...harness.steps.rows.values()][0]!
    expect(row.status).toBe('pending')
    expect(row.dueAt.getTime()).toBeGreaterThan(harness.clock.now().getTime())

    harness.clock.set(row.dueAt)
    expect((await runNextDueStep(harness, { leaseOwner: 'worker-a' })).kind).toBe('sent')
    expect(harness.sends.sentCount()).toBe(1)
  })

  it('never retries a dispatch whose outcome cannot be established', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)
    harness.dispatcher.failWith = new DispatchError({ code: 'PROVIDER_TIMEOUT', message: 'no response after send', outcomeUnknown: true })

    const outcome = await runNextDueStep(harness, { leaseOwner: 'worker-a' })
    expect(outcome.kind).toBe('outcome_unknown')
    expect([...harness.steps.rows.values()][0]?.status).toBe('outcome_unknown')

    harness.clock.advanceMinutes(60)
    expect((await runNextDueStep(harness, { leaseOwner: 'worker-a' })).kind).toBe('idle')
    expect(harness.dispatcher.calls).toHaveLength(1)
  })

  it('completes the enrolment after the final step', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)

    await runNextDueStep(harness, { leaseOwner: 'worker-a' })
    harness.clock.advanceMinutes(3 * 24 * 60)
    await runNextDueStep(harness, { leaseOwner: 'worker-a' })
    harness.clock.advanceMinutes(60)
    const final = await runNextDueStep(harness, { leaseOwner: 'worker-a' })

    expect(final.kind).toBe('completed')
    expect(harness.dispatcher.calls).toHaveLength(3)
    const enrolment = await harness.enrolments.find({ organizationId: ORG, enrolmentId: 'enrolment-1' })
    expect(enrolment?.status).toBe('completed')
  })

  it('refuses to run a step belonging to another organisation', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)
    const claimed = await harness.steps.claimDueStep({ now: harness.clock.now(), leaseOwner: 'worker-a', leaseMs: 60_000 })

    const outcome = await runClaimedStep(harness, { ...claimed!, organizationId: OTHER_ORG }, { leaseOwner: 'worker-a' })
    expect(outcome.kind).toBe('cancelled')
    expect(outcome.reason).toBe('enrolment_missing')
    expect(harness.dispatcher.calls).toHaveLength(0)
  })

  it('drains only the steps that are actually due', async () => {
    const harness = createHarness()
    seed(harness)
    await scheduleFirstStep(harness)

    const outcomes = await runDueSteps(harness, { leaseOwner: 'worker-a', max: 10 })
    // Step 1 sends; step 2 is three days out and must not be drained with it.
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['sent'])
    expect(harness.dispatcher.calls).toHaveLength(1)
  })
})
