import crypto from 'crypto'
import Deal from '../../models/Deal'
import Pipeline from '../../models/Pipeline'
import Sequence from '../../models/Sequence'
import SequenceEnrolment from '../../models/SequenceEnrolment'
import { HttpError, problemType } from '../../http/problem'
import { recordAudit } from '../audit'
import { enrolContact, exitEnrolment } from '../sequences/enrolmentService'
import { recordActivity } from './contactActivity'
import { createStageTasks } from './scheduling'

/**
 * Pipelines, deals, and the join between the CRM and the follow-up engine.
 *
 * The load-bearing part of this file is `moveDeal`. A stage change is the most
 * useful trigger a small business has — "quote sent" starts a chase sequence,
 * "won" stops it — and wiring it to the Phase 1 enrolment engine is what makes
 * the CRM worth having rather than a second place to type things.
 */

export const MAX_STAGES = 20

export interface PipelineStageInput {
  stageId?: string
  name: string
  outcome?: 'open' | 'won' | 'lost'
  probability?: number
  enrolSequenceId?: string | null
  exitSequenceId?: string | null
  taskTemplates?: Array<{ title: string; dueInHours?: number | null; priority?: 'low' | 'normal' | 'high' }>
}

export class PipelineError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join('; '))
    this.name = 'PipelineError'
    this.issues = issues
  }
}

/**
 * Validate and canonicalise stages.
 *
 * `stageId` is generated once and preserved across every later edit. Deriving
 * it from the name instead would mean renaming "Quoted" to "Proposal Sent"
 * orphans every deal sitting in it and silently breaks any sequence trigger
 * bound to it. Positions are assigned from array order for the same reason
 * sequence step indices are: a client-supplied position arrives duplicated.
 */
export interface CanonicalStage {
  stageId: string
  name: string
  position: number
  outcome: 'open' | 'won' | 'lost'
  probability: number
  enrolSequenceId: string | null
  exitSequenceId: string | null
  taskTemplates: Array<{ title: string; dueInHours: number | null; priority: 'low' | 'normal' | 'high' }>
}

export function canonicaliseStages(input: PipelineStageInput[]): CanonicalStage[] {
  const issues: string[] = []
  const stages = Array.isArray(input) ? input : []
  if (!stages.length) issues.push('a pipeline requires at least one stage')
  if (stages.length > MAX_STAGES) issues.push(`a pipeline cannot have more than ${MAX_STAGES} stages`)

  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const canonical = stages.map((stage, position) => {
    const name = String(stage?.name || '').trim().slice(0, 80)
    if (!name) issues.push(`stage ${position + 1}: a name is required`)
    const lowered = name.toLowerCase()
    if (lowered && seenNames.has(lowered)) issues.push(`stage ${position + 1}: "${name}" duplicates an earlier stage name`)
    seenNames.add(lowered)

    const stageId = String(stage?.stageId || '').trim() || crypto.randomBytes(8).toString('hex')
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(stageId)) issues.push(`stage ${position + 1}: stage identifier is malformed`)
    if (seenIds.has(stageId)) issues.push(`stage ${position + 1}: duplicate stage identifier`)
    seenIds.add(stageId)

    const outcome = stage?.outcome || 'open'
    if (!['open', 'won', 'lost'].includes(outcome)) issues.push(`stage ${position + 1}: outcome must be open, won or lost`)

    const probability = Number(stage?.probability ?? 0)
    if (!Number.isFinite(probability) || probability < 0 || probability > 100) issues.push(`stage ${position + 1}: probability must be between 0 and 100`)

    return {
      stageId,
      name,
      position,
      outcome: outcome as 'open' | 'won' | 'lost',
      probability,
      enrolSequenceId: stage?.enrolSequenceId ? String(stage.enrolSequenceId) : null,
      exitSequenceId: stage?.exitSequenceId ? String(stage.exitSequenceId) : null,
      taskTemplates: (Array.isArray(stage?.taskTemplates) ? stage.taskTemplates : []).slice(0, 10).map((template: any, index: number) => {
        const title = String(template?.title || '').trim().slice(0, 200)
        if (!title) issues.push(`stage ${position + 1}, task ${index + 1}: a title is required`)
        const dueInHours = template?.dueInHours == null ? null : Number(template.dueInHours)
        if (dueInHours !== null && (!Number.isFinite(dueInHours) || dueInHours < 0 || dueInHours > 24 * 365)) {
          issues.push(`stage ${position + 1}, task ${index + 1}: dueInHours must be between 0 and one year`)
        }
        return { title, dueInHours, priority: template?.priority === 'high' || template?.priority === 'low' ? template.priority : 'normal' }
      }),
    }
  })

  if (canonical.length && !canonical.some((stage) => stage.outcome === 'open')) {
    issues.push('a pipeline needs at least one open stage; one made entirely of won and lost stages has nowhere for a live deal to sit')
  }
  if (issues.length) throw new PipelineError(issues)
  return canonical
}

