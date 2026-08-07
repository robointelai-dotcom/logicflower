import crypto from 'crypto'
import {
  DispatchError,
  type ChannelDispatcher,
  type ClaimedStep,
  type ContactStore,
  type ContactView,
  type DispatchRequest,
  type DispatchResult,
  type EnrolmentStore,
  type EnrolmentView,
  type ScheduledStepStore,
  type SendLedger,
  type SendStatus,
  type SequencePorts,
  type SuppressionPort,
  type VersionStore,
  type VersionView,
} from '../../src/services/sequences/ports'
import type { SuppressionReason } from '../../src/services/sequences/suppression'

/**
 * In-memory implementations of the sequence runtime ports.
 *
 * These exist so the properties that matter — a lease that survives a crash,
 * exactly one send under concurrency, a step that defers rather than fires at
 * 2am — can be proved without MongoDB. They deliberately mirror the semantics
 * the Mongo adapters must provide, including the two-stage lease and the unique
 * constraint on (organizationId, enrolmentId, stepIndex, channel).
 *
 * What they do NOT prove is that the Mongo queries express those semantics
 * correctly. That is what the integration suite is for, and it needs a real
 * database.
 */

export interface FakeStepRow {
  id: string
  organizationId: string
  enrolmentId: string
  sequenceId: string
  stepIndex: number
  channel: 'email' | 'sms' | 'whatsapp'
  dueAt: Date
  status: 'pending' | 'processing' | 'completed' | 'cancelled' | 'failed' | 'outcome_unknown'
  leaseStage: 'before_send' | 'send_started' | null
  leaseExpiresAt: Date | null
  leaseOwner: string | null
  attempts: number
  deferralCount: number
  lastError?: { code: string; message: string }
}

export interface FakeSendRow {
  id: string
  organizationId: string
  enrolmentId: string
  stepIndex: number
  channel: string
  contactId: string
  status: SendStatus
  provider?: string
  providerMessageId?: string
  trackingToken: string
  recipientDigest: string
  error?: { code: string; message: string }
}

export class FakeClock {
  private current: Date
  constructor(start: Date | string = '2026-03-01T09:00:00.000Z') {
    this.current = new Date(start)
  }
  now = (): Date => new Date(this.current.getTime())
  advanceMs(ms: number): void { this.current = new Date(this.current.getTime() + ms) }
  advanceMinutes(minutes: number): void { this.advanceMs(minutes * 60_000) }
  set(instant: Date | string): void { this.current = new Date(instant) }
}

export class FakeStepStore implements ScheduledStepStore {
  readonly rows = new Map<string, FakeStepRow>()
  private sequence = 0
  /** Await points injected before each mutation, to interleave concurrent runs. */
  hook: (operation: string) => Promise<void> = async () => undefined

  constructor(private readonly clock: FakeClock) {}

  private key(organizationId: string, enrolmentId: string, stepIndex: number): string {
    return `${organizationId}|${enrolmentId}|${stepIndex}`
  }

  private find(stepId: string, organizationId: string): FakeStepRow | undefined {
    const row = this.rows.get(stepId)
    return row && row.organizationId === organizationId ? row : undefined
  }

  async recoverExpiredLeases(now: Date) {
    await this.hook('recoverExpiredLeases')
    let returnedToPending = 0
    let outcomeUnknown = 0
    for (const row of this.rows.values()) {
      if (row.status !== 'processing' || !row.leaseExpiresAt || row.leaseExpiresAt.getTime() >= now.getTime()) continue
      if (row.leaseStage === 'before_send') {
        // No provider call was made. Safe to run again.
        row.status = 'pending'
        row.leaseStage = null
        row.leaseExpiresAt = null
        row.leaseOwner = null
        returnedToPending += 1
      } else {
        // A send may already have happened. Never retry blindly.
        row.status = 'outcome_unknown'
        row.leaseExpiresAt = null
        row.leaseOwner = null
        row.lastError = { code: 'LEASE_EXPIRED_AFTER_SEND', message: 'Worker stopped after the provider call began; outcome cannot be established' }
        outcomeUnknown += 1
      }
    }
    return { returnedToPending, outcomeUnknown }
  }

