import crypto from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { chmod, mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { Router } from 'express'
import multer from 'multer'
import { Types } from 'mongoose'
import BatchJob from '../models/BatchJob'
import BatchRecord from '../models/BatchRecord'
import Organization from '../models/Organization'
import PlatformConnection from '../models/PlatformConnection'
import { approveBatch, createBatch, createBatchFromChunks, enqueueBatch, previewBatch, readBatchRecordInput, retryFailedRecords } from '../services/batchService'
import { requireOrganizationId, requestCorrelationId } from '../types/authenticatedRequest'
import { streamCsvChunks } from '../services/csvIngest'
import { openArtifact, safeDownloadFileName, storeArtifactFromFile } from '../services/artifactStore'
import { asyncHandler, HttpError, problemType} from '../http/problem'
import { env } from '../env'
import { recordAudit } from '../services/audit'
import { requireIdempotency } from '../middleware/idempotency'

const router = Router()

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, callback) => callback(null, `logicflower-upload-${crypto.randomUUID()}`),
  }),
  limits: { files: 1, fileSize: env.ARTIFACT_MAX_BYTES, fields: 20, fieldSize: 32_768 },
  fileFilter: (_req, file, callback) => {
    const extensionAllowed = path.extname(file.originalname).toLowerCase() === '.csv'
    const typeAllowed = ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain', 'application/octet-stream'].includes(file.mimetype)
    if (!extensionAllowed || !typeAllowed) return callback(new Error('Only CSV files are accepted'))
    callback(null, true)
  },
})

function singleCsv(req: any, res: any, next: any) {
  upload.single('file')(req, res, async (error) => {
    if (!error) {
      if (req.file?.path) {
        try {
          req.uploadHash = await new Promise<string>((resolve, reject) => {
            const hash = crypto.createHash('sha256'); const stream = createReadStream(req.file.path)
            stream.on('data', (chunk) => hash.update(chunk)); stream.once('error', reject); stream.once('end', () => resolve(hash.digest('hex')))
          })
        } catch (hashError) { next(hashError); return }
      }
      next(); return
    }
    next(new HttpError(400, 'CSV upload rejected', String(error.message || error), problemType('csv-upload')))
  })
}

function safeBatch(job: any) {
  const source = job?.toObject ? job.toObject() : job
  const stats = source.stats || {}
  return {
    ...source,
    id: String(source._id),
    total: Number(stats.total || 0),
    processed: Number(stats.succeeded || 0) + Number(stats.failed || 0) + Number(stats.skipped || 0),
    succeeded: Number(stats.succeeded || 0),
    failed: Number(stats.failed || 0),
    rollbackAvailable: Boolean(source.artifacts?.rollbackAvailable),
  }
}

function dedupeFields(rule: string | undefined): string[] {
  switch (rule) {
    case 'email': return ['email']
    case 'phone': return ['phone']
    case 'external_id': return ['id']
    default: return ['email', 'phone']
  }
}

