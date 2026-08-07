import { Worker } from 'bullmq';
import mongoose from 'mongoose';
import { env } from '../env';
import { connectDB } from '../db';
import runWorkflow from '../services/workflowEngine';
import { processBatchChunk, reconcileBatchJobs } from '../services/batchService';
import { reconcileConnectionMonitors, runConnectionMonitor } from '../services/monitoringService';
import { reconcileNotificationAlerts, sendConfiguredNotification } from '../services/notifications';
import Workflow from '../models/Workflow';
import BatchJob from '../models/BatchJob';
import PlatformConnection from '../models/PlatformConnection';
import Alert from '../models/Alert';
import Incident from '../models/Incident';
import FailedJob from '../models/FailedJob';
import WebhookEvent from '../models/WebhookEvent';
import WebhookDelivery from '../models/WebhookDelivery';
import { decryptJson } from '../security/encryption';
import { reconcileWebhookDeliveries } from '../routes/webhooks';
import pino from '../logger';
import { isRetryableHttpError } from '../services/retry';
import { processConnectionDeletionTasks } from '../services/connectionLifecycle';
import { registerConnectorRevokers } from '../services/oauthProviders';
import { closeQueues } from './index';
import { reconcileConnectionScans, runConnectionScan } from '../services/connectionScan';
import { runRetentionMaintenance } from '../services/retention';
import { enqueueDataLifecycleRequest, processDataLifecycleRequest, reconcileDataLifecycleRequests } from '../services/dataLifecycle';
import { runSchedulerTick } from '../services/sequences/scheduler';
import { reconcileSocialPosts } from '../services/social/trypostPublisher';
import { runDialerTick } from '../services/voice/dialer';
import { trypostConfigured } from '../services/social/trypostClient';

const connection = { url: env.REDIS_URL };
const maintenanceTimers = new Set<NodeJS.Timeout>();
let maintenanceStopping = false;

function recurringMaintenance(name: string, intervalMs: number, task: () => Promise<unknown>) {
  let active = false;
  const run = async () => {
    if (active || maintenanceStopping) return;
    active = true;
    try { await task(); } catch (error) { pino.error({ err: error, maintenance: name }, 'worker maintenance failed'); } finally { active = false; }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs); timer.unref(); maintenanceTimers.add(timer);
}

export function stopWorkerMaintenance() {
  maintenanceStopping = true;
  for (const timer of maintenanceTimers) clearInterval(timer);
  maintenanceTimers.clear();
}