/**
 * Confirm that every sequence a stage references exists in this organisation.
 *
 * Checked at pipeline save rather than at stage-change time, so a misconfigured
 * trigger surfaces to the person configuring it rather than failing silently
 * weeks later when a deal finally reaches that stage.
 */
export async function assertStageSequencesExist(organizationId: string, stages: Array<{ enrolSequenceId: string | null; exitSequenceId: string | null; name: string }>): Promise<void> {
  const ids = [...new Set(stages.flatMap((stage) => [stage.enrolSequenceId, stage.exitSequenceId]).filter(Boolean) as string[])]
  if (!ids.length) return
  const found: any[] = await Sequence.find({ organizationId, _id: { $in: ids } }).select('_id').lean()
  const foundIds = new Set(found.map((row) => String(row._id)))
  const missing = ids.filter((id) => !foundIds.has(id))
  if (missing.length) {
    throw new HttpError(400, 'Sequence not found', `A stage references ${missing.length} sequence(s) that do not exist in this organisation`, problemType('pipeline-sequence-missing'))
  }
}

export interface MoveDealResult {
  moved: boolean
  fromStageId?: string
  toStageId: string
  status: 'open' | 'won' | 'lost'
  enrolledSequenceId?: string
  exitedSequenceIds: string[]
  createdTaskIds?: string[]
}

/**
 * Move a deal to a stage, and fire whatever that stage triggers.
 *
 * Ordering matters. The stage change is written first with a compare-and-swap
 * on the current stage, and only then are sequences touched. If enrolment
 * failed after the write, the deal is still in the right stage and the
 * enrolment can be retried; if the write happened after enrolment and then
 * failed, the contact is being chased about a stage the deal is not in.
 *
 * Exits are applied before enrolments so a stage that both stops a nurture
 * sequence and starts a chase sequence does them in the order an operator
 * expects, rather than briefly having the contact in both.
 */