function csvCell(value: unknown): string {
  let text = String(value ?? '')
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

function batchId(req: any): string {
  const id = String(req.params?.id || '')
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid batch', 'Batch identifier is invalid')
  return id
}

async function resolveBatchInput(req: any, organizationId: string) {
  const isUpload = Boolean(req.file)
  let rows: any[] = []
  let csvPath: string | undefined
  let source: Record<string, unknown>
  let sourceArtifact: any
  if (isUpload) {
    await chmod(req.file.path, 0o600)
    // The file is not materialised here. A chunk generator is carried through
    // so rows are normalised, encrypted and inserted a chunk at a time.
    csvPath = req.file.path
    const organization: any = await Organization.findById(organizationId).select('retentionDays').lean()
    const retentionDays = Math.min(2_555, Math.max(7, Number(organization?.retentionDays || 90)))
    sourceArtifact = await storeArtifactFromFile({
      organizationId,
      kind: 'batch_source',
      sourcePath: req.file.path,
      fileName: req.file.originalname,
      contentType: 'text/csv; charset=utf-8',
      createdBy: req.auth?.userId,
      expiresAt: new Date(Date.now() + retentionDays * 86_400_000),
      metadata: { originalMimeType: req.file.mimetype, rowCount: rows.length },
    })
    source = { type: 'artifact', artifactId: String(sourceArtifact._id), originalFileName: sourceArtifact.fileName }
  } else {
    if (!Array.isArray(req.body?.rows)) throw new HttpError(415, 'CSV or JSON rows required', 'Submit multipart/form-data with a CSV file or application/json with a rows array')
    rows = req.body.rows
    source = { type: 'inline' }
  }

  const operation = String(req.body?.operation || 'contact.upsert')
  const connectionId = String(req.body?.connectionId || '').trim() || undefined
  let provider = String(req.body?.provider || '').trim() || undefined
  if (connectionId) {
    if (!Types.ObjectId.isValid(connectionId)) throw new HttpError(400, 'Invalid connection', 'Connection identifier is invalid')
    const connection: any = await PlatformConnection.findOne({ _id: connectionId, organizationId, status: { $in: ['active', 'degraded'] } }).select('provider').lean()
    if (!connection) throw new HttpError(404, 'Connection not found', 'An active connection was not found in this organization')
    if (provider && provider !== connection.provider) throw new HttpError(400, 'Provider mismatch', 'The selected provider does not match the connection')
    provider = connection.provider
  }
  if (!provider && operation !== 'deduplicate' && operation !== 'local.deduplicate') {
    throw new HttpError(422, 'Connection required', 'A valid platform connection is required for this operation')
  }

  let options: Record<string, unknown> = {}
  if (typeof req.body?.options === 'string' && req.body.options.trim()) {
    try { options = JSON.parse(req.body.options) }
    catch { throw new HttpError(400, 'Invalid batch options', 'options must be valid JSON') }
  } else if (req.body?.options && typeof req.body.options === 'object') options = req.body.options
  options = { ...options, dedupeBy: dedupeFields(String(req.body?.duplicateRule || '')) }
  return {
    rows,
    csvPath,
    source,
    sourceArtifact,
    provider: (provider || 'generic') as any,
    connectionId,
    operation,
    options,
    name: String(req.body?.name || req.file?.originalname || 'Batch').trim().slice(0, 160),
  }
}

router.get('/', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)))
  const query: any = { organizationId }
  if (req.query.status) query.status = String(req.query.status)
  if (req.query.before) {
    if (!Types.ObjectId.isValid(String(req.query.before))) throw new HttpError(400, 'Invalid cursor', 'Batch cursor is invalid')
    query._id = { $lt: String(req.query.before) }
  }
  const rows: any[] = await BatchJob.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit).map(safeBatch)
  res.json({ items, nextCursor: hasMore ? String(items.at(-1)?._id) : null })
}))

router.post('/', singleCsv, requireIdempotency, asyncHandler(async (req: any, res) => {
  const organizationId = requireOrganizationId(req)
  try {
    const input = await resolveBatchInput(req, organizationId)
    async function* inlineChunks() {
      for (let offset = 0; offset < input.rows.length; offset += 1_000) yield input.rows.slice(offset, offset + 1_000)
    }
    const chunks = input.csvPath ? streamCsvChunks(input.csvPath) : inlineChunks()
    const result: any = await createBatchFromChunks({
      organizationId,
      userId: req.auth?.userId,
      name: input.name,
      provider: input.provider,
      connectionId: input.connectionId,
      operation: input.operation,
      chunks,
      options: input.options,
      source: input.source,
      correlationId: requestCorrelationId(req) || crypto.randomUUID(),
    })
    await recordAudit({ action: 'batch.created', req, entityType: 'BatchJob', entityId: String(result.job._id), metadata: { operation: result.job.operation, records: Number(result.job.stats?.total || 0) } })
    res.status(201).json({ ...safeBatch(result.job), preview: result.preview, previewHash: result.previewHash, warnings: result.warnings })
  } finally {
    if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => undefined)
  }
}))

