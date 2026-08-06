import { Queue } from 'bullmq';
import { env } from '../env';

export const workflowQueue = new Queue('workflow-run', {
  connection: { url: env.REDIS_URL }
});


export const batchQueue = new Queue('batch-run', { connection: { url: env.REDIS_URL } });
export const monitoringQueue = new Queue('monitoring-run', { connection: { url: env.REDIS_URL } });
export const notificationQueue = new Queue('notification-run', { connection: { url: env.REDIS_URL } });
export const connectionScanQueue = new Queue('connection-scan', { connection: { url: env.REDIS_URL } });
export const dataLifecycleQueue = new Queue('data-lifecycle', { connection: { url: env.REDIS_URL } });

export async function closeQueues(): Promise<void> {
  await Promise.all([workflowQueue, batchQueue, monitoringQueue, notificationQueue, connectionScanQueue, dataLifecycleQueue].map(queue => queue.close()))
}