export async function startWorkers() {
  await connectDB();
  registerConnectorRevokers();
  const workflowWorker = new Worker('workflow-run', async job => {
    const { organizationId, workflowId, payload, webhookEventId, webhookDeliveryId, execId, startNodeId, triggerKind, correlationId, allowDraft, resume } = job.data || {};
    if (!organizationId || !workflowId) throw new Error('Invalid workflow job: organizationId and workflowId are required');
    if (!await Workflow.exists({ _id: workflowId, organizationId })) throw new Error('Workflow does not belong to job organization');
    let actualPayload = triggerKind === 'trigger.schedule' ? { scheduledAt: new Date().toISOString() } : payload;
    if (webhookEventId) { const event: any = await WebhookEvent.findOne({ _id: webhookEventId, organizationId }).select('+payloadCiphertext'); if (!event) throw new Error('Webhook event not found'); actualPayload = decryptJson(event.payloadCiphertext, `webhook-event:${organizationId}:${event._id}`); }
    try {
      const result = await runWorkflow(String(workflowId), actualPayload, { organizationId: String(organizationId), execId: execId ? String(execId) : undefined, startNodeId, triggerKind, correlationId, allowDraft: Boolean(allowDraft), resume: Boolean(resume) });
      // tenant-safe: worker acts on a delivery id it dequeued from its own durable job record
      if (webhookDeliveryId) { await WebhookDelivery.updateOne({ _id: webhookDeliveryId, organizationId }, { $set: { status: 'processed' } }); const delivery: any = await WebhookDelivery.findById(webhookDeliveryId); const pending = await WebhookDelivery.countDocuments({ webhookEventId: delivery?.webhookEventId, status: { $ne: 'processed' } }); if (!pending && delivery) await WebhookEvent.updateOne({ _id: delivery.webhookEventId, organizationId }, { $set: { status: 'processed' } }); }
      return result;
    } catch (error: any) { if (webhookDeliveryId) await WebhookDelivery.updateOne({ _id: webhookDeliveryId, organizationId }, { $set: { status: 'failed', lastError: String(error.message).slice(0, 1_000) } }); throw error; }
  }, { connection, concurrency: env.WORKFLOW_CONCURRENCY });

  const batchWorker = new Worker('batch-run', async job => {
    const { organizationId, batchJobId } = job.data || {}; if (!organizationId || !batchJobId) throw new Error('Invalid batch job');
    if (!await BatchJob.exists({ _id: batchJobId, organizationId })) throw new Error('Batch does not belong to job organization');
    return processBatchChunk(String(organizationId), String(batchJobId));
  }, { connection, concurrency: env.BATCH_CONCURRENCY });

  const monitoringWorker = new Worker('monitoring-run', async job => {
    const { organizationId, provider, connectionId, correlationId } = job.data || {}; if (!organizationId || !provider || !connectionId) throw new Error('Invalid monitoring job');
    if (!await PlatformConnection.exists({ _id: connectionId, organizationId, provider })) throw new Error('Connection does not belong to job organization');
    return runConnectionMonitor({ organizationId: String(organizationId), provider, connectionId: String(connectionId), correlationId: String(correlationId || job.id) });
  }, { connection, concurrency: env.MONITORING_CONCURRENCY });

  const notificationWorker = new Worker('notification-run', async job => {
    const { organizationId, alertId } = job.data || {}; const alert: any = await Alert.findOneAndUpdate({ _id: alertId, organizationId, status: 'queued' }, { $set: { status: 'sending', lastAttemptAt: new Date() }, $inc: { attemptCount: 1 } }, { new: true });
    if (!alert) { if (await Alert.exists({ _id: alertId, organizationId, status: 'sent' })) return { alreadySent: true }; throw new Error('Alert is unavailable or has an uncertain prior outcome'); }
    const incident: any = await Incident.findOne({ _id: alert.incidentId, organizationId }); if (!incident) throw new Error('Incident not found');
    try { alert.response = await sendConfiguredNotification({ organizationId, channelId: String(alert.channelId), subject: incident.title, message: incident.description || JSON.stringify(incident.evidence || {}), correlationId: String(job.id) }); alert.status = 'sent'; alert.sentAt = new Date(); alert.nextAttemptAt = undefined; await alert.save(); }
    catch (error: any) {
      alert.error = { code: 'NOTIFICATION_DELIVERY_FAILED', message: 'Notification delivery failed' };
      if (Number(alert.attemptCount || 0) < 5) {
        alert.status = 'queued'; alert.nextAttemptAt = new Date(Date.now() + Math.min(15 * 60_000, 15_000 * 2 ** Math.max(0, Number(alert.attemptCount || 1) - 1))); await alert.save();
        return { retryScheduled: true, attemptCount: alert.attemptCount };
      }
      alert.status = 'failed'; await alert.save(); throw error;
    }
  }, { connection, concurrency: env.NOTIFICATION_CONCURRENCY });

  const connectionScanWorker = new Worker('connection-scan', async job => {
    const { organizationId, connectionId, provider, scanId } = job.data || {};
    if (!organizationId || !connectionId || !provider || !scanId) throw new Error('Invalid connection scan job');
    return runConnectionScan({ organizationId: String(organizationId), connectionId: String(connectionId), provider, scanId: String(scanId) });
  }, { connection, concurrency: Math.max(1, Math.min(4, env.MONITORING_CONCURRENCY)) });

  const dataLifecycleWorker = new Worker('data-lifecycle', async job => {
    const requestId = String(job.data?.requestId || '');
    if (!requestId) throw new Error('Invalid data lifecycle job');
    const result = await processDataLifecycleRequest(requestId);
    if (result.deferred) await enqueueDataLifecycleRequest(requestId, 60_000);
    return result;
  }, { connection, concurrency: 1 });

  const workers = [workflowWorker, batchWorker, monitoringWorker, notificationWorker, connectionScanWorker, dataLifecycleWorker];
  recurringMaintenance('webhook-outbox', 30_000, () => reconcileWebhookDeliveries());
  recurringMaintenance('batch-recovery', 60_000, () => reconcileBatchJobs());
  recurringMaintenance('notification-outbox', 30_000, () => reconcileNotificationAlerts());
  recurringMaintenance('connection-deletion', 30_000, () => processConnectionDeletionTasks());
  recurringMaintenance('connection-monitoring', 60_000, () => reconcileConnectionMonitors());
  recurringMaintenance('connection-scans', 60_000, () => reconcileConnectionScans());
  recurringMaintenance('retention', 6 * 60 * 60_000, () => runRetentionMaintenance());
  recurringMaintenance('data-lifecycle', 60_000, () => reconcileDataLifecycleRequests());
  // The sequence scheduler. Registered as recurring maintenance rather than as
  // a BullMQ worker on purpose: its work queue is a MongoDB query over dueAt,
  // so losing Redis loses nothing. Gated behind an explicit flag because
  // enabling it starts sending messages to real recipients.
  // The publishing backend exposes no outbound webhook, so publish status is
  // pulled. This is the only mechanism by which a post leaves `publishing`.
  if (trypostConfigured()) {
    recurringMaintenance('social-reconcile', env.TRYPOST_POLL_INTERVAL_MS, () => reconcileSocialPosts());
  }
  if (env.DIALER_ENABLED) {
    recurringMaintenance('voice-dialer', env.DIALER_INTERVAL_MS, () => runDialerTick());
    if (env.DIALER_DRY_RUN) pino.info('voice dialer running in DRY RUN: gates are evaluated and recorded, no call is placed');
  }
  if (env.SEQUENCE_ENGINE_ENABLED) {
    recurringMaintenance('sequence-scheduler', env.SEQUENCE_SCHEDULER_INTERVAL_MS, () => runSchedulerTick());
  } else {
    pino.info('sequence scheduler disabled; set SEQUENCE_ENGINE_ENABLED=true to start processing due steps');
  }
  for (const worker of workers) worker.on('failed', async (job, error) => {
    const organizationId = String(job?.data?.organizationId || ''); pino.error({ err: error, queue: worker.name, jobId: job?.id, organizationId }, 'background job failed');
    if (organizationId) await FailedJob.create({ organizationId, jobId: String(job?.id || ''), workflowId: job?.data?.workflowId, reason: error.message, payload: { queue: worker.name }, correlationId: job?.data?.correlationId, retryable: isRetryableHttpError(error) }).catch(() => undefined);
  });
  return workers;
}

async function main() {
  const { bootstrapRuntime } = await import('../bootstrapRuntime')
  await bootstrapRuntime()

  const workers = await startWorkers();
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; shuttingDown = true; pino.info({ signal }, 'worker shutdown'); stopWorkerMaintenance();
    await Promise.all(workers.map(worker => worker.close())); await closeQueues(); await mongoose.disconnect(); process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM')); process.once('SIGINT', () => void shutdown('SIGINT'));
}
if (require.main === module) main().catch(error => { pino.fatal({ err: error }, 'worker startup failed'); process.exit(1); });
