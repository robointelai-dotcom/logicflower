import crypto from 'crypto'
import { createWriteStream } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { once } from 'events'
import { finished } from 'stream/promises'
import { createGzip } from 'zlib'
import AiConnectionConsent from '../models/AiConnectionConsent'
import Alert from '../models/Alert'
import Artifact from '../models/Artifact'
import AuditEvent from '../models/AuditEvent'
import BatchJob from '../models/BatchJob'
import BatchRecord from '../models/BatchRecord'
import ConnectionDeletionTask from '../models/ConnectionDeletionTask'
import ConnectionScan from '../models/ConnectionScan'
import Contact from '../models/Contact'
import DataLifecycleRequest from '../models/DataLifecycleRequest'
import Destination from '../models/Destination'
import Execution from '../models/Execution'
import ExecutionNodeRun from '../models/ExecutionNodeRun'
import FailedJob from '../models/FailedJob'
import GeneratedReport from '../models/GeneratedReport'
import Incident from '../models/Incident'
import Invitation from '../models/Invitation'
import Membership from '../models/Membership'
import MonitoringRun from '../models/MonitoringRun'
import NotificationChannel from '../models/NotificationChannel'
import OAuthState from '../models/OAuthState'
import Organization from '../models/Organization'
import PlatformConnection from '../models/PlatformConnection'
import PollCursor from '../models/PollCursor'
import Schedule from '../models/Schedule'
import Session from '../models/Session'
import Subscription from '../models/Subscription'
import SupportAccessRequest from '../models/SupportAccessRequest'
import Tag from '../models/Tag'
import UltraSplit from '../models/UltraSplit'
import UsageCounter from '../models/UsageCounter'
import UsageRecord from '../models/UsageRecord'
import WebhookDelivery from '../models/WebhookDelivery'
import WebhookEvent from '../models/WebhookEvent'
import WebhookKey from '../models/WebhookKey'
import Workflow from '../models/Workflow'
import WorkflowDryRunApproval from '../models/WorkflowDryRunApproval'
import WorkflowSnapshot from '../models/WorkflowSnapshot'
import WorkflowVersion from '../models/WorkflowVersion'
import IdempotencyRecord from '../models/IdempotencyRecord'
import { dataLifecycleQueue } from '../queue'
import Appointment from '../models/Appointment'
import Conversation from '../models/Conversation'
import BookingPage from '../models/BookingPage'
import Company from '../models/Company'
import DialerJob from '../models/DialerJob'
import TagRule from '../models/TagRule'
import Review from '../models/Review'
import VoiceAgent from '../models/VoiceAgent'
import VoiceAgentVersion from '../models/VoiceAgentVersion'
import VoiceCall from '../models/VoiceCall'
import ReviewRequest from '../models/ReviewRequest'
import ReviewWidget from '../models/ReviewWidget'
import ScheduledPost from '../models/ScheduledPost'
import SocialAccount from '../models/SocialAccount'
import SocialPost from '../models/SocialPost'
import ContactActivity from '../models/ContactActivity'
import Message from '../models/Message'
import Task from '../models/Task'
import ContactNote from '../models/ContactNote'
import CustomFieldDefinition from '../models/CustomFieldDefinition'
import Deal from '../models/Deal'
import FormSubmission from '../models/FormSubmission'
import HostedForm from '../models/HostedForm'
import PaymentLink from '../models/PaymentLink'
import Pipeline from '../models/Pipeline'
import SavedSegment from '../models/SavedSegment'
import MessagingIdentity from '../models/MessagingIdentity'
import ScheduledStep from '../models/ScheduledStep'
import SendRecord from '../models/SendRecord'
import Sequence from '../models/Sequence'
import SequenceEnrolment from '../models/SequenceEnrolment'
import SequenceVersion from '../models/SequenceVersion'
import SuppressionEntry from '../models/SuppressionEntry'
import { deleteStoredArtifact, storeArtifactFromFile } from './artifactStore'
import { disconnectConnection, processConnectionDeletionTasks } from './connectionLifecycle'
import pino from '../logger'

