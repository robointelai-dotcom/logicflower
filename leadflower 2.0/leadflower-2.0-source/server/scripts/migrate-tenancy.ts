import '../src/loadEnv'
import mongoose, { Types } from 'mongoose'
import { connectDB } from '../src/db'
import Organization from '../src/models/Organization'
import PlatformConnection from '../src/models/PlatformConnection'
import { resolvePlanPolicy } from '../src/services/planPolicy'

const collectionNames = [
  'aiconnectionconsents', 'alerts', 'artifacts', 'auditevents', 'batchjobs', 'batchrecords',
  'connectiondeletiontasks', 'connectionscans', 'datalifecyclerequests', 'contacts', 'destinations', 'executions', 'executionnoderuns',
  'failedjobs', 'generatedreports', 'incidents', 'invitations', 'memberships', 'monitoringruns',
  'notificationchannels', 'oauthstates', 'platformconnections', 'pollcursors', 'schedules',
  'subscriptions', 'supportaccessrequests', 'tags', 'ultrasplits', 'usagecounters', 'usagerecords',
  'webhookdeliveries', 'webhookevents', 'webhookkeys', 'workflowdryrunapprovals', 'workflows', 'workflowsnapshots', 'workflowversions',
]

const modelModulePaths = [
  '../src/models/AiConnectionConsent', '../src/models/Alert', '../src/models/Artifact', '../src/models/AuditEvent',
  '../src/models/BatchJob', '../src/models/BatchRecord', '../src/models/ConnectionDeletionTask', '../src/models/ConnectionScan',
  '../src/models/DataLifecycleRequest', '../src/models/Contact',
  '../src/models/Destination', '../src/models/Execution', '../src/models/ExecutionNodeRun', '../src/models/FailedJob',
  '../src/models/GeneratedReport', '../src/models/IdempotencyRecord', '../src/models/Incident', '../src/models/Invitation',
  '../src/models/Membership', '../src/models/MfaChallenge', '../src/models/MonitoringRun', '../src/models/NotificationChannel',
  '../src/models/OAuthState', '../src/models/Organization', '../src/models/PasswordReset', '../src/models/PlatformConnection',
  '../src/models/PollCursor', '../src/models/Schedule', '../src/models/Session', '../src/models/StripeEvent',
  '../src/models/Subscription', '../src/models/SupportAccessRequest', '../src/models/Tag', '../src/models/UltraSplit',
  '../src/models/UsageCounter', '../src/models/UsageRecord', '../src/models/User', '../src/models/WebhookDelivery',
  '../src/models/WebhookEvent', '../src/models/WebhookKey', '../src/models/Workflow', '../src/models/WorkflowDryRunApproval', '../src/models/WorkflowSnapshot',
  '../src/models/WorkflowVersion',
]

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function sameKey(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

async function dropKnownObsoleteIndexes(apply: boolean) {
  const contacts = mongoose.connection.collection('contacts')
  const indexes = await contacts.indexes().catch(() => [])
  for (const index of indexes) {
    if (index.unique === true && sameKey(index.key as any, { ghlId: 1 })) {
      process.stdout.write(`${apply ? 'drop' : 'would drop'} contacts.${index.name}\n`)
      if (apply && index.name) await contacts.dropIndex(index.name)
    }
    if (sameKey(index.key as any, { email: 1 }) || sameKey(index.key as any, { phone: 1 })) {
      process.stdout.write(`${apply ? 'drop' : 'would drop'} contacts.${index.name}\n`)
      if (apply && index.name) await contacts.dropIndex(index.name)
    }
  }
  const metas = mongoose.connection.collection('metas')
  for (const index of await metas.indexes().catch(() => [])) {
    if (index.unique === true && sameKey(index.key as any, { key: 1 })) {
      process.stdout.write(`${apply ? 'drop' : 'would drop'} metas.${index.name}\n`)
      if (apply && index.name) await metas.dropIndex(index.name)
    }
  }
  const tags = mongoose.connection.collection('tags')
  for (const index of await tags.indexes().catch(() => [])) {
    if (index.unique === true && (
      sameKey(index.key as any, { ghlId: 1 })
      || sameKey(index.key as any, { organizationId: 1, ghlId: 1 })
    )) {
      process.stdout.write(`${apply ? 'drop' : 'would drop'} tags.${index.name}\n`)
      if (apply && index.name) await tags.dropIndex(index.name)
    }
  }
  for (const index of indexes) {
    if (index.unique === true && sameKey(index.key as any, { organizationId: 1, ghlId: 1 })) {
      process.stdout.write(`${apply ? 'drop' : 'would drop'} contacts.${index.name}\n`)
      if (apply && index.name) await contacts.dropIndex(index.name)
    }
  }
}

async function createApplicationIndexes(apply: boolean) {
  for (const modulePath of modelModulePaths) {
    const Model = (await import(modulePath)).default
    process.stdout.write(`${apply ? 'ensure' : 'would ensure'} indexes for ${Model.modelName}\n`)
    if (apply) await Model.createIndexes()
  }
}

async function main() {
  const organizationId = String(arg('--organization-id') || '')
  const apply = process.argv.includes('--apply')
  if (!Types.ObjectId.isValid(organizationId)) throw new Error('--organization-id must be an existing Organization ObjectId')
  await connectDB()
  if (!await Organization.exists({ _id: organizationId, status: 'active' })) throw new Error('Target organization does not exist or is not active')
  for (const name of collectionNames) {
    const collection = mongoose.connection.collection(name)
    const filter = { $or: [{ organizationId: { $exists: false } }, { organizationId: null }, { organizationId: '' }] }
    const count = await collection.countDocuments(filter)
    process.stdout.write(`${name}: ${count} legacy record(s) ${apply ? 'assigned' : 'would be assigned'}\n`)
    if (apply && count) await collection.updateMany(filter, { $set: { organizationId } })
  }
  await dropKnownObsoleteIndexes(apply)
  await createApplicationIndexes(apply)
  const policy = await resolvePlanPolicy(organizationId)
  const connectionCount = await PlatformConnection.countDocuments({ organizationId, status: { $in: ['pending', 'active', 'degraded', 'error'] }, slotReleasedAt: { $exists: false } })
  process.stdout.write(`organization policy: ${connectionCount} active connection slot(s), retention capped at ${policy.maxRetentionDays} day(s)\n`)
  if (apply) await Organization.updateOne({ _id: organizationId }, {
    $set: { connectionCount },
    $min: { retentionDays: policy.maxRetentionDays },
  })
  process.stdout.write(apply ? 'Tenant migration applied.\n' : 'Dry run only. Re-run with --apply after reviewing counts.\n')
  await mongoose.disconnect()
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`)
  await mongoose.disconnect().catch(() => undefined)
  process.exitCode = 1
})
