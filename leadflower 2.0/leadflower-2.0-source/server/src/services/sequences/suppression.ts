import crypto from 'crypto'
import SuppressionEntry from '../../models/SuppressionEntry'
import { env } from '../../env'
import { recordAudit } from '../audit'
import { normalizeEmail, normalizePhone } from '../batchNormalization'

/**
 * Suppression: the record of who has told this organisation to stop.
 *
 * Once the operator is the sender rather than the CRM, this stops being a
 * courtesy and becomes the control that keeps them lawful under CAN-SPAM,
 * GDPR, TCPA and India's DND/DLT regime. Two rules follow, and both are
 * enforced here rather than left to callers:
 *
 *  - Checked before every send on every channel. `assertNotSuppressed` is the
 *    only sanctioned way to clear a send, and it throws rather than returning a
 *    boolean a caller can forget to read.
 *
 *  - Fails closed. If the digest key is unavailable or the lookup errors, the
 *    send is refused. An outage must not become a burst of mail to people who
 *    unsubscribed.
 */

export const SUPPRESSION_CHANNELS = ['email', 'sms', 'whatsapp'] as const
export type SuppressionChannel = (typeof SUPPRESSION_CHANNELS)[number]

export const SUPPRESSION_REASONS = ['unsubscribed', 'hard_bounce', 'complaint', 'manual', 'invalid_address'] as const
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

/**
 * Domain-separation label for the suppression index key.
 *
 * The digest is keyed on ENCRYPTION_KEY through HKDF rather than on a versioned
 * data key, deliberately. Versioned keys rotate; a rotated suppression digest
 * would no longer match the stored one, and every previously suppressed
 * recipient would silently become contactable again. That is the worst possible
 * failure for this collection, so the digest key is pinned to the root secret
 * and any rotation of ENCRYPTION_KEY itself requires an explicit rehash
 * migration of this collection.
 */
const SUPPRESSION_INDEX_INFO = 'logicflower:suppression-index:v1'

let cachedIndexKey: Buffer | null = null

function suppressionIndexKey(): Buffer {
  if (cachedIndexKey) return cachedIndexKey
  const root = Buffer.from(env.ENCRYPTION_KEY, 'hex')
  cachedIndexKey = Buffer.from(crypto.hkdfSync('sha256', root, Buffer.alloc(0), Buffer.from(SUPPRESSION_INDEX_INFO, 'utf8'), 32))
  return cachedIndexKey
}

/** Test seam: forget the derived key so a changed ENCRYPTION_KEY is picked up. */
export function resetSuppressionIndexKey(): void {
  cachedIndexKey = null
}

/**
 * Canonical form of an address for a channel.
 *
 * Returns an empty string when the value cannot be normalised. An
 * un-normalisable address is never treated as "not suppressed" — callers must
 * refuse the send, because a digest computed over junk matches nothing and
 * would wave through a recipient whose real address is on the list.
 */
export function normaliseAddress(channel: SuppressionChannel, address: string, defaultCountryCode = ''): string {
  const raw = String(address || '').trim()
  if (!raw) return ''
  if (channel === 'email') return normalizeEmail(raw)
  const phone = normalizePhone(raw, defaultCountryCode)
  return phone.startsWith('+') && phone.length >= 8 ? phone : ''
}

/**
 * Keyed digest of a normalised address, scoped to one organisation.
 *
 * Organisation-scoped so the same address in two tenants produces two different
 * digests, and keyed so the collection is not a rainbow-table of phone numbers.
 */
export function suppressionDigest(organizationId: string, channel: SuppressionChannel, normalisedAddress: string): string {
  if (!normalisedAddress) throw new Error('Cannot compute a suppression digest for an empty address')
  return crypto.createHmac('sha256', suppressionIndexKey())
    .update(`${organizationId}|${channel}|${normalisedAddress}`)
    .digest('hex')
}

/** "jane.doe@example.com" -> "j***e@example.com"; "+919876543210" -> "+9198***3210". */
export function addressPreview(channel: SuppressionChannel, normalisedAddress: string): string {
  if (!normalisedAddress) return ''
  if (channel === 'email') {
    const [local = '', domain = ''] = normalisedAddress.split('@')
    if (!domain) return '***'
    const head = local.slice(0, 1)
    const tail = local.length > 2 ? local.slice(-1) : ''
    return `${head}***${tail}@${domain}`
  }
  return normalisedAddress.length <= 8
    ? `${normalisedAddress.slice(0, 2)}***`
    : `${normalisedAddress.slice(0, 5)}***${normalisedAddress.slice(-4)}`
}

export class SuppressedRecipientError extends Error {
  readonly channel: SuppressionChannel
  readonly reason: SuppressionReason | 'unresolvable_address'
  constructor(channel: SuppressionChannel, reason: SuppressionReason | 'unresolvable_address', message: string) {
    super(message)
    this.name = 'SuppressedRecipientError'
    this.channel = channel
    this.reason = reason
  }
}