export async function moveDeal(input: {
  organizationId: string
  dealId: string
  toStageId: string
  userId?: string
  now?: Date
}): Promise<MoveDealResult> {
  const now = input.now ?? new Date()

  const deal: any = await Deal.findOne({ _id: input.dealId, organizationId: input.organizationId }).lean()
  if (!deal) throw new HttpError(404, 'Deal not found', 'No deal with that identifier exists in this organisation', problemType('deal-not-found'))

  const pipeline: any = await Pipeline.findOne({ _id: deal.pipelineId, organizationId: input.organizationId }).lean()
  if (!pipeline) throw new HttpError(409, 'Pipeline missing', 'The pipeline this deal belongs to no longer exists', problemType('pipeline-not-found'))

  const target = (pipeline.stages || []).find((stage: any) => String(stage.stageId) === String(input.toStageId))
  if (!target) throw new HttpError(400, 'Stage not found', 'That stage does not exist in this deal\'s pipeline', problemType('pipeline-stage-not-found'))

  const fromStageId = String(deal.stageId)
  if (fromStageId === String(input.toStageId)) {
    return { moved: false, fromStageId, toStageId: fromStageId, status: deal.status, exitedSequenceIds: [] }
  }
  const fromStage = (pipeline.stages || []).find((stage: any) => String(stage.stageId) === fromStageId)

  const status: 'open' | 'won' | 'lost' = target.outcome === 'won' ? 'won' : target.outcome === 'lost' ? 'lost' : 'open'

  // Compare-and-swap on the current stage. Two operators dragging the same card
  // at once produce one move, and the loser sees the board it did not expect
  // rather than silently overwriting.
  const result = await Deal.updateOne(
    { _id: input.dealId, organizationId: input.organizationId, stageId: fromStageId },
    {
      $set: {
        stageId: String(input.toStageId),
        status,
        stageEnteredAt: now,
        closedAt: status === 'open' ? null : now,
      },
    },
  )
  if (Number((result as any).modifiedCount || 0) !== 1) {
    throw new HttpError(409, 'Deal moved concurrently', 'This deal changed stage while your request was in flight; reload the board and try again', problemType('deal-stage-conflict'))
  }

  const contactId = String(deal.contactId)
  const exitedSequenceIds: string[] = []
  let enrolledSequenceId: string | undefined

  // Exits first. A stage that both stops nurturing and starts chasing should
  // not leave the contact briefly in both.
  if (target.exitSequenceId) {
    const active: any[] = await SequenceEnrolment.find({
      organizationId: input.organizationId,
      contactId,
      sequenceId: target.exitSequenceId,
      status: 'active',
    }).select('_id').limit(50).lean()
    for (const enrolment of active) {
      const exited = await exitEnrolment({
        organizationId: input.organizationId,
        enrolmentId: String(enrolment._id),
        reason: status === 'won' ? 'converted' : 'manually_removed',
        userId: input.userId,
        now,
      })
      if (exited.exited) exitedSequenceIds.push(String(target.exitSequenceId))
    }
  }

  if (target.enrolSequenceId) {
    const enrolment = await enrolContact({
      organizationId: input.organizationId,
      sequenceId: String(target.enrolSequenceId),
      contactId,
      source: `pipeline_stage:${pipeline._id}:${target.stageId}`,
      userId: input.userId,
      now,
    })
    if (enrolment.created) enrolledSequenceId = String(target.enrolSequenceId)
  }

  // Tasks the stage declares. Raised after the stage write, like the sequence
  // triggers above, so a failure here cannot roll back the move.
  const createdTaskIds = (target.taskTemplates || []).length
    ? await createStageTasks({
      organizationId: input.organizationId,
      contactId,
      dealId: input.dealId,
      templates: target.taskTemplates,
      assigneeUserId: deal.ownerUserId ? String(deal.ownerUserId) : null,
      timeZone: 'UTC',
      now,
      userId: input.userId,
    })
    : []

  await recordActivity({
    organizationId: input.organizationId,
    contactId,
    type: status === 'won' ? 'deal.won' : status === 'lost' ? 'deal.lost' : 'deal.stage_changed',
    summary: `Deal "${deal.title}" moved from ${fromStage?.name || 'an earlier stage'} to ${target.name}`,
    entityType: 'Deal',
    entityId: input.dealId,
    metadata: { pipeline: pipeline.name, fromStage: fromStage?.name, toStage: target.name, status },
    actorUserId: input.userId,
    occurredAt: now,
  })

  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    actorType: input.userId ? 'user' : 'system',
    action: 'deal.stage_changed',
    entityType: 'Deal',
    entityId: input.dealId,
    metadata: { fromStageId, toStageId: String(input.toStageId), status, enrolledSequenceId, exitedSequenceIds, tasksCreated: createdTaskIds.length },
  })

  return { moved: true, fromStageId, toStageId: String(input.toStageId), status, enrolledSequenceId, exitedSequenceIds, createdTaskIds }
}

/** Board view: stages in order, each with its open deals and a value total. */
export async function pipelineBoard(input: { organizationId: string; pipelineId: string; limitPerStage?: number }) {
  const pipeline: any = await Pipeline.findOne({ _id: input.pipelineId, organizationId: input.organizationId }).lean()
  if (!pipeline) return null

  const limit = Math.max(1, Math.min(input.limitPerStage ?? 50, 200))
  const stages = [...(pipeline.stages || [])].sort((a: any, b: any) => Number(a.position) - Number(b.position))

  const board = []
  for (const stage of stages) {
    const deals: any[] = await Deal.find({ organizationId: input.organizationId, pipelineId: input.pipelineId, stageId: stage.stageId })
      .sort({ updatedAt: -1 }).limit(limit).select('title contactId valueMinorUnits currency expectedCloseAt ownerUserId status stageEnteredAt').lean()
    board.push({
      stageId: stage.stageId,
      name: stage.name,
      outcome: stage.outcome,
      probability: stage.probability,
      // Totals are over the returned page, and labelled as such. A total that
      // silently covers only the first 50 of 400 deals is worse than none.
      pageValueMinorUnits: deals.reduce((sum, deal) => sum + Number(deal.valueMinorUnits || 0), 0),
      truncated: deals.length === limit,
      deals: deals.map((deal) => ({
        id: String(deal._id),
        title: deal.title,
        contactId: String(deal.contactId),
        valueMinorUnits: Number(deal.valueMinorUnits || 0),
        currency: deal.currency,
        expectedCloseAt: deal.expectedCloseAt,
        ownerUserId: deal.ownerUserId,
        status: deal.status,
        stageEnteredAt: deal.stageEnteredAt,
      })),
    })
  }
  return { id: String(pipeline._id), name: pipeline.name, stages: board }
}
