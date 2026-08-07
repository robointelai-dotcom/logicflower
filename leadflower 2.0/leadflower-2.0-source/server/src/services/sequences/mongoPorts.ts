import Contact from '../../models/Contact'
import ScheduledStep from '../../models/ScheduledStep'
import SendRecord from '../../models/SendRecord'
import Sequence from '../../models/Sequence'
import SequenceEnrolment from '../../models/SequenceEnrolment'
import SequenceVersion from '../../models/SequenceVersion'
import crypto from 'crypto'
import { assertNotSuppressed, SuppressedRecipientError } from './suppression'
import type {
  ChannelDispatcher,
  ClaimedStep,
  ContactStore,
  EnrolmentStore,
  ScheduledStepStore,
  SendLedger,
  SendReservation,
  SendStatus,
  SequencePorts,
  SuppressionPort,
  VersionStore,
} from './ports'
import type { SequenceDefinition } from './sequenceDefinition'

/**
 * MongoDB implementations of the sequence runtime ports.
 *
 * Deliberately thin. Every decision the engine makes lives in `stepRunner`,
 * which is exercised against in-memory ports; this file only has to translate
 * those operations into queries that hold the same guarantees. Where a query is
 * doing load-bearing work — the atomic claim, the two-stage lease recovery, the
 * reservation upsert — it is commented, because those are the three places a
 * plausible-looking rewrite silently reintroduces double-sending.
 */

const DUPLICATE_KEY = 11_000

function isDuplicateKeyError(error: any): boolean {
  return Number(error?.code) === DUPLICATE_KEY || Number(error?.cause?.code) === DUPLICATE_KEY
}

