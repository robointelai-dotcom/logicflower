import { PlatformProvider } from '../models/PlatformConnection'
import ConnectionDeletionTask from '../models/ConnectionDeletionTask'
import PlatformConnection from '../models/PlatformConnection'
import { getConnectionCredential, revokePlatformConnection } from './connectionCredentials'
import { Types } from 'mongoose'
import { releaseConnectionCapacity } from './planPolicy'
import { purgeProviderDerivedData, PurgeTrigger } from './retention/purgeLedger'

type Revoker = (input: {
  organizationId: string
  connectionId: string
  credentials: Awaited<ReturnType<typeof getConnectionCredential>>
}) => Promise<void>

const revokers = new Map<PlatformProvider, Revoker>()
const remoteRevocationProviders = new Set<PlatformProvider>(['ghl', 'hubspot', 'klaviyo', 'google'])

export function registerConnectionRevoker(provider: PlatformProvider, revoker: Revoker): void {
  revokers.set(provider, revoker)
}

export async function disconnectConnection(input: {
  organizationId: string
  connectionId: string
  provider: PlatformProvider
}): Promise<{ deletionScheduled: true }> {
  await PlatformConnection.updateOne({
    _id: input.connectionId, organizationId: input.organizationId, provider: input.provider, status: { $ne: 'revoked' },
  }, { $set: { status: 'disconnecting', lastError: null } })
  await releaseConnectionCapacity({ organizationId: input.organizationId, connectionId: input.connectionId })
  // tenant-safe: cross-tenant deletion worker claiming the next due task across all organisations
  await ConnectionDeletionTask.findOneAndUpdate({
    organizationId: input.organizationId, connectionId: input.connectionId,
  }, {
    $setOnInsert: {
      provider: input.provider,
      status: 'pending',
      scheduledFor: new Date(),
      credentialsDeleteAt: new Date(Date.now() + 24 * 60 * 60_000),
    },
  }, { upsert: true, new: true })
  const revoker = revokers.get(input.provider)
  if (remoteRevocationProviders.has(input.provider) && !revoker) {
    await PlatformConnection.updateOne({
      _id: input.connectionId, organizationId: input.organizationId, provider: input.provider,
    }, { $set: { status: 'disconnecting', lastError: 'Provider token revocation capability is not installed; local use is blocked and revocation is queued' } })
    throw new Error('Provider token revocation capability is not installed')
  }
  if (revoker) {
    const credentials = await getConnectionCredential({ ...input, allowDisconnecting: true })
    try {
      await revoker({ ...input, credentials })
    } catch (error: any) {
      await PlatformConnection.updateOne({
        _id: input.connectionId, organizationId: input.organizationId, provider: input.provider,
      }, { $set: { status: 'disconnecting', lastError: String(error?.message || 'Provider revocation failed').slice(0, 1_000) } })
      throw error
    }
  }
  await revokePlatformConnection(input)
  await ConnectionDeletionTask.updateOne({ organizationId: input.organizationId, connectionId: input.connectionId }, {
    $set: { status: 'pending', credentialDeletedAt: new Date() },
  })
  return { deletionScheduled: true }
}

/**
 * Purge every class of provider-derived data for a connection and write ledger
 * evidence of the purge.
 *
 * This previously deleted contacts, tags and poll cursors only, which left
 * WorkflowSnapshot — the Vault history, and the data class a provider
 * cached-data deletion clause is actually about ([V11]) — in place after
 * disconnection. Delegating to the purge ledger makes the collection list a
 * single declared set, so a new provider-derived collection is covered by
 * adding it in one place rather than remembering this function exists.
 */
async function purgeConnectionCaches(organizationId: string, connectionId: string, provider: string, trigger: PurgeTrigger = 'connection_deleted'): Promise<void> {
  if (!Types.ObjectId.isValid(organizationId) || !Types.ObjectId.isValid(connectionId)) throw new Error('Connection cache purge identifiers are invalid')
  await purgeProviderDerivedData({ organizationId, connectionId, provider, trigger })
}

function retryAt(attempt: number) {
  const delay = Math.min(60 * 60_000, 15_000 * Math.pow(2, Math.min(8, Math.max(0, attempt - 1))))
  return new Date(Date.now() + delay)
}

