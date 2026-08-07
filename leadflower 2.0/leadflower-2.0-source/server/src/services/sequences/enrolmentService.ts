import Contact from '../../models/Contact'
import ScheduledStep from '../../models/ScheduledStep'
import Sequence from '../../models/Sequence'
import SequenceEnrolment from '../../models/SequenceEnrolment'
import SequenceVersion from '../../models/SequenceVersion'
import { HttpError, problemType } from '../../http/problem'
import { recordAudit } from '../audit'
import { mongoStepStore } from './mongoPorts'
import { canonicaliseSequenceDefinition, sequenceDefinitionHash, SequenceDefinitionError, type SequenceDefinition } from './sequenceDefinition'
import { nextStepDueAt, normaliseTimeZone } from './scheduleArithmetic'
import type { ExitReason } from './ports'

/**
 * Creating versions and putting contacts into them.
 *
 * The one rule this module exists to enforce: a version is immutable once
 * published, and an enrolment pins the version it started on. Everything else
 * follows from that — an operator editing a sequence creates a new version and
 * cannot corrupt the enrolments already running, which is the same guarantee
 * `WorkflowVersion` gives an in-flight `Execution`.
 */

const DUPLICATE_KEY = 11_000

export async function publishSequenceVersion(input: {
  organizationId: string
  sequenceId: string
  definition: unknown
  userId?: string
}): Promise<{ versionId: string; version: number; definitionHash: string }> {
  const sequence: any = await Sequence.findOne({ _id: input.sequenceId, organizationId: input.organizationId })
  if (!sequence) throw new HttpError(404, 'Sequence not found', 'No sequence with that identifier exists in this organisation', problemType('sequence-not-found'))

  let definition: SequenceDefinition
  try {
    definition = canonicaliseSequenceDefinition(input.definition)
  } catch (error) {
    if (error instanceof SequenceDefinitionError) {
      throw new HttpError(400, 'Sequence definition is invalid', error.issues.join('; '), problemType('sequence-definition-invalid'))
    }
    throw error
  }

  const definitionHash = sequenceDefinitionHash(definition)
  const version = Number(sequence.latestVersion || 0) + 1

  const created: any = await SequenceVersion.create({
    organizationId: input.organizationId,
    sequenceId: sequence._id,
    version,
    definitionHash,
    steps: definition.steps,
    exitConditions: definition.exitConditions,
    quietHours: definition.quietHours,
    defaultTimeZone: definition.defaultTimeZone,
    createdBy: input.userId,
  })

  await Sequence.updateOne(
    { _id: sequence._id, organizationId: input.organizationId },
    { $set: { latestVersion: version, publishedVersionId: created._id, publishedAt: new Date(), updatedBy: input.userId } },
  )

  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    actorType: input.userId ? 'user' : 'system',
    action: 'sequence.version_published',
    entityType: 'SequenceVersion',
    entityId: String(created._id),
    metadata: { sequenceId: String(sequence._id), version, definitionHash, stepCount: definition.steps.length },
  })

  return { versionId: String(created._id), version, definitionHash }
}

export interface EnrolmentResult {
  enrolmentId: string
  created: boolean
  /** Present when the contact was not enrolled, with the reason why. */
  skippedReason?: 'already_enrolled' | 'sequence_not_active' | 'contact_not_found'
}

/**
 * Enrol one contact.
 *
 * Idempotent by the partial unique index on (organizationId, sequenceId,
 * contactId) over active enrolments. A webhook that fires twice, a poll window
 * that overlaps, and an operator clicking twice all converge on one enrolment
 * rather than two parallel sequences to the same person.
 */