router.get('/:id', asyncHandler(async (req, res) => {
  const id = batchId(req)
  const job: any = await BatchJob.findOne({ _id: id, organizationId: requireOrganizationId(req) }).lean()
  if (!job) throw new HttpError(404, 'Batch not found', 'Batch job not found')
  res.json(safeBatch(job))
}))

router.post('/:id/preview', requireIdempotency, asyncHandler(async (req, res) => {
  const result: any = await previewBatch(requireOrganizationId(req), batchId(req))
  res.json({ ...safeBatch(result.job), preview: result.preview, previewHash: result.previewHash, warnings: result.warnings })
}))

router.post('/:id/approve', requireIdempotency, asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const id = batchId(req)
  const current: any = await BatchJob.findOne({ _id: id, organizationId })
  if (!current) throw new HttpError(404, 'Batch not found', 'Batch job not found')
  if (req.body?.confirmation !== 'APPROVE') throw new HttpError(422, 'Approval required', 'Type APPROVE to approve this exact preview')
  const previewHash = String(req.body?.previewHash || '')
  await approveBatch({ organizationId, batchJobId: id, previewHash, userId: req.auth?.userId })
  const queued: any = await enqueueBatch(organizationId, id)
  await recordAudit({ action: 'batch.approved', req, entityType: 'BatchJob', entityId: id, metadata: { previewHash } })
  res.status(202).json(safeBatch(queued))
}))

router.post('/:id/start', requireIdempotency, asyncHandler(async (req, res) => res.status(202).json(safeBatch(await enqueueBatch(requireOrganizationId(req), batchId(req))))))

router.post('/:id/pause', requireIdempotency, asyncHandler(async (req, res) => {
  const id = batchId(req)
  const job: any = await BatchJob.findOneAndUpdate({ _id: id, organizationId: requireOrganizationId(req), status: { $in: ['queued', 'running'] } }, { $set: { status: 'paused' } }, { new: true })
  if (!job) throw new HttpError(409, 'Batch cannot pause', 'Batch is not queued or running')
  await recordAudit({ action: 'batch.paused', req, entityType: 'BatchJob', entityId: id })
  res.json(safeBatch(job))
}))

router.post('/:id/resume', requireIdempotency, asyncHandler(async (req, res) => {
  const id = batchId(req)
  const job: any = await enqueueBatch(requireOrganizationId(req), id)
  await recordAudit({ action: 'batch.resumed', req, entityType: 'BatchJob', entityId: id })
  res.status(202).json(safeBatch(job))
}))

router.post('/:id/cancel', requireIdempotency, asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const id = batchId(req)
  const job: any = await BatchJob.findOne({ _id: id, organizationId })
  if (!job) throw new HttpError(404, 'Batch not found', 'Batch job not found')
  if (!['draft', 'preview_ready', 'approved', 'queued', 'running', 'paused', 'cancel_requested'].includes(job.status)) {
    throw new HttpError(409, 'Batch cannot cancel', `A batch in ${job.status} state cannot be cancelled`)
  }
  job.status = ['running', 'queued'].includes(job.status) ? 'cancel_requested' : 'cancelled'
  if (job.status === 'cancelled') job.finishedAt = new Date()
  await job.save()
  await recordAudit({ action: 'batch.cancel_requested', req, entityType: 'BatchJob', entityId: id })
  res.json(safeBatch(job))
}))

router.post('/:id/retry-failures', requireIdempotency, asyncHandler(async (req, res) => {
  const id = batchId(req)
  const job: any = await retryFailedRecords(requireOrganizationId(req), id)
  await recordAudit({ action: 'batch.failures_retried', req, entityType: 'BatchJob', entityId: id })
  res.status(202).json(safeBatch(job))
}))

