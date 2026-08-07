import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Router } from 'express';
import { Types } from 'mongoose';
import WorkflowSnapshot from '../models/WorkflowSnapshot';
import PlatformConnection from '../models/PlatformConnection';
import Artifact from '../models/Artifact';
import { monitoringQueue } from '../queue';
import { readSnapshotCanonical, snapshotDiff, workflowInventoryCapability } from '../services/monitoringService';
import { openArtifact, safeDownloadFileName, storeArtifactFromBuffer } from '../services/artifactStore';
import { recordAudit } from '../services/audit';
import { asyncHandler, HttpError, problemType} from '../http/problem';
import { requireOrganizationId, requestCorrelationId } from '../types/authenticatedRequest';
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor';

const router = Router();
function objectId(value: unknown, label: string) { const id = String(value || ''); if (!Types.ObjectId.isValid(id)) throw new HttpError(400, `Invalid ${label}`, `${label} identifier is invalid`); return id; }
function requireOperator(req: any) { if (!['owner', 'admin', 'operator'].includes(String(req.auth?.role || ''))) throw new HttpError(403, 'Insufficient role', 'Owner, admin, or operator role is required'); }

router.get('/snapshots', asyncHandler(async (req, res) => {
  const query: any = { organizationId: requireOrganizationId(req) };
  if (req.query.connectionId) query.connectionId = objectId(req.query.connectionId, 'connection');
  if (req.query.externalWorkflowId) query.externalWorkflowId = String(req.query.externalWorkflowId).slice(0, 240);
  const limit = pageLimit(req.query.limit); const cursor = decodeCursor(req.query.cursor); if (cursor) query._id = { $lt: cursor };
  const rows: any[] = await WorkflowSnapshot.find(query).sort({ _id: -1 }).limit(limit + 1).lean(); const hasMore = rows.length > limit;
  res.json({ snapshots: rows.slice(0, limit).map(row => ({ ...row, id: String(row._id), platform: row.provider, resourceName: row.name, createdAt: row.capturedAt })), nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null });
}));

router.post('/snapshots', asyncHandler(async (req, res) => {
  requireOperator(req); const organizationId = requireOrganizationId(req); const connectionId = objectId(req.body?.connectionId, 'connection');
  const connection: any = await PlatformConnection.findOne({ _id: connectionId, organizationId, status: { $in: ['active', 'degraded', 'error'] } }).select('provider scopes').lean();
  if (!connection) throw new HttpError(404, 'Connection not found', 'A monitorable connection was not found in this organization');
  const capability = await workflowInventoryCapability(organizationId, connectionId);
  if (!capability.enabled) {
    throw new HttpError(
      409,
      capability.state === 'unverified' ? 'Snapshot capability unverified' : 'Snapshot capability unavailable',
      `${capability.reason}${capability.remediation ? ` ${capability.remediation}` : ''}`,
      problemType(capability.state === 'unverified' ? 'capability-unverified' : 'capability-unavailable'),
    );
  }
  const correlationId = requestCorrelationId(req) || crypto.randomUUID();
  await monitoringQueue.add('vault-snapshot', { organizationId, provider: connection.provider, connectionId, correlationId }, { attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 });
  await recordAudit({ req, organizationId, action: 'vault.snapshot_requested', entityType: 'PlatformConnection', entityId: connectionId });
  res.status(202).json({ queued: true, connectionId, correlationId, capability });
}));

router.get('/diff', asyncHandler(async (req, res) => {
  if (!req.query.before || !req.query.after) throw new HttpError(422, 'Snapshots required', 'before and after snapshot ids are required');
  res.json(await snapshotDiff(requireOrganizationId(req), objectId(req.query.before, 'snapshot'), objectId(req.query.after, 'snapshot')));
}));

async function exportSnapshot(req: any, res: any) {
  const organizationId = requireOrganizationId(req); const snapshotId = objectId(req.params.id, 'snapshot');
  const { row, canonical } = await readSnapshotCanonical(organizationId, snapshotId);
  let artifact: any = await Artifact.findOne({ organizationId, kind: 'vault_export', status: 'ready', 'metadata.snapshotId': snapshotId }).sort({ createdAt: -1 });
  if (!artifact) {
    artifact = await storeArtifactFromBuffer({
      organizationId, kind: 'vault_export', fileName: `${String(row.name || row.externalWorkflowId || 'workflow').slice(0, 100)}-${row.hash.slice(0, 12)}.json`, contentType: 'application/json; charset=utf-8', createdBy: req.auth?.userId,
      metadata: { snapshotId, connectionId: String(row.connectionId), provider: row.provider, hash: row.hash },
      body: Buffer.from(JSON.stringify({ schemaVersion: 1, snapshot: { id: snapshotId, provider: row.provider, connectionId: row.connectionId, externalWorkflowId: row.externalWorkflowId, name: row.name, status: row.status, hash: row.hash, capturedAt: row.capturedAt }, definition: canonical }, null, 2)),
    });
  }
  const opened = await openArtifact(organizationId, String(artifact._id)); const fileName = safeDownloadFileName(opened.artifact.fileName);
  res.setHeader('Content-Type', opened.artifact.contentType); res.setHeader('Content-Length', String(opened.artifact.plaintextSize)); res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '_')}"`); res.setHeader('Cache-Control', 'private, no-store');
  await recordAudit({ req, organizationId, action: 'vault.snapshot_exported', entityType: 'WorkflowSnapshot', entityId: snapshotId, metadata: { artifactId: String(artifact._id) } });
  await pipeline(opened.stream, res);
}

router.get('/snapshots/:id/export', asyncHandler(exportSnapshot));
router.get('/export/:id', asyncHandler(exportSnapshot));
export default router;