  async claimDueStep(input: { now: Date; leaseOwner: string; leaseMs: number }): Promise<ClaimedStep | null> {
    await this.hook('claimDueStep')
    const candidates = [...this.rows.values()]
      .filter((row) => row.status === 'pending' && row.dueAt.getTime() <= input.now.getTime())
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
    const row = candidates[0]
    if (!row) return null
    row.status = 'processing'
    row.leaseStage = 'before_send'
    row.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs)
    row.leaseOwner = input.leaseOwner
    row.attempts += 1
    return {
      id: row.id,
      organizationId: row.organizationId,
      enrolmentId: row.enrolmentId,
      sequenceId: row.sequenceId,
      stepIndex: row.stepIndex,
      channel: row.channel,
      dueAt: new Date(row.dueAt.getTime()),
      attempts: row.attempts - 1,
    }
  }

  async markSendStarted(input: { stepId: string; organizationId: string; leaseOwner: string; leaseMs: number; now: Date }): Promise<boolean> {
    await this.hook('markSendStarted')
    const row = this.find(input.stepId, input.organizationId)
    // Compare-and-swap on the held lease: a worker that lost its lease to a
    // recovery sweep must not proceed to the provider.
    if (!row || row.status !== 'processing' || row.leaseStage !== 'before_send' || row.leaseOwner !== input.leaseOwner) return false
    row.leaseStage = 'send_started'
    row.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs)
    return true
  }

  async complete(input: { stepId: string; organizationId: string; now: Date }) {
    await this.hook('complete')
    const row = this.find(input.stepId, input.organizationId)
    if (!row) return
    row.status = 'completed'
    row.leaseStage = null
    row.leaseExpiresAt = null
  }

  async cancel(input: { stepId: string; organizationId: string; reason: string; now: Date }) {
    await this.hook('cancel')
    const row = this.find(input.stepId, input.organizationId)
    if (!row) return
    row.status = 'cancelled'
    row.leaseStage = null
    row.leaseExpiresAt = null
    row.lastError = { code: 'CANCELLED', message: input.reason }
  }

  async defer(input: { stepId: string; organizationId: string; dueAt: Date; now: Date }) {
    await this.hook('defer')
    const row = this.find(input.stepId, input.organizationId)
    if (!row) return
    row.status = 'pending'
    row.leaseStage = null
    row.leaseExpiresAt = null
    row.leaseOwner = null
    row.dueAt = new Date(input.dueAt)
    row.deferralCount += 1
    // Deferral is not an attempt. A step deferred nightly for a week must not
    // exhaust its retry budget without ever having been sent.
    row.attempts = Math.max(0, row.attempts - 1)
  }

  async fail(input: { stepId: string; organizationId: string; code: string; message: string; now: Date; retryAt?: Date }) {
    await this.hook('fail')
    const row = this.find(input.stepId, input.organizationId)
    if (!row) return
    row.leaseStage = null
    row.leaseExpiresAt = null
    row.leaseOwner = null
    row.lastError = { code: input.code, message: input.message }
    if (input.retryAt) {
      row.status = 'pending'
      row.dueAt = new Date(input.retryAt)
    } else {
      row.status = 'failed'
    }
  }

  async markOutcomeUnknown(input: { stepId: string; organizationId: string; code: string; message: string; now: Date }) {
    await this.hook('markOutcomeUnknown')
    const row = this.find(input.stepId, input.organizationId)
    if (!row) return
    row.status = 'outcome_unknown'
    row.leaseStage = null
    row.leaseExpiresAt = null
    row.lastError = { code: input.code, message: input.message }
  }

  async schedule(input: { organizationId: string; enrolmentId: string; sequenceId: string; stepIndex: number; channel: 'email' | 'sms' | 'whatsapp'; dueAt: Date }) {
    await this.hook('schedule')
    const naturalKey = this.key(input.organizationId, input.enrolmentId, input.stepIndex)
    const existing = [...this.rows.values()].find((row) => this.key(row.organizationId, row.enrolmentId, row.stepIndex) === naturalKey)
    if (existing) return { created: false, stepId: existing.id }
    this.sequence += 1
    const id = `step-${this.sequence}`
    this.rows.set(id, {
      id,
      organizationId: input.organizationId,
      enrolmentId: input.enrolmentId,
      sequenceId: input.sequenceId,
      stepIndex: input.stepIndex,
      channel: input.channel,
      dueAt: new Date(input.dueAt),
      status: 'pending',
      leaseStage: null,
      leaseExpiresAt: null,
      leaseOwner: null,
      attempts: 0,
      deferralCount: 0,
    })
    return { created: true, stepId: id }
  }

  async cancelPendingForEnrolment(input: { organizationId: string; enrolmentId: string; reason: string; now: Date }) {
    await this.hook('cancelPendingForEnrolment')
    let cancelled = 0
    for (const row of this.rows.values()) {
      if (row.organizationId !== input.organizationId || row.enrolmentId !== input.enrolmentId) continue
      if (row.status !== 'pending') continue
      row.status = 'cancelled'
      row.lastError = { code: 'CANCELLED', message: input.reason }
      cancelled += 1
    }
    return cancelled
  }

  /** Simulate an abrupt process death: the lease stays exactly as it was. */
  simulateCrash(): void {
    for (const row of this.rows.values()) {
      if (row.status === 'processing') row.leaseOwner = `${row.leaseOwner}-dead`
    }
  }
}