const TENANT_MODELS: Array<{ name: string; model: any }> = [
  { name: 'ai_connection_consents', model: AiConnectionConsent }, { name: 'alerts', model: Alert },
  { name: 'artifacts', model: Artifact }, { name: 'audit_events', model: AuditEvent },
  { name: 'batch_jobs', model: BatchJob }, { name: 'batch_records', model: BatchRecord },
  { name: 'connection_deletion_tasks', model: ConnectionDeletionTask }, { name: 'connection_scans', model: ConnectionScan },
  { name: 'contacts', model: Contact }, { name: 'destinations', model: Destination },
  { name: 'executions', model: Execution }, { name: 'execution_node_runs', model: ExecutionNodeRun },
  { name: 'failed_jobs', model: FailedJob }, { name: 'generated_reports', model: GeneratedReport },
  { name: 'incidents', model: Incident }, { name: 'invitations', model: Invitation },
  { name: 'memberships', model: Membership }, { name: 'monitoring_runs', model: MonitoringRun },
  { name: 'notification_channels', model: NotificationChannel }, { name: 'oauth_states', model: OAuthState },
  { name: 'platform_connections', model: PlatformConnection }, { name: 'poll_cursors', model: PollCursor },
  { name: 'schedules', model: Schedule }, { name: 'subscriptions', model: Subscription },
  { name: 'support_access_requests', model: SupportAccessRequest }, { name: 'tags', model: Tag },
  { name: 'ultra_splits', model: UltraSplit }, { name: 'usage_counters', model: UsageCounter },
  { name: 'usage_records', model: UsageRecord }, { name: 'webhook_deliveries', model: WebhookDelivery },
  { name: 'webhook_events', model: WebhookEvent }, { name: 'webhook_keys', model: WebhookKey },
  { name: 'workflows', model: Workflow }, { name: 'workflow_dry_run_approvals', model: WorkflowDryRunApproval },
  { name: 'workflow_snapshots', model: WorkflowSnapshot }, { name: 'workflow_versions', model: WorkflowVersion },
  { name: 'sequences', model: Sequence }, { name: 'sequence_versions', model: SequenceVersion },
  { name: 'sequence_enrolments', model: SequenceEnrolment }, { name: 'scheduled_steps', model: ScheduledStep },
  { name: 'send_records', model: SendRecord }, { name: 'messaging_identities', model: MessagingIdentity },
  // Suppression is listed here, and ONLY here.
  //
  // The distinction matters and is easy to get backwards. A rolling retention
  // purge must never delete a suppression entry: the organisation is still
  // sending, and removing the record that says "this person asked us to stop"
  // silently re-permits contact. `services/retention.ts` therefore does not
  // touch this collection, and a repository guardrail fails the build if it
  // ever starts to.
  //
  // Erasure of the whole organisation is the opposite case. The sender ceases
  // to exist, so no future send is possible, and retaining keyed digests of
  // people's addresses after the controller is gone would itself be personal
  // data kept without a purpose.
  { name: 'suppression_entries', model: SuppressionEntry },
  // Micro-CRM (Phase 2). All included: an erasure request means erasure, and
  // leaving a contact's notes, timeline or form submissions behind because they
  // sit in a different collection is the same failure as not deleting them at
  // all.
  //
  // FormSubmission carries consent evidence and ContactActivity carries the
  // timeline, so there is a real question about whether either has a retention
  // obligation that outlives the organisation. That question is for counsel.
  // Until it is answered, the default is deletion — the reverse default retains
  // personal data on a guess, which is the harder position to defend.
  { name: 'contact_activities', model: ContactActivity }, { name: 'contact_notes', model: ContactNote },
  { name: 'custom_field_definitions', model: CustomFieldDefinition }, { name: 'deals', model: Deal },
  { name: 'form_submissions', model: FormSubmission }, { name: 'hosted_forms', model: HostedForm },
  { name: 'payment_links', model: PaymentLink }, { name: 'pipelines', model: Pipeline },
  { name: 'saved_segments', model: SavedSegment },
  { name: 'tasks', model: Task }, { name: 'appointments', model: Appointment },
  { name: 'conversations', model: Conversation }, { name: 'messages', model: Message },
  { name: 'social_accounts', model: SocialAccount }, { name: 'social_posts', model: SocialPost },
  { name: 'scheduled_posts', model: ScheduledPost }, { name: 'reviews', model: Review },
  { name: 'review_requests', model: ReviewRequest }, { name: 'review_widgets', model: ReviewWidget },
  { name: 'voice_agents', model: VoiceAgent }, { name: 'voice_agent_versions', model: VoiceAgentVersion },
  { name: 'voice_calls', model: VoiceCall }, { name: 'dialer_jobs', model: DialerJob },
  { name: 'companies', model: Company }, { name: 'tag_rules', model: TagRule },
  { name: 'booking_pages', model: BookingPage },
]

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export function serializeLifecycleRequest(row: any) {
  return {
    id: String(row._id), organizationId: String(row.organizationId), type: row.type, status: row.status,
    artifactId: row.artifactId ? String(row.artifactId) : null,
    downloadUrl: row.artifactId && row.status === 'ready' ? `/api/v1/artifacts/${row.artifactId}/download` : null,
    requestedAt: row.requestedAt, startedAt: row.startedAt || null, completedAt: row.completedAt || null,
    evidence: row.evidence || {}, error: row.error || null,
  }
}

