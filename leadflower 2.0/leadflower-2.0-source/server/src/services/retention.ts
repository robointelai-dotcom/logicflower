import Alert from '../models/Alert'
import ScheduledStep from '../models/ScheduledStep'
import SendRecord from '../models/SendRecord'
import SequenceEnrolment from '../models/SequenceEnrolment'
import BatchJob from '../models/BatchJob'
import BatchRecord from '../models/BatchRecord'
import ConnectionScan from '../models/ConnectionScan'
import Execution from '../models/Execution'
import ExecutionNodeRun from '../models/ExecutionNodeRun'
import FailedJob from '../models/FailedJob'
import GeneratedReport from '../models/GeneratedReport'
import Incident from '../models/Incident'
import MonitoringRun from '../models/MonitoringRun'
import Organization from '../models/Organization'
import WebhookDelivery from '../models/WebhookDelivery'
import WebhookEvent from '../models/WebhookEvent'
import Workflow from '../models/Workflow'
import WorkflowVersion from '../models/WorkflowVersion'
import { purgeExpiredArtifacts } from './artifactStore'
import { recordAudit } from './audit'
import { resolvePlanPolicy } from './planPolicy'

/**
 * Sequence history that a rolling purge may remove.
 *
 * Note what is absent: SuppressionEntry. It is deliberately not imported into
 * this module and must never be. A retention sweep that deletes the record of
 * an unsubscribe silently re-permits contact with someone who asked to be left
 * alone — a worse outcome than keeping the data, and a regulatory one. Entries
 * are removed only when the entire organisation is erased, which is handled in
 * `dataLifecycle.ts` where no future send is possible.
 *
 * `scheduled_steps` is likewise pruned only in terminal states. Deleting a
 * pending step would cancel a wait the customer is relying on, without leaving
 * any trace that it ever existed.
 */
const TERMINAL_SCHEDULED_STEPS = ['completed', 'cancelled', 'failed']
const TERMINAL_ENROLMENTS = ['completed', 'exited', 'failed']

const TERMINAL_EXECUTIONS = ['succeeded', 'failed', 'cancelled']
const TERMINAL_BATCHES = ['cancelled', 'completed', 'completed_with_errors', 'failed']

async function deleteOperationalHistory(organizationId: string, cutoff: Date) {
  const executionIds: Array<{ _id: unknown }> = await Execution.find({
    organizationId, status: { $in: TERMINAL_EXECUTIONS }, createdAt: { $lt: cutoff },
  }).select('_id').limit(10_000).lean()
  const batchIds: Array<{ _id: unknown }> = await BatchJob.find({
    organizationId, status: { $in: TERMINAL_BATCHES }, createdAt: { $lt: cutoff },
  }).select('_id').limit(2_000).lean()
  const webhookEventIds: Array<{ _id: unknown }> = await WebhookEvent.find({
    organizationId, status: { $in: ['processed', 'failed'] }, createdAt: { $lt: cutoff },
  }).select('_id').limit(10_000).lean()

  const [nodeRuns, batchRecords, webhookDeliveries] = await Promise.all([
    executionIds.length ? ExecutionNodeRun.deleteMany({ organizationId, executionId: { $in: executionIds.map((row) => row._id) } }) : { deletedCount: 0 },
    batchIds.length ? BatchRecord.deleteMany({ organizationId, batchJobId: { $in: batchIds.map((row) => row._id) } }) : { deletedCount: 0 },
    webhookEventIds.length ? WebhookDelivery.deleteMany({ organizationId, webhookEventId: { $in: webhookEventIds.map((row) => row._id) } }) : { deletedCount: 0 },
  ])
  const results = await Promise.all([
    Execution.deleteMany({ _id: { $in: executionIds.map((row) => row._id) }, organizationId }),
    BatchJob.deleteMany({ _id: { $in: batchIds.map((row) => row._id) }, organizationId }),
    WebhookEvent.deleteMany({ _id: { $in: webhookEventIds.map((row) => row._id) }, organizationId }),
    MonitoringRun.deleteMany({ organizationId, status: { $in: ['completed', 'failed'] }, createdAt: { $lt: cutoff } }),
    FailedJob.deleteMany({ organizationId, createdAt: { $lt: cutoff } }),
    GeneratedReport.deleteMany({ organizationId, status: { $in: ['ready', 'failed'] }, createdAt: { $lt: cutoff } }),
    ConnectionScan.deleteMany({ organizationId, status: { $in: ['completed', 'failed'] }, createdAt: { $lt: cutoff } }),
    Alert.deleteMany({ organizationId, status: { $in: ['sent', 'failed', 'suppressed'] }, createdAt: { $lt: cutoff } }),
    Incident.deleteMany({ organizationId, status: 'resolved', resolvedAt: { $lt: cutoff } }),
    // Sequence operational history. Steps that are still pending are excluded
    // by the status filter, so an in-flight multi-week enrolment is never
    // truncated by a retention sweep.
    ScheduledStep.deleteMany({ organizationId, status: { $in: TERMINAL_SCHEDULED_STEPS }, createdAt: { $lt: cutoff } }),
    SendRecord.deleteMany({ organizationId, createdAt: { $lt: cutoff } }),
    SequenceEnrolment.deleteMany({ organizationId, status: { $in: TERMINAL_ENROLMENTS }, createdAt: { $lt: cutoff } }),
  ])
  return [nodeRuns, batchRecords, webhookDeliveries, ...results]
    .reduce((sum, result: any) => sum + Number(result?.deletedCount || 0), 0)
}