export class FakeEnrolmentStore implements EnrolmentStore {
  readonly rows = new Map<string, EnrolmentView & { exitReason: string | null; lastError?: { code: string; message: string } }>()

  seed(view: EnrolmentView): void {
    this.rows.set(view.id, { ...view, exitReason: null })
  }

  async find(input: { organizationId: string; enrolmentId: string }): Promise<EnrolmentView | null> {
    const row = this.rows.get(input.enrolmentId)
    if (!row || row.organizationId !== input.organizationId) return null
    return { ...row }
  }

  async advance(input: { organizationId: string; enrolmentId: string; fromStepIndex: number; toStepIndex: number; nextDueAt: Date | null; now: Date }) {
    const row = this.rows.get(input.enrolmentId)
    // Compare-and-swap on the cursor, so a duplicate advance is a no-op rather
    // than skipping a step.
    if (!row || row.organizationId !== input.organizationId || row.stepIndex !== input.fromStepIndex) return false
    row.stepIndex = input.toStepIndex
    return true
  }

  async complete(input: { organizationId: string; enrolmentId: string; now: Date }) {
    const row = this.rows.get(input.enrolmentId)
    if (row && row.organizationId === input.organizationId && row.status === 'active') row.status = 'completed'
  }

  async exit(input: { organizationId: string; enrolmentId: string; reason: string; now: Date }) {
    const row = this.rows.get(input.enrolmentId)
    if (row && row.organizationId === input.organizationId && row.status === 'active') {
      row.status = 'exited'
      row.exitReason = input.reason
    }
  }

  async fail(input: { organizationId: string; enrolmentId: string; code: string; message: string; now: Date }) {
    const row = this.rows.get(input.enrolmentId)
    if (row && row.organizationId === input.organizationId) {
      row.status = 'failed'
      row.lastError = { code: input.code, message: input.message }
    }
  }
}

export class FakeVersionStore implements VersionStore {
  readonly rows = new Map<string, VersionView>()
  seed(view: VersionView): void { this.rows.set(view.id, view) }
  async find(input: { organizationId: string; sequenceVersionId: string }): Promise<VersionView | null> {
    return this.rows.get(input.sequenceVersionId) ?? null
  }
}

export class FakeContactStore implements ContactStore {
  readonly rows = new Map<string, ContactView & { organizationId: string }>()
  seed(organizationId: string, view: ContactView): void { this.rows.set(view.id, { ...view, organizationId }) }
  async find(input: { organizationId: string; contactId: string }): Promise<ContactView | null> {
    const row = this.rows.get(input.contactId)
    if (!row || row.organizationId !== input.organizationId) return null
    const { organizationId: _organizationId, ...view } = row
    return view
  }
}

export class FakeSendLedger implements SendLedger {
  readonly rows = new Map<string, FakeSendRow>()
  private sequence = 0
  hook: (operation: string) => Promise<void> = async () => undefined

  private key(organizationId: string, enrolmentId: string, stepIndex: number, channel: string): string {
    return `${organizationId}|${enrolmentId}|${stepIndex}|${channel}`
  }