export async function enqueueDataLifecycleRequest(id: string, delay = 0): Promise<void> {
  try {
    await dataLifecycleQueue.add('process', { requestId: id }, {
      jobId: `data-lifecycle-${id}-${Date.now()}`,
      delay,
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 1_000,
    })
  } catch (error) {
    pino.error({ err: error, dataLifecycleRequestId: id }, 'data lifecycle enqueue failed; maintenance will recover it')
  }
}

async function writeLine(stream: NodeJS.WritableStream, value: unknown): Promise<void> {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, 'drain')
}

async function generateExport(request: any): Promise<void> {
  const organizationId = String(request.organizationId)
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'logicflower-org-export-'))
  const sourcePath = path.join(workDirectory, 'organization-export.ndjson.gz')
  const output = createWriteStream(sourcePath, { flags: 'wx', mode: 0o600 })
  const gzip = createGzip({ level: 9 })
  gzip.pipe(output)
  const counts: Record<string, number> = {}
  try {
    const organization = await Organization.findById(organizationId).lean()
    await writeLine(gzip, { collection: 'manifest', document: { format: 'logicflower-ndjson-v1', organizationId, generatedAt: new Date().toISOString() } })
    if (organization) { await writeLine(gzip, { collection: 'organization', document: organization }); counts.organization = 1 }
    for (const entry of TENANT_MODELS) {
      let count = 0
      const cursor = entry.model.find({ organizationId }).lean().cursor()
      for await (const document of cursor) { await writeLine(gzip, { collection: entry.name, document }); count += 1 }
      counts[entry.name] = count
    }
    gzip.end()
    await finished(output)
    const artifact: any = await storeArtifactFromFile({
      organizationId,
      kind: 'organization_export',
      sourcePath,
      fileName: `logicflower-workspace-${organizationId}.ndjson.gz`,
      contentType: 'application/gzip',
      createdBy: String(request.requestedBy),
      metadata: { dataLifecycleRequestId: String(request._id), format: 'logicflower-ndjson-v1' },
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    })
    request.status = 'ready'; request.artifactId = artifact._id; request.completedAt = new Date(); request.evidence = { counts, expiresAt: artifact.expiresAt, sha256: artifact.sha256 }; request.error = undefined
    await request.save()
  } finally {
    if (!gzip.destroyed) gzip.destroy()
    await rm(workDirectory, { recursive: true, force: true })
  }
}

async function beginConnectionDeletion(organizationId: string): Promise<boolean> {
  const connections: any[] = await PlatformConnection.find({ organizationId, status: { $ne: 'revoked' } }).select('_id provider').lean()
  for (const connection of connections) {
    await disconnectConnection({ organizationId, connectionId: String(connection._id), provider: connection.provider }).catch(() => undefined)
  }
  await processConnectionDeletionTasks(100)
  return !await ConnectionDeletionTask.exists({ organizationId, status: { $ne: 'completed' } })
}