export const mongoStepStore: ScheduledStepStore = {
  async recoverExpiredLeases(now: Date) {
    // Stage one: the worker died before any provider call. Nothing left the
    // process, so the step returns to the queue unchanged.
    // tenant-safe: cross-tenant lease-recovery sweep; each step carries its own organisation
    const returned = await ScheduledStep.updateMany(
      { status: 'processing', leaseStage: 'before_send', leaseExpiresAt: { $lt: now } },
      { $set: { status: 'pending' }, $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 } },
    )

    // Stage two: the worker died after the provider call began. A message may
    // be with the provider, so this must never be retried automatically. It is
    // parked for reconciliation — by a delivery callback or by an operator.
    //
    // The affected steps are read BEFORE they are updated, so the matching send
    // records can be reconciled precisely. A blanket update over `queued` send
    // records would also catch records a live worker legitimately owns and had
    // not yet marked sent, converting healthy in-flight sends into permanent
    // outcome_unknown rows that no one will ever resolve.
    // tenant-safe: cross-tenant lease-recovery sweep; each step carries its own organisation
    const abandoned: any[] = await ScheduledStep.find(
      { status: 'processing', leaseStage: 'send_started', leaseExpiresAt: { $lt: now } },
    ).select('_id organizationId enrolmentId stepIndex channel').limit(1_000).lean()

    let outcomeUnknown = 0
    if (abandoned.length) {
      // tenant-safe: cross-tenant lease-recovery sweep, scoped to ids just read; each step carries its own organisation
      const unknown = await ScheduledStep.updateMany(
        { _id: { $in: abandoned.map((step) => step._id) }, status: 'processing', leaseStage: 'send_started' },
        {
          $set: {
            status: 'outcome_unknown',
            lastError: { code: 'LEASE_EXPIRED_AFTER_SEND', message: 'Worker stopped after the provider call began; outcome cannot be established', at: now },
          },
          $unset: { leaseExpiresAt: 1, leaseOwner: 1 },
        },
      )
      outcomeUnknown = Number((unknown as any).modifiedCount || 0)

      // Keep the send ledger consistent with the step: a record still reading
      // `queued` for an abandoned step would otherwise look safe to retry.
      for (const step of abandoned) {
        await SendRecord.updateOne(
          {
            organizationId: String(step.organizationId),
            enrolmentId: step.enrolmentId,
            stepIndex: Number(step.stepIndex),
            channel: step.channel,
            status: 'queued',
          },
          { $set: { status: 'outcome_unknown', error: { code: 'LEASE_EXPIRED_AFTER_SEND', message: 'Worker stopped after the provider call began' } } },
        )
      }
    }

    return { returnedToPending: Number((returned as any).modifiedCount || 0), outcomeUnknown }
  },

  async claimDueStep(input): Promise<ClaimedStep | null> {
    // The claim. findOneAndUpdate on a `pending` predicate is atomic at the
    // document level, so two workers issuing this concurrently cannot both
    // match — the loser sees the document already at `processing`.
    // tenant-safe: cross-tenant scheduler claiming the next due step; each step carries its own organisation
    const claimed: any = await ScheduledStep.findOneAndUpdate(
      { status: 'pending', dueAt: { $lte: input.now } },
      {
        $set: {
          status: 'processing',
          leaseStage: 'before_send',
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          leaseOwner: input.leaseOwner,
          startedAt: input.now,
        },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { dueAt: 1 } },
    ).lean()
    if (!claimed) return null
    return {
      id: String(claimed._id),
      organizationId: String(claimed.organizationId),
      enrolmentId: String(claimed.enrolmentId),
      sequenceId: String(claimed.sequenceId),
      stepIndex: Number(claimed.stepIndex),
      channel: claimed.channel,
      dueAt: new Date(claimed.dueAt),
      attempts: Math.max(0, Number(claimed.attempts || 1) - 1),
    }
  },

  async markSendStarted(input) {
    // Compare-and-swap on the lease the caller believes it holds. A worker that
    // lost its lease to a recovery sweep matches nothing here and is refused
    // before it can reach a provider.
    const result = await ScheduledStep.updateOne(
      { _id: input.stepId, organizationId: input.organizationId, status: 'processing', leaseStage: 'before_send', leaseOwner: input.leaseOwner },
      { $set: { leaseStage: 'send_started', leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs) } },
    )
    return Number((result as any).modifiedCount || 0) === 1
  },

  async complete(input) {
    await ScheduledStep.updateOne(
      { _id: input.stepId, organizationId: input.organizationId },
      { $set: { status: 'completed', finishedAt: input.now }, $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 } },
    )
  },

  async cancel(input) {
    await ScheduledStep.updateOne(
      { _id: input.stepId, organizationId: input.organizationId },
      {
        $set: { status: 'cancelled', finishedAt: input.now, lastError: { code: 'CANCELLED', message: input.reason, at: input.now } },
        $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 },
      },
    )
  },

  async defer(input) {
    // A deferral gives back the attempt it consumed at claim time. A step held
    // out of a nightly quiet window for a week would otherwise exhaust its
    // retry budget without ever having been offered to a provider.
    await ScheduledStep.updateOne(
      { _id: input.stepId, organizationId: input.organizationId },
      {
        $set: { status: 'pending', dueAt: input.dueAt, deferredFrom: input.now },
        $inc: { deferralCount: 1, attempts: -1 },
        $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1, startedAt: 1 },
      },
    )
  },

  async fail(input) {
    await ScheduledStep.updateOne(
      { _id: input.stepId, organizationId: input.organizationId },
      {
        $set: {
          status: input.retryAt ? 'pending' : 'failed',
          ...(input.retryAt ? { dueAt: input.retryAt } : { finishedAt: input.now }),
          lastError: { code: input.code, message: input.message, at: input.now },
        },
        $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 },
      },
    )
  },

  async markOutcomeUnknown(input) {
    await ScheduledStep.updateOne(
      { _id: input.stepId, organizationId: input.organizationId },
      {
        $set: { status: 'outcome_unknown', finishedAt: input.now, lastError: { code: input.code, message: input.message, at: input.now } },
        $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 },
      },
    )
  },

  async schedule(input) {
    // Idempotent by unique index on (organizationId, enrolmentId, stepIndex).
    // Two triggers racing to schedule the same step produce one row.
    try {
      const created: any = await ScheduledStep.create({
        organizationId: input.organizationId,
        enrolmentId: input.enrolmentId,
        sequenceId: input.sequenceId,
        stepIndex: input.stepIndex,
        channel: input.channel,
        dueAt: input.dueAt,
        status: 'pending',
      })
      return { created: true, stepId: String(created._id) }
    } catch (error: any) {
      if (!isDuplicateKeyError(error)) throw error
      const existing: any = await ScheduledStep.findOne({
        organizationId: input.organizationId,
        enrolmentId: input.enrolmentId,
        stepIndex: input.stepIndex,
      }).select('_id').lean()
      return { created: false, stepId: String(existing?._id || '') }
    }
  },

  async cancelPendingForEnrolment(input) {
    const result = await ScheduledStep.updateMany(
      { organizationId: input.organizationId, enrolmentId: input.enrolmentId, status: 'pending' },
      { $set: { status: 'cancelled', finishedAt: input.now, lastError: { code: 'CANCELLED', message: input.reason, at: input.now } } },
    )
    return Number((result as any).modifiedCount || 0)
  },
}

