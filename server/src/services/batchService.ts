import crypto from 'crypto';
import BatchJob from '../models/BatchJob';
import BatchRecord from '../models/BatchRecord';
import { batchQueue } from '../queue';
import { createConnector, ConnectorProvider } from './connectors';
import { canonicalJson } from './canonicalJson';
import { decryptJson, encryptJson } from '../security/encryption';
import { redact, redactedError } from './redaction';
import { canonicalBatchOperation, normalizeBatchRecord } from './batchNormalization';
import { assertUsageAvailable, isUsageGateError, reserveMeteredUsage } from './entitlements';
export { canonicalBatchOperation, normalizeBatchRecord, normalizeEmail, normalizePhone } from './batchNormalization';

function recordAad(organizationId: string, batchJobId: string, rowNumber: number, field: string) { return `batch-record:${organizationId}:${batchJobId}:${rowNumber}:${field}`; }
function batchQueueJobId(batchJobId: string, checkpoint: string | number) { return `batch-${crypto.createHash('sha256').update(`${batchJobId}:${checkpoint}`).digest('hex').slice(0, 48)}`; }

async function updateRollbackCapability(job: any, organizationId: string) {
  const supportedOperation = ['contact.upsert', 'profile.upsert'].includes(String(job.operation))
  const supportedProvider = ['hubspot', 'klaviyo'].includes(String(job.provider))
  const succeeded = Number(job.stats?.succeeded || 0)
  const withBeforeState = supportedOperation && supportedProvider && succeeded > 0
    ? await BatchRecord.countDocuments({ organizationId, batchJobId: job._id, status: 'succeeded', beforeStateCiphertext: { $exists: true, $ne: null } })
    : 0
  job.artifacts = {
    ...(job.artifacts || {}),
    rollbackAvailable: supportedOperation && supportedProvider && succeeded > 0 && withBeforeState === succeeded,
    beforeStateRecordCount: withBeforeState,
  }
}

const providerOperations: Record<string, Set<string>> = {
  ghl: new Set(['contact.upsert', 'contact.addTag', 'contact.removeTag']),
  hubspot: new Set(['contact.upsert']),
  klaviyo: new Set(['contact.upsert', 'profile.upsert', 'event.create']),
  activecampaign: new Set(['contact.upsert']),
  google: new Set(['rows.append']),
  generic: new Set(['local.deduplicate']),
};

function validForOperation(operation: string, row: any) {
  if (operation === 'local.deduplicate') return Object.values(row || {}).some(value => String(value ?? '').trim());
  if (operation === 'contact.addTag' || operation === 'contact.removeTag') {
    const tags = Array.isArray(row?.tags) ? row.tags : [row?.tag || row?.tagId];
    return Boolean(row?.contactId || row?.id) && tags.some((value: any) => String(value || '').trim());
  }
  if (operation === 'event.create') return Boolean(row?.metricName || row?.metric?.name || row?.attributes?.metric);
  if (operation === 'rows.append') return Array.isArray(row?.values);
  return Boolean(row?.id || row?.email || row?.phone);
}

function connectorInput(operation: string, row: any) {
  if (!['contact.upsert', 'profile.upsert'].includes(operation)) return row;
  const known = new Set(['id', 'contactId', 'email', 'phone', 'mobile', 'firstName', 'lastName', 'name', 'locationId', 'properties']);
  const properties = { ...(row?.properties && typeof row.properties === 'object' ? row.properties : {}) };
  for (const [key, value] of Object.entries(row || {})) if (!known.has(key)) properties[key] = value;
  return {
    id: row?.id || row?.contactId,
    email: row?.email,
    phone: row?.phone || row?.mobile,
    firstName: row?.firstName,
    lastName: row?.lastName,
    name: row?.name,
    locationId: row?.locationId,
    properties,
  };
}

