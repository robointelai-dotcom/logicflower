import PlatformConnection from '../models/PlatformConnection'
import NotificationChannel from '../models/NotificationChannel'
import WebhookKey from '../models/WebhookKey'
import { activeKeyVersion, keyringStatus } from '../security/keyring'
import { envelopeKeyVersion, needsRewrap, rewrapString } from '../security/encryption'
import pino from '../logger'

/**
 * Background re-wrap of stored ciphertext onto the active data-key version.
 *
 * This is explicitly *not* a cutover. Rotation is already complete the moment
 * a new key version becomes active: new writes use it, and old ciphertext keeps
 * decrypting under the version recorded in its own envelope. Re-wrapping only
 * shortens the tail of data still protected by an older key.
 *
 * Consequences of that design worth stating, because they are the reason it is
 * zero-downtime:
 *
 *  - The job can be interrupted at any point and resumed. There is no window
 *    in which a record is unreadable.
 *  - A failure on one record does not block the others.
 *  - Running it twice is harmless.
 *
 * `credentialVersion` on PlatformConnection is bumped alongside the re-wrap so
 * an operator can see how much of the estate is on the current key.
 */

export interface RewrapTarget {
  label: string
  /** Fields holding ciphertext, with the associated-data builder for each. */
  run: (limit: number) => Promise<{ scanned: number; rewrapped: number; failed: number }>
}

export interface RotationReport {
  activeKeyVersion: number
  provider: string
  targets: Array<{ label: string; scanned: number; rewrapped: number; failed: number }>
  totals: { scanned: number; rewrapped: number; failed: number }
  complete: boolean
}

async function rewrapConnections(limit: number) {
  let scanned = 0; let rewrapped = 0; let failed = 0
  // tenant-safe: key re-wrap is an estate-wide maintenance operation across all organisations
  const rows: any[] = await PlatformConnection.find({})
    .select('+encryptedCredentials +credentialVersion organizationId')
    .limit(limit)
  for (const row of rows) {
    scanned += 1
    try {
      if (!row.encryptedCredentials || !needsRewrap(row.encryptedCredentials)) continue
      const aad = `connection:${String(row.organizationId)}:${String(row._id)}`
      row.encryptedCredentials = rewrapString(row.encryptedCredentials, aad)
      row.credentialVersion = activeKeyVersion()
      await row.save()
      rewrapped += 1
    } catch {
      failed += 1
      // Never log the ciphertext or the identifier's contents; the record id is
      // enough for an operator to investigate.
      pino.warn({ connectionId: String(row._id) }, 'connection credential re-wrap failed')
    }
  }
  return { scanned, rewrapped, failed }
}

function simpleTarget(label: string, model: any, field: string, selectExtra: string, aad: (row: any) => string): RewrapTarget {
  return {
    label,
    run: async (limit: number) => {
      let scanned = 0; let rewrapped = 0; let failed = 0
      const rows: any[] = await model.find({}).select(`+${field} ${selectExtra}`).limit(limit)
      for (const row of rows) {
        scanned += 1
        try {
          const value = row[field]
          if (!value || !needsRewrap(value)) continue
          row[field] = rewrapString(value, aad(row))
          await row.save()
          rewrapped += 1
        } catch {
          failed += 1
          pino.warn({ model: label, id: String(row._id) }, 'ciphertext re-wrap failed')
        }
      }
      return { scanned, rewrapped, failed }
    },
  }
}

export function rewrapTargets(): RewrapTarget[] {
  return [
    { label: 'PlatformConnection.encryptedCredentials', run: rewrapConnections },
    simpleTarget('WebhookKey.hmacSecretCiphertext', WebhookKey, 'hmacSecretCiphertext', 'organizationId',
      (row) => `webhook-key:${String(row.organizationId)}:${String(row._id)}`),
    simpleTarget('NotificationChannel.secretCiphertext', NotificationChannel, 'secretCiphertext', 'organizationId',
      (row) => `notification-channel:${String(row.organizationId)}:${String(row._id)}`),
  ]
}

export async function runKeyRotationRewrap(limitPerTarget = 500): Promise<RotationReport> {
  const status = keyringStatus()
  const targets: RotationReport['targets'] = []
  for (const target of rewrapTargets()) {
    const result = await target.run(limitPerTarget)
    targets.push({ label: target.label, ...result })
  }
  const totals = targets.reduce((sum, item) => ({
    scanned: sum.scanned + item.scanned,
    rewrapped: sum.rewrapped + item.rewrapped,
    failed: sum.failed + item.failed,
  }), { scanned: 0, rewrapped: 0, failed: 0 })
  return {
    activeKeyVersion: status.activeVersion,
    provider: status.provider,
    targets,
    totals,
    complete: totals.rewrapped === 0 && totals.failed === 0,
  }
}

/** Count of records still protected by a non-active key version, for monitoring. */
export async function rotationBacklog(): Promise<{ activeKeyVersion: number; stale: number; legacy: number }> {
  // tenant-safe: key re-wrap is an estate-wide maintenance operation across all organisations
  const rows: any[] = await PlatformConnection.find({}).select('+encryptedCredentials').lean()
  let stale = 0; let legacy = 0
  for (const row of rows) {
    if (!row.encryptedCredentials) continue
    const version = envelopeKeyVersion(row.encryptedCredentials)
    if (version === 0) legacy += 1
    else if (version !== activeKeyVersion()) stale += 1
  }
  return { activeKeyVersion: activeKeyVersion(), stale, legacy }
}
