import Contact from '../../models/Contact'
import PlatformConnection from '../../models/PlatformConnection'
import PollCursor from '../../models/PollCursor'
import { createConnector, type ConnectorProvider } from '../connectors'
import { normalizeEmail, normalizePhone } from '../batchNormalization'
import { recordAudit } from '../audit'
import pino from '../../logger'
import { enrolContact } from './enrolmentService'

/**
 * Pulling leads out of an external CRM and into a local sequence.
 *
 * This is the Type A path: the customer keeps HighLevel or HubSpot as their
 * system of record, and LeadFlower runs the follow-up so the CRM executes no
 * workflow and charges no per-action fee. Every contact pulled becomes a local
 * Contact and every sequence runs off that local record, which is what makes
 * Type A and Type B the same product rather than two.
 *
 * WHAT IS IMPLEMENTED
 *
 * A durable, resumable page walk with id-based de-duplication. The cursor is
 * persisted only after a page has been fully processed, never before, so a
 * crash mid-page re-processes that page rather than stepping over it. Rate
 * limiting and circuit breaking come free from `PolicyConnectorTransport`,
 * which every connector is already wrapped in.
 *
 * WHAT IS NOT IMPLEMENTED, AND WHY
 *
 * An incremental "modified since <timestamp>" query. The specification asks for
 * a time window with a slight overlap, and that is the right design — it is the
 * difference between reading the pages that changed and re-walking an entire
 * contact list on every run. It is not built because no connector in this
 * repository exposes a date-filtered contact query, and the endpoints that
 * would provide one differ per provider and are not the endpoints currently in
 * use: HighLevel's contact search and HubSpot's CRM search API both take
 * filter structures that would have to be guessed from memory. Guessing them
 * risks silently returning a filtered subset and skipping leads, which is worse
 * than re-walking pages.
 *
 * To complete it, the following are needed:
 *
 *  1. Current HighLevel contact-search documentation: the endpoint, the date
 *     filter field name, and whether it filters on created or modified time.
 *  2. Current HubSpot CRM search documentation for the `lastmodifieddate`
 *     filter, including its pagination limits, which differ from the list API.
 *  3. Confirmation of each provider's timestamp semantics — specifically
 *     whether the returned value is the modification time or the indexing time,
 *     since the two diverge under load and an overlap window sized for the
 *     wrong one drops records.
 *
 * Until then this runs correctly but reads more than it needs to, and
 * `MAX_PAGES_PER_RUN` exists to bound that cost.
 */

/** Pages walked per run. Bounds provider quota spend on a large account. */
const MAX_PAGES_PER_RUN = 5
const PAGE_SIZE = 100
/** Bounded de-duplication memory. Sized well above one run's page walk. */
const SEEN_ID_LIMIT = 5_000

export interface PollResult {
  scanned: number
  enrolled: number
  skippedAlreadySeen: number
  skippedNotEnrollable: number
  pagesWalked: number
  exhausted: boolean
  /** Present when the run stopped early because sending is not possible. */
  haltedReason?: string
}

function cursorKey(sequenceId: string): string {
  return `sequence:${sequenceId}`
}

/**
 * Create or update the local mirror of an external contact.
 *
 * Keyed on (organizationId, connectionId, ghlId), the unique sparse index the
 * Contact model already carries, so a re-walk updates rather than duplicates.
 */