function restorableBeforeState(provider: string, before: any, requested: any) {
  const requestedProperties = new Set(Object.keys(requested?.properties || {}));
  if (provider === 'hubspot') {
    const item = before?.data || before; const properties = item?.properties;
    if (!item?.id || !properties || typeof properties !== 'object') return undefined;
    return {
      id: String(item.id),
      ...(requested.email !== undefined ? { email: properties.email } : {}),
      ...(requested.phone !== undefined ? { phone: properties.phone } : {}),
      ...(requested.firstName !== undefined ? { firstName: properties.firstname } : {}),
      ...(requested.lastName !== undefined ? { lastName: properties.lastname } : {}),
      properties: Object.fromEntries(Object.entries(properties).filter(([key]) => requestedProperties.has(key))),
    };
  }
  if (provider === 'klaviyo') {
    const item = before?.data || before; const attributes = item?.attributes;
    if (!item?.id || !attributes || typeof attributes !== 'object') return undefined;
    return {
      id: String(item.id),
      ...(requested.email !== undefined ? { email: attributes.email } : {}),
      ...(requested.phone !== undefined ? { phone: attributes.phone_number } : {}),
      ...(requested.firstName !== undefined ? { firstName: attributes.first_name } : {}),
      ...(requested.lastName !== undefined ? { lastName: attributes.last_name } : {}),
      properties: Object.fromEntries(Object.entries(attributes).filter(([key]) => requestedProperties.has(key))),
    };
  }
  return undefined;
}

export function batchDedupeKeys(row: any, fields: string[]) {
  // Multiple configured identifiers are OR rules. A shared email OR a shared phone
  // is a duplicate even when the other identifier differs.
  return fields.flatMap((field) => {
    const value = String(row?.[field] || '').trim().toLowerCase();
    return value ? [crypto.createHash('sha256').update(`${field}:${value}`).digest('hex')] : [];
  });
}

export const BATCH_MAX_ROWS = 50_000;
export const BATCH_INSERT_CHUNK = 1_000;

/**
 * Build a batch from an async source of row chunks.
 *
 * Rows are normalised, encrypted and inserted one chunk at a time, so peak
 * memory is a function of chunk size rather than of file size. Only the dedupe
 * key set is carried across the whole run, and that holds 32-byte hashes rather
 * than records.
 *
 * `total` is counted as chunks arrive rather than known upfront, which is the
 * one thing a streaming source cannot tell you in advance.
 */
export async function createBatchFromChunks(input: {
  organizationId: string; userId?: string; name?: string; provider: ConnectorProvider;
  connectionId?: string; operation: string; chunks: AsyncIterable<any[]>; options?: any;
  source?: Record<string, unknown>; correlationId: string;
}) {
  const operation = canonicalBatchOperation(input.operation);
  if (!providerOperations[input.provider]?.has(operation)) throw new Error(`${input.provider} does not support batch operation ${operation}`);

  const job: any = await BatchJob.create({
    organizationId: input.organizationId, createdBy: input.userId,
    name: String(input.name || 'Batch').trim().slice(0, 160), provider: input.provider,
    connectionId: input.connectionId, operation, status: 'draft',
    source: { ...(input.source || { type: 'inline' }), recordCount: 0 },
    options: input.options || {}, stats: { total: 0 }, correlationId: input.correlationId,
  });

  const fields = Array.isArray(input.options?.dedupeBy) && input.options.dedupeBy.length
    ? input.options.dedupeBy.map(String)
    : ['email', 'phone'];
  const seen = new Set<string>();
  let rowNumber = 0;
  let pending: any[] = [];

  const flush = async () => {
    if (!pending.length) return;
    await BatchRecord.insertMany(pending, { ordered: true });
    pending = [];
  };

  try {
    for await (const chunk of input.chunks) {
      for (const row of chunk) {
        rowNumber += 1;
        if (rowNumber > BATCH_MAX_ROWS) throw new Error(`A single batch cannot exceed ${BATCH_MAX_ROWS} records`);
        const normalized = normalizeBatchRecord(row, input.options);
        const keys = batchDedupeKeys(normalized, fields);
        const invalid = !validForOperation(operation, normalized)
          || ('email' in row && row.email && !normalized.email)
          || (('phone' in row || 'mobile' in row) && (row.phone || row.mobile) && !normalized.phone);
        const duplicate = keys.some((key) => seen.has(key));
        for (const key of keys) seen.add(key);
        pending.push({
          organizationId: input.organizationId, batchJobId: job._id, rowNumber,
          dedupeKey: keys[0] || undefined,
          contentHash: crypto.createHash('sha256').update(canonicalJson(normalized)).digest('hex'),
          status: invalid ? 'invalid' : duplicate ? 'duplicate' : 'pending',
          inputCiphertext: encryptJson(row, recordAad(input.organizationId, String(job._id), rowNumber, 'input')),
          normalizedCiphertext: encryptJson(normalized, recordAad(input.organizationId, String(job._id), rowNumber, 'normalized')),
        });
        if (pending.length >= BATCH_INSERT_CHUNK) await flush();
      }
    }
    await flush();
  } catch (error) {
    // A partially ingested batch is worse than none: its preview digest would
    // describe a file the customer never uploaded.
    await BatchRecord.deleteMany({ organizationId: input.organizationId, batchJobId: job._id });
    await BatchJob.deleteOne({ _id: job._id, organizationId: input.organizationId });
    throw error;
  }

  if (!rowNumber) {
    await BatchJob.deleteOne({ _id: job._id, organizationId: input.organizationId });
    throw new Error('rows must contain at least one record');
  }

  job.stats = { ...job.stats, total: rowNumber };
  job.source = { ...(job.source || {}), recordCount: rowNumber };
  await job.save();
  return previewBatch(input.organizationId, String(job._id));
}

