import crypto from 'crypto'
import { Types } from 'mongoose'
import Contact from '../../models/Contact'
import Tag from '../../models/Tag'
import PollCursor from '../../models/PollCursor'
import WorkflowSnapshot from '../../models/WorkflowSnapshot'
import ConnectionScan from '../../models/ConnectionScan'
import CapabilityProbe from '../../models/CapabilityProbe'
import WebhookEvent from '../../models/WebhookEvent'
import DataPurgeLedgerEntry from '../../models/DataPurgeLedgerEntry'
import { canonicalJson } from '../canonicalJson'
import { providerDataPolicy, retentionDaysAfterDisconnect } from './providerDataPolicy'

export type PurgeTrigger =
  | 'connection_disconnected'
  | 'connection_revoked'
  | 'connection_deleted'
  | 'organization_closed'
  | 'retention_schedule'
  | 'operator_request'

/**
 * Collections holding data derived from a provider account.
 *
 * `WorkflowSnapshot` is the entry that matters for [V11]: it is the Vault
 * history, and it is exactly the class of cached customer data a provider
 * deletion clause is written about. It was absent from the original purge path,
 * which meant disconnection deleted contacts and left the workflow definitions
 * behind.
 */
const PROVIDER_DERIVED = [
  { name: 'WorkflowSnapshot', model: WorkflowSnapshot },
  { name: 'ConnectionScan', model: ConnectionScan },
  { name: 'CapabilityProbe', model: CapabilityProbe },
  { name: 'WebhookEvent', model: WebhookEvent },
  { name: 'Contact', model: Contact },
  { name: 'Tag', model: Tag },
  { name: 'PollCursor', model: PollCursor },
] as const

async function previousHash(organizationId: string, connectionId?: string): Promise<string | undefined> {
  const filter: Record<string, unknown> = { organizationId }
  if (connectionId) filter.connectionId = connectionId
  const last: any = await DataPurgeLedgerEntry.findOne(filter).sort({ executedAt: -1 }).select('entryHash').lean()
  return last?.entryHash
}

/**
 * Purge provider-derived data for one connection and write ledger evidence.
 *
 * Returns the ledger entry. Callers must treat a thrown error as "purge did not
 * happen" — the entry is written only after the deletions complete, so a
 * ledger entry always corresponds to work actually performed.
 */
export async function purgeProviderDerivedData(input: {
  organizationId: string
  connectionId?: string
  provider: string
  trigger: PurgeTrigger
  requestedBy?: string
  correlationId?: string
  note?: string
  /** Override the cutoff for scheduled retention purges. */
  cutoff?: Date
}) {
  if (!Types.ObjectId.isValid(input.organizationId)) throw new Error('Purge organization identifier is invalid')
  if (input.connectionId && !Types.ObjectId.isValid(input.connectionId)) throw new Error('Purge connection identifier is invalid')

  const policy = providerDataPolicy(input.provider)
  const retentionDays = retentionDaysAfterDisconnect(input.provider)
  const deletedCounts: Record<string, number> = {}
  let totalDeleted = 0

  // A non-zero retention window defers rather than skips: records older than
  // the window are removed now, the remainder are removed by the scheduled
  // retention worker once they age past it.
  const ageCutoff = input.cutoff
    || (retentionDays > 0 ? new Date(Date.now() - retentionDays * 86_400_000) : undefined)

  for (const collection of PROVIDER_DERIVED) {
    const filter: Record<string, unknown> = { organizationId: input.organizationId }
    if (input.connectionId) filter.connectionId = input.connectionId
    if (ageCutoff) filter.createdAt = { $lt: ageCutoff }
    const result = await (collection.model as any).deleteMany(filter)
    const count = Number(result?.deletedCount || 0)
    deletedCounts[collection.name] = count
    totalDeleted += count
  }

  const executedAt = new Date()
  const prior = await previousHash(input.organizationId, input.connectionId)
  const entryHash = crypto.createHash('sha256').update(canonicalJson({
    organizationId: input.organizationId,
    connectionId: input.connectionId || null,
    provider: input.provider,
    trigger: input.trigger,
    legalBasis: policy.legalBasis,
    retentionDaysApplied: retentionDays,
    deletedCounts,
    totalDeleted,
    executedAt: executedAt.toISOString(),
    previousEntryHash: prior || null,
  })).digest('hex')

  return DataPurgeLedgerEntry.create({
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    provider: input.provider,
    trigger: input.trigger,
    legalBasis: policy.legalBasis,
    retentionDaysApplied: retentionDays,
    deletedCounts,
    totalDeleted,
    entryHash,
    previousEntryHash: prior,
    executedAt,
    requestedBy: input.requestedBy,
    correlationId: input.correlationId,
    note: input.note || policy.reviewNote,
  })
}

/**
 * Recompute the hash chain for an organisation's ledger.
 *
 * A verification routine is what turns a log into evidence: without it, the
 * hashes are decoration. Returns the first index at which the chain breaks.
 */
export async function verifyPurgeLedger(organizationId: string, connectionId?: string) {
  const filter: Record<string, unknown> = { organizationId }
  if (connectionId) filter.connectionId = connectionId
  const rows: any[] = await DataPurgeLedgerEntry.find(filter).sort({ executedAt: 1 }).lean()
  let expectedPrevious: string | undefined
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const recomputed = crypto.createHash('sha256').update(canonicalJson({
      organizationId: String(row.organizationId),
      connectionId: row.connectionId ? String(row.connectionId) : null,
      provider: row.provider,
      trigger: row.trigger,
      legalBasis: row.legalBasis,
      retentionDaysApplied: row.retentionDaysApplied,
      deletedCounts: row.deletedCounts,
      totalDeleted: row.totalDeleted,
      executedAt: new Date(row.executedAt).toISOString(),
      previousEntryHash: row.previousEntryHash || null,
    })).digest('hex')
    if (recomputed !== row.entryHash || (row.previousEntryHash || undefined) !== expectedPrevious) {
      return { valid: false, entries: rows.length, brokenAtIndex: index, brokenEntryId: String(row._id) }
    }
    expectedPrevious = row.entryHash
  }
  return { valid: true, entries: rows.length }
}
