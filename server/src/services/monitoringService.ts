import crypto from 'crypto';
import { Types } from 'mongoose';
import PlatformConnection from '../models/PlatformConnection';
import WorkflowSnapshot from '../models/WorkflowSnapshot';
import MonitoringRun from '../models/MonitoringRun';
import Incident from '../models/Incident';
import NotificationChannel from '../models/NotificationChannel';
import Alert from '../models/Alert';
import { createConnector, ConnectorProvider } from './connectors';
import { canonicalJson } from './canonicalJson';
import { decryptJson, encryptJson } from '../security/encryption';
import { redactedError } from './redaction';
import { reconcileNotificationAlerts } from './notifications';
import { monitoringQueue } from '../queue';
import { env } from '../env';
import { connectionCapability } from './capability/capabilityService';
import { connectionWatchDecision } from './watchMode';

const snapshotAad = (organizationId: string, id: string) => `workflow-snapshot:${organizationId}:${id}`;
/**
 * Workflow inventory availability, resolved from recorded evidence.
 *
 * Previously this inspected a scope array that could have been populated from
 * the scopes we requested rather than the scopes we were granted, which meant
 * an unverified [V3] entitlement could gate a feature to `enabled: true`. It
 * now delegates to the capability service, which will only answer `available`
 * on a provider-returned scope grant or a recorded live probe.
 */
