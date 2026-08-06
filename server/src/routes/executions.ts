import crypto from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { Router } from 'express'
import { Types } from 'mongoose'
import Execution from '../models/Execution'
import Workflow from '../models/Workflow'
import { workflowQueue } from '../queue'
import { decryptJson, encryptJson } from '../security/encryption'
import { asyncHandler, HttpError } from '../http/problem'
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor'
import { requireOrganizationId, requestCorrelationId } from '../types/authenticatedRequest'
import { requireIdempotency } from '../middleware/idempotency'
import { recordAudit } from '../services/audit'

const router = Router()
const executionStatuses = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'partial', 'cancel_requested', 'cancelled'] as const

function executionId(req: any): string {
  const id = String(req.params?.id || '')
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid execution', 'Execution identifier is invalid')
  return id
}

function errorMessage(error: any): string | undefined {
  if (!error) return undefined
  if (typeof error === 'string') return error.slice(0, 1_000)
  return String(error.message || error.code || 'Execution failed').slice(0, 1_000)
}

function safeExecution(row: any, detail = false) {
  const source = row?.toObject ? row.toObject() : row
  const workflow = source.workflowId && typeof source.workflowId === 'object' && source.workflowId.name ? source.workflowId : undefined
  const workflowId = String(workflow?._id || source.workflowId || '')
  const steps = detail ? (source.steps || []).map((step: any, index: number) => ({
    id: String(step.nodeId || index),
    nodeId: step.nodeId,
    name: step.type || `Step ${index + 1}`,
    type: step.type,
    status: step.status,
    attempt: step.attempt,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    durationMs: step.startedAt && step.finishedAt ? new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime() : undefined,
    output: step.output,
    error: errorMessage(step.error),
  })) : undefined
  return {
    id: String(source._id),
    workflowId,
    workflowName: workflow?.name || undefined,
    workflowVersionId: source.workflowVersionId ? String(source.workflowVersionId) : undefined,
    retryOfExecutionId: source.retryOfExecutionId ? String(source.retryOfExecutionId) : undefined,
    correlationId: source.correlationId,
    status: source.status,
    trigger: source.triggerKind || source.checkpoint?.triggerKind || 'Workflow',
    startedAt: source.startedAt,
    finishedAt: source.finishedAt,
    durationMs: source.durationMs,
    currentNodeId: source.currentNodeId,
    stepCount: Number(source.stepCount || source.steps?.length || 0),
    ...(detail ? { input: source.input, output: source.output, error: errorMessage(source.error), steps } : { error: errorMessage(source.error) }),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }
}

function csvCell(value: unknown): string {
  let text = String(value ?? '')
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

router.get('/export', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="logicflower-executions.csv"')
  res.setHeader('Cache-Control', 'private, no-store')
  async function* lines() {
    yield 'executionId,workflowId,status,startedAt,finishedAt,durationMs,correlationId,error\n'
    const cursor: any = Execution.find({ organizationId }).sort({ _id: -1 }).limit(50_000).select('_id workflowId status startedAt finishedAt durationMs correlationId error').lean().cursor()
    for await (const row of cursor) {
      yield [row._id, row.workflowId, row.status, row.startedAt?.toISOString?.(), row.finishedAt?.toISOString?.(), row.durationMs, row.correlationId, errorMessage(row.error)].map(csvCell).join(',') + '\n'
    }
  }
  await recordAudit({ action: 'execution.exported', req, entityType: 'Execution' })
  await pipeline(Readable.from(lines()), res)
}))

router.get('/stats', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const rows = await Execution.aggregate([
    { $match: { organizationId } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ])
  res.json({ total: rows.reduce((sum, row) => sum + row.count, 0), byStatus: Object.fromEntries(rows.map(row => [row._id, row.count])) })
}))

router.get('/', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  const query: Record<string, unknown> = { organizationId }
  if (cursor) query._id = { $lt: cursor }
  if (req.query.status) {
    const status = String(req.query.status)
    if (!executionStatuses.includes(status as any)) throw new HttpError(400, 'Invalid status', 'Execution status filter is invalid')
    query.status = status
  }
  const search = String(req.query.query || '').trim().slice(0, 160)
  if (search) {
    const alternatives: Record<string, unknown>[] = [{ correlationId: search }]
    if (Types.ObjectId.isValid(search)) alternatives.push({ _id: search }, { workflowId: search })
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const workflows = await Workflow.find({ organizationId, name: { $regex: escaped, $options: 'i' } }).limit(50).select('_id').lean()
    if (workflows.length) alternatives.push({ workflowId: { $in: workflows.map(row => row._id) } })
    query.$or = alternatives
  }
  const rows: any[] = await Execution.find(query).sort({ _id: -1 }).limit(limit + 1).populate('workflowId', 'name').lean()
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit).map(row => safeExecution(row))
  res.json({ items, nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null })
}))

router.get('/:id', asyncHandler(async (req, res) => {
  const row: any = await Execution.findOne({ _id: executionId(req), organizationId: requireOrganizationId(req) }).populate('workflowId', 'name').lean()
  if (!row) throw new HttpError(404, 'Execution not found', 'Execution not found')
  res.json(safeExecution(row, true))
}))

router.post('/:id/retry', requireIdempotency, asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const source: any = await Execution.findOne({ _id: executionId(req), organizationId }).select('+inputCiphertext').lean()
  if (!source) throw new HttpError(404, 'Execution not found', 'Execution not found')
  if (!['failed', 'partial', 'cancelled'].includes(source.status)) throw new HttpError(409, 'Execution cannot retry', 'Only failed, partial, or cancelled executions can be retried')
  const workflow: any = await Workflow.findOne({ _id: source.workflowId, organizationId, status: 'published' }).select('_id').lean()
  if (!workflow) throw new HttpError(409, 'Workflow unavailable', 'The workflow must be published before this execution can be retried')
  const payload = source.inputCiphertext
    ? decryptJson(source.inputCiphertext, `workflow-input:${organizationId}:${source._id}`)
    : source.input || {}
  const correlationId = requestCorrelationId(req) || crypto.randomUUID()
  const execution: any = new Execution({
    organizationId,
    workflowId: source.workflowId,
    workflowVersionId: source.workflowVersionId,
    definitionHash: source.definitionHash,
    retryOfExecutionId: source._id,
    correlationId,
    status: 'queued',
    input: source.input || {},
    steps: [],
    checkpoint: {},
  })
  execution.inputCiphertext = encryptJson(payload, `workflow-input:${organizationId}:${execution._id}`)
  await execution.save()
  await workflowQueue.add('run', {
    organizationId,
    workflowId: String(source.workflowId),
    execId: String(execution._id),
    correlationId,
  }, { jobId: `execution-${execution._id}`, attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 })
  await recordAudit({ action: 'execution.retried', req, entityType: 'Execution', entityId: String(execution._id), metadata: { retryOfExecutionId: String(source._id) } })
  res.status(202).json(safeExecution(execution))
}))

router.post('/:id/cancel', requireIdempotency, asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const row: any = await Execution.findOneAndUpdate({
    _id: executionId(req),
    organizationId,
    status: { $in: ['queued', 'running', 'waiting', 'cancel_requested'] },
  }, {
    $set: { status: 'cancel_requested', cancelRequestedAt: new Date(), cancelRequestedBy: req.auth?.userId },
  }, { new: true })
  if (!row) throw new HttpError(409, 'Execution cannot cancel', 'Execution is complete or does not exist')
  await recordAudit({ action: 'execution.cancel_requested', req, entityType: 'Execution', entityId: String(row._id) })
  res.status(202).json(safeExecution(row))
}))

export default router