export const mongoEnrolmentStore: EnrolmentStore = {
  async find(input) {
    const row: any = await SequenceEnrolment.findOne({ _id: input.enrolmentId, organizationId: input.organizationId }).lean()
    if (!row) return null
    return {
      id: String(row._id),
      organizationId: String(row.organizationId),
      sequenceId: String(row.sequenceId),
      sequenceVersionId: String(row.sequenceVersionId),
      contactId: String(row.contactId),
      status: row.status,
      stepIndex: Number(row.stepIndex || 0),
      timeZone: String(row.timeZone || 'UTC'),
    }
  },

  async advance(input) {
    // Compare-and-swap on the cursor. A duplicated advance matches nothing and
    // is a no-op, rather than skipping a step the contact never received.
    const result = await SequenceEnrolment.updateOne(
      { _id: input.enrolmentId, organizationId: input.organizationId, status: 'active', stepIndex: input.fromStepIndex },
      { $set: { stepIndex: input.toStepIndex, nextDueAt: input.nextDueAt } },
    )
    return Number((result as any).modifiedCount || 0) === 1
  },

  async complete(input) {
    await SequenceEnrolment.updateOne(
      { _id: input.enrolmentId, organizationId: input.organizationId, status: 'active' },
      { $set: { status: 'completed', completedAt: input.now, nextDueAt: null } },
    )
  },

  async exit(input) {
    await SequenceEnrolment.updateOne(
      { _id: input.enrolmentId, organizationId: input.organizationId, status: 'active' },
      { $set: { status: 'exited', exitReason: input.reason, exitedAt: input.now, nextDueAt: null } },
    )
  },

  async fail(input) {
    await SequenceEnrolment.updateOne(
      { _id: input.enrolmentId, organizationId: input.organizationId },
      { $set: { status: 'failed', nextDueAt: null, lastError: { code: input.code, message: input.message, at: input.now } } },
    )
  },
}

export const mongoVersionStore: VersionStore = {
  async find(input) {
    const version: any = await SequenceVersion.findOne({ _id: input.sequenceVersionId, organizationId: input.organizationId }).lean()
    if (!version) return null
    const sequence: any = await Sequence.findOne({ _id: version.sequenceId, organizationId: input.organizationId }).select('status').lean()
    if (!sequence) return null
    const definition: SequenceDefinition = {
      steps: (version.steps || []).map((step: any, index: number) => ({
        stepIndex: Number(step.stepIndex ?? index),
        channel: step.channel,
        wait: step.wait,
        messagingIdentityId: step.messagingIdentityId ? String(step.messagingIdentityId) : null,
        subjectTemplate: step.subjectTemplate,
        bodyTemplate: step.bodyTemplate,
        whatsappTemplate: step.whatsappTemplate,
      })),
      exitConditions: version.exitConditions,
      quietHours: version.quietHours,
      defaultTimeZone: String(version.defaultTimeZone || 'UTC'),
    }
    return { id: String(version._id), sequenceStatus: sequence.status, definition }
  },
}