export async function enrolContact(input: {
  organizationId: string
  sequenceId: string
  contactId: string
  source?: string
  userId?: string
  now?: Date
}): Promise<EnrolmentResult> {
  const now = input.now ?? new Date()

  const sequence: any = await Sequence.findOne({ _id: input.sequenceId, organizationId: input.organizationId }).lean()
  if (!sequence) throw new HttpError(404, 'Sequence not found', 'No sequence with that identifier exists in this organisation', problemType('sequence-not-found'))
  if (sequence.status !== 'active' || !sequence.publishedVersionId) {
    return { enrolmentId: '', created: false, skippedReason: 'sequence_not_active' }
  }

  const version: any = await SequenceVersion.findOne({ _id: sequence.publishedVersionId, organizationId: input.organizationId }).lean()
  if (!version) throw new HttpError(409, 'Sequence has no published version', 'This sequence is marked active but its published version is missing', problemType('sequence-version-missing'))
  if (!Array.isArray(version.steps) || !version.steps.length) {
    throw new HttpError(409, 'Sequence has no steps', 'A sequence with no steps cannot be enrolled into', problemType('sequence-empty'))
  }

  const contact: any = await Contact.findOne({ _id: input.contactId, organizationId: input.organizationId }).select('timezone').lean()
  if (!contact) return { enrolmentId: '', created: false, skippedReason: 'contact_not_found' }

  // Snapshot the timezone at enrolment. Re-reading it per step would let a
  // contact edit silently retime every pending step in the sequence.
  const timeZone = normaliseTimeZone(contact.timezone || version.defaultTimeZone)
  const firstStep = version.steps[0]
  const dueAt = nextStepDueAt({
    from: now,
    wait: firstStep.wait,
    quietHours: version.quietHours,
    timeZone,
  })

  let enrolmentId: string
  try {
    const created: any = await SequenceEnrolment.create({
      organizationId: input.organizationId,
      sequenceId: sequence._id,
      sequenceVersionId: version._id,
      sequenceVersion: Number(version.version),
      contactId: input.contactId,
      status: 'active',
      stepIndex: 0,
      nextDueAt: dueAt,
      timeZone,
      source: input.source || 'manual',
      enrolledBy: input.userId,
    })
    enrolmentId = String(created._id)
  } catch (error: any) {
    if (Number(error?.code) !== DUPLICATE_KEY) throw error
    const existing: any = await SequenceEnrolment.findOne({
      organizationId: input.organizationId,
      sequenceId: sequence._id,
      contactId: input.contactId,
      status: 'active',
    }).select('_id').lean()
    return { enrolmentId: String(existing?._id || ''), created: false, skippedReason: 'already_enrolled' }
  }

  await mongoStepStore.schedule({
    organizationId: input.organizationId,
    enrolmentId,
    sequenceId: String(sequence._id),
    stepIndex: 0,
    channel: firstStep.channel,
    dueAt,
  })

  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    actorType: input.userId ? 'user' : 'system',
    action: 'sequence.contact_enrolled',
    entityType: 'SequenceEnrolment',
    entityId: enrolmentId,
    metadata: { sequenceId: String(sequence._id), sequenceVersion: Number(version.version), source: input.source || 'manual', firstStepDueAt: dueAt },
  })

  return { enrolmentId, created: true }
}

/**
 * Remove a contact from a sequence.
 *
 * This is the path every exit signal takes — a reply, a conversion, an operator
 * decision. Pending steps are cancelled in the same operation, because an
 * enrolment marked exited while its scheduled steps stay pending is exactly the
 * bug that sends a follow-up to someone who already replied.
 */
export async function exitEnrolment(input: {
  organizationId: string
  enrolmentId: string
  reason: ExitReason
  userId?: string
  now?: Date
}): Promise<{ exited: boolean }> {
  const now = input.now ?? new Date()
  const result = await SequenceEnrolment.updateOne(
    { _id: input.enrolmentId, organizationId: input.organizationId, status: 'active' },
    { $set: { status: 'exited', exitReason: input.reason, exitedAt: now, nextDueAt: null } },
  )
  const exited = Number((result as any).modifiedCount || 0) === 1
  if (!exited) return { exited: false }

  await mongoStepStore.cancelPendingForEnrolment({
    organizationId: input.organizationId,
    enrolmentId: input.enrolmentId,
    reason: input.reason,
    now,
  })

  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    actorType: input.userId ? 'user' : 'system',
    action: 'sequence.enrolment_exited',
    entityType: 'SequenceEnrolment',
    entityId: input.enrolmentId,
    metadata: { reason: input.reason },
  })
  return { exited: true }
}

/**
 * Exit every active enrolment for a contact on channels a suppression now
 * blocks. Called when an unsubscribe or hard bounce arrives, so the effect is
 * immediate rather than waiting for each sequence to reach its next step.
 */
export async function exitEnrolmentsForContact(input: {
  organizationId: string
  contactId: string
  reason: ExitReason
  now?: Date
}): Promise<{ exited: number }> {
  const now = input.now ?? new Date()
  const active: any[] = await SequenceEnrolment.find({
    organizationId: input.organizationId,
    contactId: input.contactId,
    status: 'active',
  }).select('_id').limit(500).lean()

  let exited = 0
  for (const enrolment of active) {
    const result = await exitEnrolment({
      organizationId: input.organizationId,
      enrolmentId: String(enrolment._id),
      reason: input.reason,
      now,
    })
    if (result.exited) exited += 1
  }
  return { exited }
}

/** Operator-facing view of where an enrolment has got to. */
export async function enrolmentProgress(input: { organizationId: string; enrolmentId: string }) {
  const enrolment: any = await SequenceEnrolment.findOne({ _id: input.enrolmentId, organizationId: input.organizationId }).lean()
  if (!enrolment) return null
  const steps: any[] = await ScheduledStep.find({ organizationId: input.organizationId, enrolmentId: enrolment._id })
    .sort({ stepIndex: 1 }).select('stepIndex channel dueAt status attempts deferralCount lastError').lean()
  return {
    id: String(enrolment._id),
    sequenceId: String(enrolment.sequenceId),
    sequenceVersion: Number(enrolment.sequenceVersion),
    contactId: String(enrolment.contactId),
    status: enrolment.status,
    stepIndex: Number(enrolment.stepIndex || 0),
    nextDueAt: enrolment.nextDueAt,
    exitReason: enrolment.exitReason,
    timeZone: enrolment.timeZone,
    steps: steps.map((step) => ({
      stepIndex: Number(step.stepIndex),
      channel: step.channel,
      dueAt: step.dueAt,
      status: step.status,
      attempts: Number(step.attempts || 0),
      deferralCount: Number(step.deferralCount || 0),
      lastError: step.lastError,
    })),
  }
}