export async function workflowInventoryCapability(organizationId: string, connectionId: string) {
  const resolution = await connectionCapability(organizationId, connectionId, 'workflow.inventory');
  return {
    enabled: resolution.state === 'available',
    state: resolution.state,
    reason: resolution.reason,
    remediation: resolution.remediation,
    evidence: resolution.evidence,
  };
}
function canonicalWorkflow(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalWorkflow);
  if (!value || typeof value !== 'object') return value;
  const volatile = new Set(['createdAt', 'updatedAt', 'lastUpdated', 'statistics', 'metrics']);
  return Object.fromEntries(Object.keys(value).filter(key => !volatile.has(key)).sort().map(key => [key, canonicalWorkflow(value[key]) ]));
}
export function diffValues(before: any, after: any, path = ''): any[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after)) return [{ path: path || '$', before, after }];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]); return Array.from(keys).flatMap(key => diffValues(before[key], after[key], path ? `${path}.${key}` : key)).slice(0, 1_000);
}
async function openIncident(input: { organizationId: string; provider: string; connectionId?: string; type: string; severity: string; title: string; description?: string; evidence?: any; fingerprint: string }) {
  const existing: any = await Incident.findOne({ organizationId: input.organizationId, fingerprint: input.fingerprint, status: { $in: ['open', 'acknowledged'] } });
  if (existing) { existing.lastSeenAt = new Date(); existing.evidence = input.evidence; await existing.save(); return existing; }
  const incident: any = await Incident.create(input);
  const event = input.type === 'workflow_changed' ? 'workflow.changed' : input.type === 'connection_failure' ? 'connection.failed' : 'incident.created';
  const rank: Record<string, number> = { info: 0, warning: 1, critical: 2 };
  const channels: any[] = await NotificationChannel.find({ organizationId: input.organizationId, enabled: true, status: 'verified', events: { $in: [event, 'incident.created'] } });
  for (const channel of channels) {
    if ((rank[input.severity] ?? 1) < (rank[channel.minimumSeverity] ?? 1)) continue;
    const dedupeKey = `${incident._id}:${channel._id}`; try { await Alert.create({ organizationId: input.organizationId, incidentId: incident._id, channelId: channel._id, status: 'queued', dedupeKey }); } catch { /* unique suppression */ }
  }
  await reconcileNotificationAlerts().catch(() => undefined);
  return incident;
}
export async function runConnectionMonitor(input: { organizationId: string; provider: ConnectorProvider; connectionId: string; correlationId: string }) {
  const run: any = await MonitoringRun.create({ organizationId: input.organizationId, provider: input.provider, connectionId: input.connectionId, correlationId: input.correlationId, status: 'running' });
  try {
    const connection: any = await PlatformConnection.findOne({ _id: input.connectionId, organizationId: input.organizationId, provider: input.provider }).select('scopes grantedScopes scopeSource').lean();
    if (!connection) throw new Error('Connection not found');
    const connector = await createConnector(input); const health = await connector.health();
    const watch = await connectionWatchDecision(input.organizationId, input.connectionId);
    const capability = watch.workflowMonitoringEnabled
      ? await workflowInventoryCapability(input.organizationId, input.connectionId)
      : { enabled: false, state: 'unverified' as const, reason: watch.reason, remediation: undefined as string | undefined, evidence: {} as Record<string, unknown> };
    // An unverified capability is an operator-visible condition, not an empty
    // result. Silently returning zero workflows is what allowed monitoring to
    // report success while observing nothing.
    if (capability.state === 'unverified' && watch.mode === 'full') {
      await openIncident({
        organizationId: input.organizationId, provider: input.provider, connectionId: input.connectionId,
        type: 'capability_unverified', severity: 'warning',
        title: `${input.provider} workflow monitoring is not yet verified`,
        description: `${capability.reason} ${capability.remediation || ''}`.trim(),
        evidence: { capability: 'workflow.inventory', ...capability.evidence },
        fingerprint: crypto.createHash('sha256').update(`${input.connectionId}:capability_unverified:workflow.inventory`).digest('hex'),
      });
    } else if (capability.state === 'available') {
      await Incident.updateMany({ organizationId: input.organizationId, connectionId: input.connectionId, type: 'capability_unverified', status: { $in: ['open', 'acknowledged'] } }, { $set: { status: 'resolved', resolvedAt: new Date(), lastSeenAt: new Date() } });
    }
    const workflows = capability.enabled ? await connector.listWorkflows() : []; let added = 0; let changed = 0;
    for (const workflow of workflows) {
      const canonical = canonicalWorkflow(workflow.raw); const hash = crypto.createHash('sha256').update(canonicalJson(canonical)).digest('hex');
      const latest: any = await WorkflowSnapshot.findOne({ organizationId: input.organizationId, provider: input.provider, connectionId: input.connectionId, externalWorkflowId: workflow.id }).sort({ capturedAt: -1 }).select('+canonicalCiphertext');
      if (latest?.hash === hash) continue;
      const id = new Types.ObjectId();
      await WorkflowSnapshot.create({ _id: id, organizationId: input.organizationId, provider: input.provider, connectionId: input.connectionId, externalWorkflowId: workflow.id, name: workflow.name, status: workflow.status, hash, canonicalCiphertext: encryptJson(canonical, snapshotAad(input.organizationId, String(id))), capturedAt: new Date(), sourceUpdatedAt: workflow.updatedAt ? new Date(workflow.updatedAt) : undefined });
      if (!latest) added += 1; else {
        changed += 1; await openIncident({ organizationId: input.organizationId, provider: input.provider, connectionId: input.connectionId, type: 'workflow_changed', severity: 'warning', title: `${workflow.name} changed`, evidence: { externalWorkflowId: workflow.id, previousHash: latest.hash, currentHash: hash }, fingerprint: crypto.createHash('sha256').update(`${input.connectionId}:${workflow.id}:changed`).digest('hex') });
      }
    }
    await PlatformConnection.updateOne({ _id: input.connectionId, organizationId: input.organizationId, provider: input.provider }, {
      $set: { status: health.ok ? 'active' : 'degraded', ...(health.ok ? { lastHealthyAt: new Date() } : { lastError: 'Provider health check returned an unhealthy result' }) },
      ...(health.ok ? { $unset: { lastError: 1 } } : {}),
    });
    if (health.ok) await Incident.updateMany({ organizationId: input.organizationId, connectionId: input.connectionId, type: 'connection_failure', status: { $in: ['open', 'acknowledged'] } }, { $set: { status: 'resolved', resolvedAt: new Date(), lastSeenAt: new Date() } });
    run.status = 'completed'; run.finishedAt = new Date(); run.summary = { healthy: health.ok, workflows: workflows.length, added, changed, snapshotCapability: capability }; await run.save(); return run;
  } catch (error: any) {
    run.status = 'failed'; run.finishedAt = new Date(); run.error = redactedError(error); await run.save();
    await PlatformConnection.updateOne({ _id: input.connectionId, organizationId: input.organizationId, provider: input.provider }, { $set: { status: 'degraded', lastError: 'Scheduled provider health check failed' } });
    await openIncident({ organizationId: input.organizationId, provider: input.provider, connectionId: input.connectionId, type: 'connection_failure', severity: 'critical', title: `${input.provider} connection failed`, description: 'LogicFlower could not complete the scheduled provider health check. Reauthorize or retry the connection check.', evidence: redactedError(error), fingerprint: crypto.createHash('sha256').update(`${input.connectionId}:connection_failure`).digest('hex') }); throw error;
  }
}
export async function snapshotDiff(organizationId: string, beforeId: string, afterId: string) {
  const [before, after]: any[] = await Promise.all([WorkflowSnapshot.findOne({ _id: beforeId, organizationId }).select('+canonicalCiphertext'), WorkflowSnapshot.findOne({ _id: afterId, organizationId }).select('+canonicalCiphertext')]);
  if (!before || !after) throw new Error('Snapshot not found'); if (String(before.externalWorkflowId) !== String(after.externalWorkflowId)) throw new Error('Snapshots belong to different workflows');
  const beforeValue = decryptJson(before.canonicalCiphertext, snapshotAad(organizationId, String(before._id))); const afterValue = decryptJson(after.canonicalCiphertext, snapshotAad(organizationId, String(after._id)));
  return { before: { id: before._id, hash: before.hash, capturedAt: before.capturedAt }, after: { id: after._id, hash: after.hash, capturedAt: after.capturedAt }, changes: diffValues(beforeValue, afterValue) };
}
export async function readSnapshotCanonical(organizationId: string, snapshotId: string) {
  const row: any = await WorkflowSnapshot.findOne({ _id: snapshotId, organizationId }).select('+canonicalCiphertext');
  if (!row) throw Object.assign(new Error('Snapshot not found'), { statusCode: 404 });
  return { row, canonical: decryptJson(row.canonicalCiphertext, snapshotAad(organizationId, String(row._id))) };
}
// tenant-safe: cross-tenant monitoring scheduler; each connection carries its own organisation
export async function listMonitorableConnections(organizationId: string) { return PlatformConnection.find({ organizationId, status: { $in: ['active', 'degraded', 'error'] } }).select('_id provider name status scopes lastHealthyAt lastError').lean(); }