/** In-memory convenience wrapper. Prefer createBatchFromChunks for file input. */
export async function createBatch(input: { organizationId: string; userId?: string; name?: string; provider: ConnectorProvider; connectionId?: string; operation: string; rows: any[]; options?: any; source?: Record<string, unknown>; correlationId: string }) {
  if (!Array.isArray(input.rows) || !input.rows.length) throw new Error('rows must contain at least one record');
  if (input.rows.length > BATCH_MAX_ROWS) throw new Error(`A single batch cannot exceed ${BATCH_MAX_ROWS} records`);
  const { rows, ...rest } = input;
  async function* single() {
    for (let offset = 0; offset < rows.length; offset += BATCH_INSERT_CHUNK) {
      yield rows.slice(offset, offset + BATCH_INSERT_CHUNK);
    }
  }
  return createBatchFromChunks({ ...rest, chunks: single() });
}

export async function previewBatch(organizationId: string, batchJobId: string) {
  const job: any = await BatchJob.findOne({ _id: batchJobId, organizationId }); if (!job) throw new Error('Batch job not found');
  if (!['draft', 'preview_ready'].includes(job.status)) throw new Error('Only a draft batch can be previewed'); job.status = 'previewing'; await job.save();
  const grouped: any[] = await BatchRecord.aggregate([{ $match: { organizationId, batchJobId: job._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]);
  const counts = Object.fromEntries(grouped.map(item => [item._id, item.count]));
  const rowHashes: any[] = await BatchRecord.find({ organizationId, batchJobId: job._id }).sort({ rowNumber: 1 }).select('contentHash status').lean();
  const preview = { total: Number(job.stats?.total || 0), valid: Number(counts.pending || 0), duplicate: Number(counts.duplicate || 0), invalid: Number(counts.invalid || 0), provider: job.provider, connectionId: String(job.connectionId || ''), operation: job.operation, options: job.options, rowsHash: crypto.createHash('sha256').update(rowHashes.map(row => `${row.contentHash}:${row.status}`).join('|')).digest('hex') };
  const hash = crypto.createHash('sha256').update(canonicalJson(preview)).digest('hex');
  job.stats = { ...job.stats, ...preview, pending: preview.valid }; job.previewHash = hash; job.dryRunCompletedAt = new Date(); job.status = 'preview_ready'; await job.save();
  return { job, preview, previewHash: hash, warnings: preview.invalid || preview.duplicate ? ['Invalid and duplicate rows will be skipped'] : [] };
}

export async function approveBatch(input: { organizationId: string; batchJobId: string; previewHash: string; userId?: string }) {
  const job: any = await BatchJob.findOne({ _id: input.batchJobId, organizationId: input.organizationId }); if (!job) throw new Error('Batch job not found');
  if (job.status !== 'preview_ready' || !job.dryRunCompletedAt) throw new Error('A completed dry-run preview is required before approval');
  if (!input.previewHash || input.previewHash !== job.previewHash) throw new Error('Preview changed or previewHash is invalid');
  job.status = 'approved'; job.approvedAt = new Date(); job.approvedBy = input.userId; await job.save(); return job;
}
export async function enqueueBatch(organizationId: string, batchJobId: string) {
  const job: any = await BatchJob.findOne({ _id: batchJobId, organizationId }); if (!job) throw new Error('Batch job not found');
  if (!['approved', 'paused'].includes(job.status)) throw new Error('Batch must be approved or paused before it can start');
  await assertUsageAvailable(organizationId, 'contact_processed'); job.status = 'queued'; job.error = undefined; await job.save();
  await batchQueue.add('process', { organizationId, batchJobId, correlationId: job.correlationId }, { jobId: batchQueueJobId(batchJobId, Date.now()), attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 }); return job;
}

export async function processBatchChunk(organizationId: string, batchJobId: string) {
  const job: any = await BatchJob.findOne({ _id: batchJobId, organizationId }); if (!job) throw new Error('Batch job not found');
  if (job.status === 'paused' || job.status === 'cancelled') return job;
  if (job.status === 'cancel_requested') { job.status = 'cancelled'; job.finishedAt = new Date(); await job.save(); return job; }
  if (!['queued', 'running'].includes(job.status)) throw new Error(`Batch cannot process from status ${job.status}`);
  job.status = 'running'; job.startedAt ||= new Date(); await job.save();
  await BatchRecord.updateMany({ organizationId, batchJobId: job._id, status: 'processing', leaseStage: 'before_remote', leaseExpiresAt: { $lt: new Date() } }, { $set: { status: 'pending' }, $unset: { leaseExpiresAt: 1, leaseStage: 1 } });
  await BatchRecord.updateMany({ organizationId, batchJobId: job._id, status: 'processing', leaseStage: 'remote_started', leaseExpiresAt: { $lt: new Date() } }, { $set: { status: 'outcome_unknown', error: { code: 'REMOTE_OUTCOME_UNKNOWN', message: 'Worker stopped after remote write began; manual reconciliation required' } }, $unset: { leaseExpiresAt: 1 } });
  const records: any[] = await BatchRecord.find({ organizationId, batchJobId: job._id, status: 'pending' }).sort({ rowNumber: 1 }).limit(Number(job.chunkSize || 100)).select('+normalizedCiphertext +beforeStateCiphertext');
  if (!records.length) {
    if (await BatchRecord.exists({ organizationId, batchJobId: job._id, status: 'processing' })) return job;
    job.status = Number(job.stats?.failed || 0) > 0 ? 'completed_with_errors' : 'completed'; job.finishedAt = new Date(); await updateRollbackCapability(job, organizationId); await job.save(); return job;
  }
  const connector = job.operation === 'local.deduplicate' ? null : await createConnector({ organizationId, provider: job.provider, connectionId: job.connectionId ? String(job.connectionId) : undefined });
  let entitlementBlocked = false;
  for (const record of records) {
    const current: any = await BatchJob.findOne({ _id: job._id, organizationId }).select('status'); if (current?.status === 'paused') return current;
    if (current?.status === 'cancel_requested') { current.status = 'cancelled'; current.finishedAt = new Date(); await current.save(); return current; }
    const claimed: any = await BatchRecord.findOneAndUpdate({ _id: record._id, organizationId, status: 'pending' }, { $set: { status: 'processing', startedAt: new Date(), leaseStage: 'before_remote', leaseExpiresAt: new Date(Date.now() + 120_000) }, $inc: { attempts: 1 } }, { new: true }).select('+normalizedCiphertext +beforeStateCiphertext');
    if (!claimed) continue;
    try {
      await reserveMeteredUsage({
        organizationId,
        metric: 'contact_processed',
        quantity: 1,
        idempotencyKey: `batch-record:${batchJobId}:${String(claimed._id)}`,
        source: 'batchService',
        metadata: { batchJobId, rowNumber: claimed.rowNumber, provider: job.provider },
      });
      const normalized = decryptJson<any>(claimed.normalizedCiphertext, recordAad(organizationId, batchJobId, claimed.rowNumber, 'normalized'));
      const outbound = connectorInput(String(job.operation), normalized); const externalId = String(outbound?.id || '');
      if (externalId && connector && ['hubspot', 'klaviyo'].includes(String(job.provider))) {
        try {
          const before = restorableBeforeState(String(job.provider), await connector.getContact(externalId), outbound);
          if (before) claimed.beforeStateCiphertext = encryptJson(before, recordAad(organizationId, batchJobId, claimed.rowNumber, 'before'));
        } catch (error: any) { if (Number(error?.response?.status) !== 404) throw error; }
      }
      claimed.leaseStage = 'remote_started'; claimed.leaseExpiresAt = new Date(Date.now() + 120_000); await claimed.save();
      claimed.result = job.operation === 'local.deduplicate' ? { deduplicated: true } : redact(await connector!.execute(String(job.operation), outbound)); claimed.status = 'succeeded'; claimed.finishedAt = new Date(); claimed.leaseExpiresAt = undefined; await claimed.save();
    } catch (error: any) {
      claimed.error = redactedError(error); claimed.finishedAt = new Date(); claimed.leaseExpiresAt = undefined;
      if (isUsageGateError(error)) {
        claimed.status = 'pending'; claimed.leaseStage = undefined; claimed.startedAt = undefined; await claimed.save();
        job.status = 'paused'; job.error = redactedError(error); entitlementBlocked = true; break;
      }
      claimed.status = claimed.leaseStage === 'remote_started' && !error?.response ? 'outcome_unknown' : 'failed'; await claimed.save();
    }
  }
  const grouped: any[] = await BatchRecord.aggregate([{ $match: { organizationId, batchJobId: job._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]); const counts = Object.fromEntries(grouped.map(item => [item._id, item.count]));
  job.stats = { ...job.stats, pending: Number(counts.pending || 0), processing: Number(counts.processing || 0), succeeded: Number(counts.succeeded || 0), failed: Number(counts.failed || 0) + Number(counts.outcome_unknown || 0), skipped: Number(counts.skipped || 0), duplicate: Number(counts.duplicate || 0), invalid: Number(counts.invalid || 0) };
  job.checkpoint = { lastProcessedRow: records.at(-1)?.rowNumber || job.checkpoint?.lastProcessedRow || 0, updatedAt: new Date() };
  if (entitlementBlocked) { await job.save(); return job; }
  if (job.stats.pending > 0 || job.stats.processing > 0) {
    await job.save();
    if (job.stats.pending > 0) await batchQueue.add('process', { organizationId, batchJobId, correlationId: job.correlationId }, { jobId: batchQueueJobId(batchJobId, job.checkpoint.lastProcessedRow), attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 });
  }
  else { job.status = job.stats.failed > 0 ? 'completed_with_errors' : 'completed'; job.finishedAt = new Date(); await updateRollbackCapability(job, organizationId); await job.save(); }
  return job;
}

export async function retryFailedRecords(organizationId: string, batchJobId: string) {
  const job: any = await BatchJob.findOne({ _id: batchJobId, organizationId }); if (!job) throw new Error('Batch job not found');
  if (!['completed_with_errors', 'failed', 'paused'].includes(job.status)) throw new Error('Only failed or paused batches can retry records');
  await BatchRecord.updateMany({ organizationId, batchJobId: job._id, status: 'failed', attempts: { $lt: 5 } }, { $set: { status: 'pending', error: null, finishedAt: null } }); job.status = 'approved'; await job.save(); return enqueueBatch(organizationId, batchJobId);
}

export async function reconcileBatchJobs(limit = 100) {
  const stale = new Date(Date.now() - 120_000);
  // tenant-safe: cross-tenant lease-recovery sweep; each job carries its own organisation
  const jobs: any[] = await BatchJob.find({
    status: { $in: ['queued', 'running', 'cancel_requested'] },
    $or: [{ status: 'cancel_requested' }, { updatedAt: { $lte: stale } }],
  }).sort({ updatedAt: 1 }).limit(Math.min(500, Math.max(1, limit))).select('_id organizationId correlationId').lean();
  const bucket = Math.floor(Date.now() / 60_000);
  for (const job of jobs) {
    await batchQueue.add('reconcile', { organizationId: String(job.organizationId), batchJobId: String(job._id), correlationId: job.correlationId }, {
      jobId: batchQueueJobId(String(job._id), `reconcile-${bucket}`), attempts: 1, removeOnComplete: 500, removeOnFail: 1_000,
    });
  }
  return jobs.length;
}
export async function readBatchRecordInput(record: any, field: 'input' | 'normalized' | 'before') {
  const ciphertext = field === 'input' ? record.inputCiphertext : field === 'normalized' ? record.normalizedCiphertext : record.beforeStateCiphertext; if (!ciphertext) return null;
  return decryptJson(ciphertext, recordAad(String(record.organizationId), String(record.batchJobId), Number(record.rowNumber), field));
}