export interface SuppressionLookup {
  (input: { organizationId: string; channel: SuppressionChannel; addressDigest: string }): Promise<SuppressionReason | null>
}

const mongoLookup: SuppressionLookup = async ({ organizationId, channel, addressDigest }) => {
  const entry: any = await SuppressionEntry.findOne({ organizationId, channel, addressDigest }).select('reason').lean()
  return entry ? (entry.reason as SuppressionReason) : null
}

/**
 * Resolve whether an address may be contacted.
 *
 * Throws on suppression and on an address that cannot be normalised. The lookup
 * is injectable so the enforcement path can be proved in a unit test without a
 * database — the behaviour that must never regress is that every channel is
 * checked, and a fake store proves that as well as a real one.
 */
export async function assertNotSuppressed(input: {
  organizationId: string
  channel: SuppressionChannel
  address: string
  defaultCountryCode?: string
  lookup?: SuppressionLookup
}): Promise<{ normalisedAddress: string; addressDigest: string }> {
  const normalised = normaliseAddress(input.channel, input.address, input.defaultCountryCode)
  if (!normalised) {
    throw new SuppressedRecipientError(
      input.channel,
      'unresolvable_address',
      'Recipient address could not be normalised for this channel, so suppression cannot be verified',
    )
  }
  const digest = suppressionDigest(input.organizationId, input.channel, normalised)
  const reason = await (input.lookup ?? mongoLookup)({ organizationId: input.organizationId, channel: input.channel, addressDigest: digest })
  if (reason) {
    throw new SuppressedRecipientError(input.channel, reason, `Recipient is on the ${input.channel} suppression list (${reason})`)
  }
  return { normalisedAddress: normalised, addressDigest: digest }
}

/**
 * Add an entry. Idempotent: re-suppressing an already suppressed address is a
 * no-op rather than an error, because the callers are webhooks that retry.
 */
export async function addSuppression(input: {
  organizationId: string
  channel: SuppressionChannel
  address: string
  reason: SuppressionReason
  source?: string
  sendRecordId?: string | null
  note?: string
  createdBy?: string
  defaultCountryCode?: string
}): Promise<{ created: boolean; addressDigest: string }> {
  const normalised = normaliseAddress(input.channel, input.address, input.defaultCountryCode)
  if (!normalised) throw new Error('Cannot suppress an address that cannot be normalised')
  const addressDigest = suppressionDigest(input.organizationId, input.channel, normalised)
  const result = await SuppressionEntry.updateOne(
    { organizationId: input.organizationId, channel: input.channel, addressDigest },
    {
      $setOnInsert: {
        organizationId: input.organizationId,
        channel: input.channel,
        addressDigest,
        addressPreview: addressPreview(input.channel, normalised),
        reason: input.reason,
        source: input.source || 'system',
        sendRecordId: input.sendRecordId || null,
        note: input.note,
        createdBy: input.createdBy,
      },
    },
    { upsert: true },
  )
  const created = Number((result as any).upsertedCount || 0) > 0
  if (created) {
    await recordAudit({
      organizationId: input.organizationId,
      actorType: input.createdBy ? 'user' : 'system',
      actorUserId: input.createdBy,
      action: 'suppression.added',
      entityType: 'SuppressionEntry',
      entityId: addressDigest,
      // The address itself is deliberately absent from the audit metadata.
      metadata: { channel: input.channel, reason: input.reason, source: input.source || 'system' },
    })
  }
  return { created, addressDigest }
}

/**
 * Removal exists because a genuinely mistaken entry — a mistyped manual add, a
 * bounce from a since-fixed mail server — otherwise becomes permanent. It is
 * restricted to entries an operator created or a soft signal, and it is always
 * audited. An entry created by an explicit unsubscribe is never removable here:
 * only the recipient can reverse their own request, through a fresh opt-in
 * recorded as consent, which is not this endpoint.
 */
export async function removeSuppression(input: {
  organizationId: string
  channel: SuppressionChannel
  addressDigest: string
  removedBy: string
  note?: string
}): Promise<{ removed: boolean; refusedReason?: SuppressionReason }> {
  const entry: any = await SuppressionEntry.findOne({
    organizationId: input.organizationId,
    channel: input.channel,
    addressDigest: input.addressDigest,
  }).select('reason').lean()
  if (!entry) return { removed: false }
  if (entry.reason === 'unsubscribed' || entry.reason === 'complaint') {
    return { removed: false, refusedReason: entry.reason as SuppressionReason }
  }
  await SuppressionEntry.deleteOne({
    organizationId: input.organizationId,
    channel: input.channel,
    addressDigest: input.addressDigest,
  })
  await recordAudit({
    organizationId: input.organizationId,
    actorType: 'user',
    actorUserId: input.removedBy,
    action: 'suppression.removed',
    entityType: 'SuppressionEntry',
    entityId: input.addressDigest,
    metadata: { channel: input.channel, previousReason: entry.reason, note: input.note },
  })
  return { removed: true }
}