  async reserve(input: any) {
    await this.hook('reserve')
    const naturalKey = this.key(input.organizationId, input.enrolmentId, input.stepIndex, input.channel)
    const existing = [...this.rows.values()].find((row) => this.key(row.organizationId, row.enrolmentId, row.stepIndex, row.channel) === naturalKey)
    // A pre-existing record is a unique-index collision in the real store. The
    // caller must treat it as "someone else owns this send".
    if (existing) return { sendRecordId: existing.id, status: existing.status, created: false, trackingToken: existing.trackingToken }
    this.sequence += 1
    const id = `send-${this.sequence}`
    const trackingToken = crypto.randomBytes(16).toString('base64url')
    this.rows.set(id, {
      id,
      organizationId: input.organizationId,
      enrolmentId: input.enrolmentId,
      stepIndex: input.stepIndex,
      channel: input.channel,
      contactId: input.contactId,
      status: 'queued',
      trackingToken,
      recipientDigest: input.recipientDigest,
    })
    return { sendRecordId: id, status: 'queued' as SendStatus, created: true, trackingToken }
  }

  async markSent(input: { organizationId: string; sendRecordId: string; provider: string; providerMessageId?: string; now: Date }) {
    const row = this.rows.get(input.sendRecordId)
    if (!row || row.organizationId !== input.organizationId) return
    row.status = 'sent'
    row.provider = input.provider
    row.providerMessageId = input.providerMessageId
  }

  async markFailed(input: { organizationId: string; sendRecordId: string; code: string; message: string; now: Date }) {
    const row = this.rows.get(input.sendRecordId)
    if (!row || row.organizationId !== input.organizationId) return
    row.status = 'failed'
    row.error = { code: input.code, message: input.message }
  }

  async markSuppressed(input: { organizationId: string; sendRecordId: string; reason: string; now: Date }) {
    const row = this.rows.get(input.sendRecordId)
    if (!row || row.organizationId !== input.organizationId) return
    row.status = 'suppressed'
    row.error = { code: 'SUPPRESSED', message: input.reason }
  }

  async markOutcomeUnknown(input: { organizationId: string; sendRecordId: string; code: string; message: string; now: Date }) {
    const row = this.rows.get(input.sendRecordId)
    if (!row || row.organizationId !== input.organizationId) return
    row.status = 'outcome_unknown'
    row.error = { code: input.code, message: input.message }
  }

  sentCount(): number {
    return [...this.rows.values()].filter((row) => row.status === 'sent').length
  }
}

export class FakeSuppressionPort implements SuppressionPort {
  private readonly suppressed = new Map<string, SuppressionReason>()

  suppress(organizationId: string, channel: string, address: string, reason: SuppressionReason): void {
    this.suppressed.set(`${organizationId}|${channel}|${address.trim().toLowerCase()}`, reason)
  }

  async check(input: { organizationId: string; channel: string; address: string }) {
    const normalisedAddress = input.address.trim().toLowerCase()
    const reason = this.suppressed.get(`${input.organizationId}|${input.channel}|${normalisedAddress}`) ?? null
    return {
      normalisedAddress,
      addressDigest: crypto.createHash('sha256').update(`${input.organizationId}|${input.channel}|${normalisedAddress}`).digest('hex'),
      suppressedReason: reason,
    }
  }
}

export class RecordingDispatcher implements ChannelDispatcher {
  readonly calls: DispatchRequest[] = []
  /** Set to make the next call throw. */
  failWith: DispatchError | Error | null = null
  hook: (request: DispatchRequest) => Promise<void> = async () => undefined

  async send(request: DispatchRequest): Promise<DispatchResult> {
    await this.hook(request)
    this.calls.push(request)
    if (this.failWith) {
      const error = this.failWith
      this.failWith = null
      throw error
    }
    return { provider: 'fake', providerMessageId: `provider-${this.calls.length}` }
  }
}

export interface TestHarness extends SequencePorts {
  clock: FakeClock
  steps: FakeStepStore
  enrolments: FakeEnrolmentStore
  versions: FakeVersionStore
  contacts: FakeContactStore
  sends: FakeSendLedger
  suppression: FakeSuppressionPort
  dispatcher: RecordingDispatcher
}

export function createHarness(start?: string): TestHarness {
  const clock = new FakeClock(start)
  const steps = new FakeStepStore(clock)
  const enrolments = new FakeEnrolmentStore()
  const versions = new FakeVersionStore()
  const contacts = new FakeContactStore()
  const sends = new FakeSendLedger()
  const suppression = new FakeSuppressionPort()
  const dispatcher = new RecordingDispatcher()
  return { clock, steps, enrolments, versions, contacts, sends, suppression, dispatcher, now: clock.now }
}