export async function reconcileConnectionMonitors(limit = 500) {
  const intervalMs = env.MONITOR_INTERVAL_MS;
  const cutoff = new Date(Date.now() - intervalMs);
  // tenant-safe: cross-tenant monitoring scheduler; each connection carries its own organisation
  const connections: any[] = await PlatformConnection.find({
    provider: { $in: ['ghl', 'hubspot', 'klaviyo', 'activecampaign', 'google'] },
    status: { $in: ['active', 'degraded', 'error'] },
  }).sort({ _id: 1 }).limit(Math.min(1_000, Math.max(1, limit))).select('_id organizationId provider').lean();
  if (!connections.length) return { eligible: 0, queued: 0 };

  // tenant-safe: cross-tenant monitoring scheduler
  const recent: any[] = await MonitoringRun.find({
    connectionId: { $in: connections.map(connection => connection._id) },
    startedAt: { $gte: cutoff },
    status: { $in: ['running', 'completed'] },
  }).select('organizationId connectionId').lean();
  const monitored = new Set(recent.map(row => `${row.organizationId}:${row.connectionId}`));
  const bucket = Math.floor(Date.now() / intervalMs);
  let queued = 0;
  for (const connection of connections) {
    const organizationId = String(connection.organizationId);
    const connectionId = String(connection._id);
    if (monitored.has(`${organizationId}:${connectionId}`)) continue;
    await monitoringQueue.add('connection', {
      organizationId,
      connectionId,
      provider: connection.provider,
      correlationId: crypto.randomUUID(),
    }, {
      jobId: `monitor-${connectionId}-${bucket}`,
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 1_000,
    });
    queued += 1;
  }
  return { eligible: connections.length, queued };
}