async function upsertLocalContact(input: {
  organizationId: string
  connectionId: string
  externalId: string
  record: { email?: string; phone?: string; firstName?: string; lastName?: string; name?: string }
}): Promise<string | null> {
  const email = normalizeEmail(String(input.record.email || ''))
  const phone = normalizePhone(String(input.record.phone || ''), '')
  // A record with no reachable address cannot be sent to on any channel, so
  // mirroring it would create a contact that every sequence immediately exits.
  if (!email && !phone.startsWith('+')) return null

  const result: any = await Contact.findOneAndUpdate(
    { organizationId: input.organizationId, connectionId: input.connectionId, ghlId: input.externalId },
    {
      $set: {
        ...(email ? { email } : {}),
        ...(phone.startsWith('+') ? { phone } : {}),
        ...(input.record.firstName ? { firstName: input.record.firstName } : {}),
        ...(input.record.lastName ? { lastName: input.record.lastName } : {}),
        ...(input.record.name ? { name: input.record.name } : {}),
      },
      $setOnInsert: {
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        ghlId: input.externalId,
        source: 'crm_poll',
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).select('_id').lean()
  return result ? String(result._id) : null
}

/**
 * Run one polling pass for one connection into one sequence.
 *
 * Ordering note, because it is the property that stops leads being lost: a
 * contact is enrolled first, and only then recorded as seen and the page cursor
 * advanced. The inverse ordering — advance, then enrol — loses every contact on
 * a page if the process dies between the two, and leaves no evidence it
 * happened.
 */
export async function runPollingTrigger(input: {
  organizationId: string
  connectionId: string
  sequenceId: string
  maxPages?: number
}): Promise<PollResult> {
  const result: PollResult = { scanned: 0, enrolled: 0, skippedAlreadySeen: 0, skippedNotEnrollable: 0, pagesWalked: 0, exhausted: false }

  const connection: any = await PlatformConnection.findOne({
    _id: input.connectionId,
    organizationId: input.organizationId,
    status: { $in: ['active', 'degraded'] },
  }).select('provider').lean()
  if (!connection) {
    result.haltedReason = 'connection_unavailable'
    return result
  }

  const provider = connection.provider as ConnectorProvider
  const connector = await createConnector({ organizationId: input.organizationId, provider, connectionId: input.connectionId })
  if (typeof connector.listContactsPage !== 'function') {
    result.haltedReason = 'provider_cannot_list_contacts'
    return result
  }

  const key = cursorKey(input.sequenceId)
  const cursorDocument: any = await PollCursor.findOneAndUpdate(
    { organizationId: input.organizationId, connectionId: input.connectionId, provider, key },
    { $setOnInsert: { organizationId: input.organizationId, connectionId: input.connectionId, provider, key } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean()

  const seen = new Set<string>((cursorDocument?.seenExternalIds || []).map(String))
  let pageCursor: string | undefined = cursorDocument?.pageCursor || undefined
  const maxPages = Math.max(1, Math.min(input.maxPages ?? MAX_PAGES_PER_RUN, 50))

  for (let page = 0; page < maxPages; page += 1) {
    const response = await connector.listContactsPage(pageCursor, PAGE_SIZE)
    result.pagesWalked += 1
    const contacts = response?.contacts || []
    result.scanned += contacts.length

    const enrolledThisPage: string[] = []
    for (const record of contacts) {
      const externalId = String(record?.id || '').trim()
      if (!externalId) { result.skippedNotEnrollable += 1; continue }
      if (seen.has(externalId)) { result.skippedAlreadySeen += 1; continue }

      const contactId = await upsertLocalContact({
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        externalId,
        record,
      })
      if (!contactId) { result.skippedNotEnrollable += 1; continue }

      const enrolment = await enrolContact({
        organizationId: input.organizationId,
        sequenceId: input.sequenceId,
        contactId,
        source: `crm_poll:${provider}`,
      })
      if (enrolment.skippedReason === 'sequence_not_active') {
        // Stop the whole run. Continuing would burn provider quota walking
        // pages that cannot produce an enrolment, and would advance the cursor
        // past leads that a later activation should have picked up.
        result.haltedReason = 'sequence_not_active'
        break
      }
      if (enrolment.created) result.enrolled += 1
      // Recorded as seen whether newly enrolled or already enrolled: both mean
      // this external record has been dealt with.
      enrolledThisPage.push(externalId)
      seen.add(externalId)
    }

    // Persist AFTER the page has been processed, never before.
    const boundedSeen = [...enrolledThisPage.reverse(), ...(cursorDocument?.seenExternalIds || []).map(String)]
      .filter((value, index, all) => all.indexOf(value) === index)
      .slice(0, SEEN_ID_LIMIT)

    pageCursor = response?.nextCursor
    await PollCursor.updateOne(
      { organizationId: input.organizationId, connectionId: input.connectionId, provider, key },
      {
        $set: {
          pageCursor: pageCursor || null,
          seenExternalIds: boundedSeen,
          lastRunAt: new Date(),
          lastEnrolledCount: result.enrolled,
          exhausted: !pageCursor,
          cursor: Date.now(),
        },
      },
    )

    if (result.haltedReason) break
    if (!pageCursor) { result.exhausted = true; break }
  }

  if (result.enrolled > 0 || result.haltedReason) {
    await recordAudit({
      organizationId: input.organizationId,
      actorType: 'system',
      action: 'sequence.poll_completed',
      entityType: 'PollCursor',
      entityId: `${input.connectionId}:${key}`,
      metadata: { provider, sequenceId: input.sequenceId, ...result },
    })
  }
  pino.info({ organizationId: input.organizationId, provider, sequenceId: input.sequenceId, ...result }, 'sequence polling trigger complete')
  return result
}