async function pruneWorkflowVersions(organizationId: string, policy: Awaited<ReturnType<typeof resolvePlanPolicy>>): Promise<number> {
  const workflows: any[] = await Workflow.find({ organizationId }).select('_id publishedVersion').lean()
  let deleted = 0
  const historyCutoff = new Date(Date.now() - policy.workflowHistoryDays * 86_400_000)
  for (const workflow of workflows) {
    const versions: any[] = await WorkflowVersion.find({ organizationId, workflowId: workflow._id })
      .sort({ version: -1 }).select('_id version createdAt').lean()
    if (!versions.length) continue
    // tenant-safe: called with an organisation-scoped filter built by the caller
    const referencedIds = new Set((await Execution.distinct('workflowVersionId', {
      organizationId, workflowId: workflow._id, workflowVersionId: { $ne: null },
    })).map(String))
    const keep = new Set<string>([String(versions[0]._id), String(workflow.publishedVersion || '')])
    for (const id of referencedIds) keep.add(id)
    if (policy.workflowVersionLimit != null) {
      for (const version of versions.slice(0, policy.workflowVersionLimit)) keep.add(String(version._id))
    } else {
      for (const version of versions) if (version.createdAt >= historyCutoff) keep.add(String(version._id))
    }
    const removeIds = versions.map((version) => version._id).filter((id) => !keep.has(String(id)))
    if (removeIds.length) deleted += Number((await WorkflowVersion.deleteMany({ _id: { $in: removeIds }, organizationId, workflowId: workflow._id })).deletedCount || 0)
  }
  return deleted
}

export async function enforceOrganizationRetention(organizationId: string): Promise<{ recordsDeleted: number; versionsDeleted: number; retentionDays: number }> {
  const [organization, policy] = await Promise.all([
    Organization.findOne({ _id: organizationId, status: 'active' }).select('+connectionCount'),
    resolvePlanPolicy(organizationId),
  ])
  if (!organization) return { recordsDeleted: 0, versionsDeleted: 0, retentionDays: 0 }
  const retentionDays = Math.min(policy.maxRetentionDays, Math.max(7, Number(organization.retentionDays || 7)))
  if (organization.retentionDays !== retentionDays) {
    organization.retentionDays = retentionDays
    await organization.save()
    await recordAudit({
      organizationId,
      actorType: 'system',
      action: 'retention.policy_clamped',
      entityType: 'Organization',
      entityId: organizationId,
      metadata: { plan: policy.plan, retentionDays },
    })
  }
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
  const recordsDeleted = await deleteOperationalHistory(organizationId, cutoff)
  const versionsDeleted = await pruneWorkflowVersions(organizationId, policy)
  if (recordsDeleted || versionsDeleted) {
    await recordAudit({
      organizationId,
      actorType: 'system',
      action: 'retention.purge_completed',
      entityType: 'Organization',
      entityId: organizationId,
      metadata: { plan: policy.plan, retentionDays, cutoff, recordsDeleted, versionsDeleted },
    })
  }
  return { recordsDeleted, versionsDeleted, retentionDays }
}

export async function runRetentionMaintenance(limit = 50): Promise<{ organizations: number; recordsDeleted: number; versionsDeleted: number; artifactsDeleted: number }> {
  const organizations: any[] = await Organization.find({ status: 'active' }).sort({ _id: 1 }).limit(Math.max(1, Math.min(500, limit))).select('_id').lean()
  let recordsDeleted = 0; let versionsDeleted = 0
  for (const organization of organizations) {
    const result = await enforceOrganizationRetention(String(organization._id))
    recordsDeleted += result.recordsDeleted; versionsDeleted += result.versionsDeleted
  }
  const artifactsDeleted = await purgeExpiredArtifacts(250)
  return { organizations: organizations.length, recordsDeleted, versionsDeleted, artifactsDeleted }
}