async function deleteOrganizationData(request: any): Promise<void> {
  const organizationId = String(request.organizationId)
  const organization: any = await Organization.findById(organizationId)
  if (!organization) throw new Error('Organization no longer exists')
  if (organization.status === 'active') { organization.status = 'suspended'; await organization.save() }
  if (!await beginConnectionDeletion(organizationId)) {
    request.status = 'processing'; request.nextAttemptAt = new Date(Date.now() + 60_000); request.evidence = { ...(request.evidence || {}), phase: 'credential_revocation' }; await request.save()
    return
  }

  // tenant-safe: resolves the members of the organisation being closed; the organisation is the subject of the operation
  const memberUserIds = await Membership.distinct('userId', { organizationId })
  const artifacts: any[] = await Artifact.find({ organizationId, status: { $ne: 'deleted' } }).select('_id').lean()
  for (const artifact of artifacts) await deleteStoredArtifact(organizationId, String(artifact._id)).catch(() => undefined)

  const counts: Record<string, number> = {}
  for (const entry of TENANT_MODELS) {
    if (entry.model === Artifact || entry.model === AuditEvent || entry.model === Membership || entry.model === ConnectionDeletionTask) continue
    const result = await entry.model.deleteMany({ organizationId })
    counts[entry.name] = Number(result.deletedCount || 0)
  }
  counts.connection_deletion_tasks = Number((await ConnectionDeletionTask.deleteMany({ organizationId })).deletedCount || 0)
  counts.artifacts = Number((await Artifact.deleteMany({ organizationId })).deletedCount || 0)
  counts.audit_events = Number((await AuditEvent.collection.deleteMany({ organizationId: organization._id })).deletedCount || 0)
  counts.memberships = Number((await Membership.deleteMany({ organizationId })).deletedCount || 0)
  counts.idempotency_records = Number((await IdempotencyRecord.deleteMany({ scope: organizationId })).deletedCount || 0)
  await Session.updateMany({ currentOrganizationId: organization._id, userId: { $in: memberUserIds }, revokedAt: null }, {
    $set: { revokedAt: new Date(), revokeReason: 'organization_deleted' }, $unset: { currentOrganizationId: 1 },
  })
  organization.status = 'deleted'; organization.name = 'Deleted workspace'; organization.timezone = 'UTC'; organization.retentionDays = 7; organization.connectionCount = 0; organization.onboardingCompletedAt = undefined
  await organization.save()

  const completedAt = new Date()
  const evidence = {
    certificateVersion: 1,
    requestId: String(request._id),
    organizationId,
    requestedAt: request.requestedAt,
    completedAt,
    credentialDeletionVerified: true,
    storedArtifactsDeleted: artifacts.length,
    recordsDeleted: Object.values(counts).reduce((sum, value) => sum + value, 0),
    counts,
  }
  const certificateHash = crypto.createHash('sha256').update(canonical(evidence)).digest('hex')
  request.status = 'completed'; request.completedAt = completedAt; request.evidence = { ...evidence, certificateHash }; request.error = undefined
  await request.save()
}

export async function processDataLifecycleRequest(requestId: string): Promise<{ deferred: boolean }> {
  const stale = new Date(Date.now() - 15 * 60_000)
  // tenant-safe: cross-tenant lifecycle worker claiming the next due request
  const request: any = await DataLifecycleRequest.findOneAndUpdate({
    _id: requestId,
    status: { $in: ['queued', 'processing'] },
    $or: [{ status: 'queued' }, { updatedAt: { $lte: stale } }, { nextAttemptAt: { $lte: new Date() } }],
  }, { $set: { status: 'processing', startedAt: new Date(), nextAttemptAt: new Date(Date.now() + 15 * 60_000) }, $inc: { attemptCount: 1 } }, { new: true })
  if (!request) return { deferred: false }
  try {
    if (request.type === 'export') await generateExport(request)
    else await deleteOrganizationData(request)
    // tenant-safe: identifier is supplied by the claiming worker from a record it already owns
    const fresh: any = await DataLifecycleRequest.findById(request._id).select('status nextAttemptAt').lean()
    return { deferred: fresh?.status === 'processing' }
  } catch (error: any) {
    request.status = Number(request.attemptCount || 0) >= 10 ? 'failed' : 'queued'
    request.nextAttemptAt = new Date(Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(6, Number(request.attemptCount || 1) - 1)))
    request.error = String(error?.message || 'Data lifecycle operation failed').slice(0, 1_000)
    await request.save()
    throw error
  }
}

export async function reconcileDataLifecycleRequests(): Promise<number> {
  // tenant-safe: cross-tenant lifecycle worker selecting due requests across all organisations
  const rows: any[] = await DataLifecycleRequest.find({
    status: { $in: ['queued', 'processing'] }, nextAttemptAt: { $lte: new Date() },
  }).sort({ nextAttemptAt: 1 }).limit(100).select('_id').lean()
  for (const row of rows) await enqueueDataLifecycleRequest(String(row._id))
  return rows.length
}