export const mongoContactStore: ContactStore = {
  async find(input) {
    const row: any = await Contact.findOne({ _id: input.contactId, organizationId: input.organizationId }).lean()
    if (!row) return null
    return {
      id: String(row._id),
      email: row.email || undefined,
      phone: row.phone || undefined,
      timeZone: row.timezone || undefined,
      firstName: row.firstName || undefined,
      lastName: row.lastName || undefined,
      name: row.name || undefined,
      fields: (row.customFields && typeof row.customFields === 'object' ? row.customFields : {}) as Record<string, unknown>,
    }
  },
}

export const mongoSendLedger: SendLedger = {
  async reserve(input): Promise<SendReservation> {
    // Written BEFORE the provider call. The unique index on
    // (organizationId, enrolmentId, stepIndex, channel) turns "have we already
    // sent this?" from a question the application has to remember to ask into
    // one the database answers.
    const trackingToken = crypto.randomBytes(24).toString('base64url')
    try {
      const created: any = await SendRecord.create({
        organizationId: input.organizationId,
        enrolmentId: input.enrolmentId,
        sequenceId: input.sequenceId,
        contactId: input.contactId,
        stepIndex: input.stepIndex,
        channel: input.channel,
        status: 'queued',
        recipientPreview: input.recipientPreview,
        recipientDigest: input.recipientDigest,
        messagingIdentityId: input.messagingIdentityId,
        trackingToken,
        queuedAt: input.now,
      })
      return { sendRecordId: String(created._id), status: 'queued', created: true, trackingToken }
    } catch (error: any) {
      if (!isDuplicateKeyError(error)) throw error
      const existing: any = await SendRecord.findOne({
        organizationId: input.organizationId,
        enrolmentId: input.enrolmentId,
        stepIndex: input.stepIndex,
        channel: input.channel,
      }).select('_id status trackingToken').lean()
      return {
        sendRecordId: String(existing?._id || ''),
        status: (existing?.status || 'outcome_unknown') as SendStatus,
        created: false,
        trackingToken: String(existing?.trackingToken || trackingToken),
      }
    }
  },

  async markSent(input) {
    await SendRecord.updateOne(
      { _id: input.sendRecordId, organizationId: input.organizationId },
      { $set: { status: 'sent', provider: input.provider, providerMessageId: input.providerMessageId, sentAt: input.now } },
    )
  },

  async markFailed(input) {
    await SendRecord.updateOne(
      { _id: input.sendRecordId, organizationId: input.organizationId },
      { $set: { status: 'failed', failedAt: input.now, error: { code: input.code, message: input.message } } },
    )
  },

  async markSuppressed(input) {
    await SendRecord.updateOne(
      { _id: input.sendRecordId, organizationId: input.organizationId },
      { $set: { status: 'suppressed', suppressionReason: input.reason } },
    )
  },

  async markOutcomeUnknown(input) {
    await SendRecord.updateOne(
      { _id: input.sendRecordId, organizationId: input.organizationId },
      { $set: { status: 'outcome_unknown', error: { code: input.code, message: input.message } } },
    )
  },
}

export const mongoSuppressionPort: SuppressionPort = {
  async check(input) {
    try {
      const { normalisedAddress, addressDigest } = await assertNotSuppressed({
        organizationId: input.organizationId,
        channel: input.channel,
        address: input.address,
      })
      return { normalisedAddress, addressDigest, suppressedReason: null }
    } catch (error) {
      if (error instanceof SuppressedRecipientError) {
        return { normalisedAddress: '', addressDigest: '', suppressedReason: error.reason }
      }
      // Fail closed. A suppression lookup that errors must never resolve to
      // "not suppressed" — that turns a database blip into unlawful sending.
      throw error
    }
  },
}

export function createMongoSequencePorts(dispatcher: ChannelDispatcher, now: () => Date = () => new Date()): SequencePorts {
  return {
    steps: mongoStepStore,
    enrolments: mongoEnrolmentStore,
    versions: mongoVersionStore,
    contacts: mongoContactStore,
    sends: mongoSendLedger,
    suppression: mongoSuppressionPort,
    dispatcher,
    now,
  }
}