export async function processConnectionDeletionTasks(limit = 25): Promise<{ processed: number; completed: number; deferred: number }> {
  let processed = 0; let completed = 0; let deferred = 0
  const staleProcessing = new Date(Date.now() - 10 * 60_000)
  while (processed < Math.min(100, Math.max(1, limit))) {
    // tenant-safe: cross-tenant deletion worker claiming the next due task across all organisations
    const task: any = await ConnectionDeletionTask.findOneAndUpdate({
      scheduledFor: { $lte: new Date() },
      $or: [{ status: { $in: ['pending', 'failed'] } }, { status: 'processing', updatedAt: { $lte: staleProcessing } }],
    }, {
      $set: { status: 'processing', lastAttemptAt: new Date() }, $inc: { attemptCount: 1 },
    }, { new: true, sort: { scheduledFor: 1 } })
    if (!task) break
    processed += 1
    const organizationId = String(task.organizationId); const connectionId = String(task.connectionId); const provider = task.provider as PlatformProvider
    let remoteError = ''
    try {
      let credentialDeleted = Boolean(task.credentialDeletedAt)
      const connection: any = await PlatformConnection.findOne({ _id: connectionId, organizationId, provider }).select('status').lean()
      if (!credentialDeleted && (!connection || connection.status === 'revoked')) { credentialDeleted = true; task.credentialDeletedAt = new Date() }
      if (!credentialDeleted) {
        const deadlineReached = new Date(task.credentialsDeleteAt).getTime() <= Date.now()
        const revoker = revokers.get(provider)
        let remotelyRevoked = !remoteRevocationProviders.has(provider)
        if (revoker) {
          try {
            const credentials = await getConnectionCredential({ organizationId, connectionId, provider, allowDisconnecting: true })
            await revoker({ organizationId, connectionId, credentials }); remotelyRevoked = true
          } catch (error: any) { remoteError = String(error?.message || 'Provider revocation failed').slice(0, 1_000) }
        } else if (remoteRevocationProviders.has(provider)) remoteError = 'Provider token revocation capability is not installed'

        if (!remotelyRevoked && !deadlineReached) {
          task.status = 'pending'; task.scheduledFor = retryAt(Number(task.attemptCount || 1)); task.error = remoteError; await task.save(); deferred += 1; continue
        }
        try { await revokePlatformConnection({ organizationId, connectionId, provider }) }
        catch (error: any) { if (connection) throw error }
        task.credentialDeletedAt = new Date(); credentialDeleted = true
      }
      if (credentialDeleted && !task.cachedDataDeletedAt) {
        await purgeConnectionCaches(organizationId, connectionId, provider); task.cachedDataDeletedAt = new Date()
      }
      task.status = 'completed'; task.completedAt = new Date(); task.error = remoteError || undefined; await task.save(); completed += 1
    } catch (error: any) {
      const deadlineReached = new Date(task.credentialsDeleteAt).getTime() <= Date.now()
      const message = String(error?.message || 'Connection deletion failed').slice(0, 1_000)
      if (deadlineReached) {
        try {
          try { await revokePlatformConnection({ organizationId, connectionId, provider }) }
          catch (revokeError) { if (await PlatformConnection.exists({ _id: connectionId, organizationId, provider, status: { $ne: 'revoked' } })) throw revokeError }
          task.credentialDeletedAt ||= new Date(); await purgeConnectionCaches(organizationId, connectionId, provider); task.cachedDataDeletedAt = new Date(); task.status = 'completed'; task.completedAt = new Date(); task.error = message; await task.save(); completed += 1
        } catch (purgeError: any) {
          task.status = 'failed'; task.error = String(purgeError?.message || message).slice(0, 1_000); task.scheduledFor = retryAt(Number(task.attemptCount || 1)); await task.save(); deferred += 1
        }
      } else {
        task.status = 'pending'; task.error = message; task.scheduledFor = retryAt(Number(task.attemptCount || 1)); await task.save(); deferred += 1
      }
    }
  }
  return { processed, completed, deferred }
}