router.post('/:id/rollback', requireIdempotency, asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const id = batchId(req)
  const parent: any = await BatchJob.findOne({ _id: id, organizationId })
  if (!parent) throw new HttpError(404, 'Batch not found', 'Batch job not found')
  if (!parent.artifacts?.rollbackAvailable || !['completed', 'completed_with_errors'].includes(parent.status)) {
    throw new HttpError(409, 'Rollback unavailable', 'This batch does not have complete before-state coverage for a safe compensating operation')
  }
  const records: any[] = await BatchRecord.find({ organizationId, batchJobId: parent._id, status: 'succeeded', beforeStateCiphertext: { $exists: true } }).sort({ rowNumber: 1 }).select('+beforeStateCiphertext')
  const rows = []
  for (const record of records) rows.push(await readBatchRecordInput(record, 'before'))
  if (!rows.length || rows.length !== Number(parent.stats?.succeeded || 0)) throw new HttpError(409, 'Rollback unavailable', 'Before-state coverage is incomplete')
  const result: any = await createBatch({ organizationId, userId: req.auth?.userId, name: `Rollback: ${parent.name}`.slice(0, 160), provider: parent.provider, connectionId: String(parent.connectionId || ''), operation: parent.operation, rows, options: parent.options, source: { type: 'rollback', parentBatchJobId: String(parent._id) }, correlationId: requestCorrelationId(req) || crypto.randomUUID() })
  await recordAudit({ action: 'batch.rollback_preview_created', req, entityType: 'BatchJob', entityId: String(result.job._id), metadata: { parentBatchJobId: String(parent._id) } })
  res.status(201).json({ ...safeBatch(result.job), preview: result.preview, previewHash: result.previewHash, warnings: result.warnings })
}))

router.get('/:id/failed.csv', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const id = batchId(req)
  const job: any = await BatchJob.findOne({ _id: id, organizationId })
  if (!job) throw new HttpError(404, 'Batch not found', 'Batch job not found')
  if (!['completed_with_errors', 'failed', 'paused', 'cancelled'].includes(job.status)) throw new HttpError(409, 'Export unavailable', 'Failed rows can be exported after processing reaches a safe checkpoint')

  const version = `${job.updatedAt?.toISOString?.() || ''}:${Number(job.stats?.failed || 0)}`
  let artifactId = job.artifacts?.failedCsvVersion === version ? job.artifacts?.failedCsvArtifactId : undefined
  if (!artifactId) {
    const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'logicflower-failed-csv-'))
    const filePath = path.join(workDirectory, 'failed.csv')
    try {
      async function* lines() {
        yield 'rowNumber,input,error\n'
        const cursor: any = BatchRecord.find({ organizationId, batchJobId: job._id, status: { $in: ['failed', 'outcome_unknown'] } }).sort({ rowNumber: 1 }).select('+inputCiphertext').cursor()
        for await (const record of cursor) {
          const input = await readBatchRecordInput(record, 'input')
          yield `${record.rowNumber},${csvCell(JSON.stringify(input))},${csvCell(record.error?.message || 'Failed')}\n`
        }
      }
      await pipeline(Readable.from(lines()), createWriteStream(filePath, { flags: 'wx', mode: 0o600 }))
      const organization: any = await Organization.findById(organizationId).select('retentionDays').lean()
      const retentionDays = Math.min(90, Math.max(7, Number(organization?.retentionDays || 7)))
      const artifact: any = await storeArtifactFromFile({ organizationId, kind: 'batch_failed_export', sourcePath: filePath, fileName: `${job.name || `batch-${job._id}`}-failed.csv`, contentType: 'text/csv; charset=utf-8', createdBy: req.auth?.userId, metadata: { batchJobId: String(job._id), version }, expiresAt: new Date(Date.now() + retentionDays * 86_400_000) })
      artifactId = String(artifact._id)
      job.artifacts = { ...(job.artifacts || {}), failedCsvArtifactId: artifactId, failedCsvVersion: version }
      await job.save()
    } finally {
      await rm(workDirectory, { recursive: true, force: true })
    }
  }
  const { artifact, stream } = await openArtifact(organizationId, String(artifactId))
  const fileName = safeDownloadFileName(artifact.fileName)
  res.setHeader('Content-Type', artifact.contentType)
  res.setHeader('Content-Length', String(artifact.plaintextSize))
  res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '_')}"`)
  res.setHeader('Cache-Control', 'private, no-store')
  await recordAudit({ action: 'batch.failed_export_downloaded', req, entityType: 'BatchJob', entityId: id, metadata: { artifactId } })
  await pipeline(stream, res)
}))

export default router
