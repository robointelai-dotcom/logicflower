import crypto from 'crypto'
import Contact from '../../models/Contact'
import DialerJob from '../../models/DialerJob'
import Organization from '../../models/Organization'
import VoiceAgent from '../../models/VoiceAgent'
import VoiceAgentVersion from '../../models/VoiceAgentVersion'
import VoiceCall from '../../models/VoiceCall'
import { env } from '../../env'
import pino from '../../logger'
import { recordAudit } from '../audit'
import { recordActivity } from '../crm/contactActivity'
import { assertNotSuppressed, SuppressedRecipientError } from '../sequences/suppression'
import { CONSERVATIVE_WINDOW, type JurisdictionPolicy } from './callingWindows'
import { evaluateDialGates, isDeferrable, telephonyProvider, VoiceProviderUnavailableError } from './voiceProvider'

/**
 * The outbound dialer.
 *
 * Runs the gate chain, records what it decided, and then attempts the call.
 * In this build the attempt always refuses, because no telephony provider is
 * implemented — but every gate still runs and every decision is still recorded.
 *
 * That is not busywork. It means an operator can enable the dialer against real
 * contacts, watch what it *would* have done, and see which calls their
 * configuration blocks and why, before a single phone rings. Given this is the
 * most regulated subsystem in the product, being able to dry-run the gates
 * against real data is worth more than the provider integration.
 *
 * `DIALER_DRY_RUN` makes that explicit: gates run, decisions are recorded, and
 * the provider is never called at all.
 */

const LEASE_OWNER = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`

export interface DialerTickResult {
  claimed: number
  placed: number
  blocked: number
  deferred: number
  failed: number
  outcomeUnknown: number
}

/** An organisation's calling policy, defaulting to the conservative window. */
export async function callingPolicyFor(organizationId: string): Promise<JurisdictionPolicy> {
  const organization: any = await Organization.findOne({ _id: organizationId }).select('callingPolicy').lean()
  const configured = organization?.callingPolicy
  if (!configured?.window) {
    return {
      label: 'Default (unreviewed)',
      window: { ...CONSERVATIVE_WINDOW, permittedWeekdays: [...CONSERVATIVE_WINDOW.permittedWeekdays] },
      blackoutDates: [],
      legalReviewRecordedBy: null,
      legalReviewedAt: null,
    }
  }
  return {
    label: String(configured.label || 'Configured'),
    window: {
      startMinute: Number(configured.window.startMinute),
      endMinute: Number(configured.window.endMinute),
      permittedWeekdays: (configured.window.permittedWeekdays || []).map(Number),
    },
    blackoutDates: (configured.blackoutDates || []).map(String),
    legalReviewRecordedBy: configured.legalReviewRecordedBy || null,
    legalReviewedAt: configured.legalReviewedAt || null,
  }
}

/**
 * Recover abandoned leases.
 *
 * Same two-stage semantics as every other worker here, and the `dial_started`
 * case matters most of all: a call may already be ringing a real phone, and a
 * blind retry rings it twice.
 */
async function recoverExpiredLeases(now: Date): Promise<void> {
  // tenant-safe: cross-tenant lease-recovery sweep; each job carries its own organisation
  await DialerJob.updateMany(
    { status: 'processing', leaseStage: 'before_dial', leaseExpiresAt: { $lt: now } },
    { $set: { status: 'pending' }, $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 } },
  )
  // tenant-safe: cross-tenant lease-recovery sweep; each job carries its own organisation
  await DialerJob.updateMany(
    { status: 'processing', leaseStage: 'dial_started', leaseExpiresAt: { $lt: now } },
    {
      $set: {
        status: 'outcome_unknown',
        lastError: { code: 'LEASE_EXPIRED_AFTER_DIAL', message: 'Worker stopped after dialling began; a call may have been placed', at: now },
      },
      $unset: { leaseExpiresAt: 1, leaseOwner: 1 },
    },
  )
}

async function runOneJob(job: any, now: Date, result: DialerTickResult): Promise<void> {
  const organizationId = String(job.organizationId)

  const contact: any = await Contact.findOne({ _id: job.contactId, organizationId }).select('phone timezone firstName lastName name companyName').lean()
  if (!contact?.phone) {
    await DialerJob.updateOne({ _id: job._id, organizationId }, {
      $set: { status: 'blocked', blockedReason: 'no_phone_number' },
      $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 },
    })
    result.blocked += 1
    return
  }

  const agent: any = await VoiceAgent.findOne({ _id: job.voiceAgentId, organizationId }).lean()
  const version: any = agent?.publishedVersionId
    ? await VoiceAgentVersion.findOne({ _id: agent.publishedVersionId, organizationId }).lean()
    : null
  if (!agent || agent.status !== 'active' || !version) {
    await DialerJob.updateOne({ _id: job._id, organizationId }, {
      $set: { status: 'blocked', blockedReason: 'agent_not_active' },
      $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 },
    })
    result.blocked += 1
    return
  }

  const policy = await callingPolicyFor(organizationId)
  const decision = await evaluateDialGates({
    now,
    organizationId,
    phoneNumber: String(contact.phone),
    timeZone: contact.timezone,
    jurisdiction: String(policy.label),
    policy,
    suppressionCheck: async () => {
      try {
        await assertNotSuppressed({ organizationId, channel: 'sms', address: String(contact.phone) })
        return null
      } catch (error) {
        if (error instanceof SuppressedRecipientError) return error.reason
        throw error
      }
    },
    // Consent is an explicit organisation-level assertion, not inferred from
    // the existence of a phone number. A number in a CRM is not permission.
    hasConsentRecord: Boolean(job.consentRecorded),
  })

  // The call record is written whatever the decision, so a blocked call is
  // visible and auditable rather than a job that quietly went nowhere.
  const call: any = await VoiceCall.create({
    organizationId,
    contactId: job.contactId,
    dealId: job.dealId || null,
    voiceAgentId: agent._id,
    voiceAgentVersionId: version._id,
    agentDefinitionHash: version.definitionHash,
    direction: 'outbound',
    status: decision.permitted ? 'dialing' : 'blocked',
    blockedReason: decision.permitted ? undefined : `${decision.reason}: ${decision.detail}`,
    toNumberPreview: String(contact.phone).replace(/.(?=.{4})/g, '*'),
    disclosures: { recordingEnabled: Boolean(version.disclosures?.recordingEnabled) },
  })

  await recordAudit({
    organizationId,
    actorType: 'system',
    action: decision.permitted ? 'voice.call_permitted' : 'voice.call_blocked',
    entityType: 'VoiceCall',
    entityId: String(call._id),
    // Every gate evaluated, not just the failing one. When a regulator asks
    // whether the DND registry was consulted, this is the answer.
    metadata: { reason: decision.reason, gates: decision.evaluated, policy: policy.label },
  })

  if (!decision.permitted) {
    if (isDeferrable(decision.reason) && decision.deferUntil) {
      await DialerJob.updateOne({ _id: job._id, organizationId }, {
        $set: { status: 'pending', earliestAt: decision.deferUntil, voiceCallId: call._id },
        $inc: { deferralCount: 1, attempts: -1 },
        $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 },
      })
      result.deferred += 1
      return
    }
    await DialerJob.updateOne({ _id: job._id, organizationId }, {
      $set: { status: 'blocked', blockedReason: decision.reason, voiceCallId: call._id },
      $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 },
    })
    await recordActivity({
      organizationId, contactId: String(job.contactId), type: 'call.blocked',
      summary: `Outbound call blocked: ${decision.reason}`,
      entityType: 'VoiceCall', entityId: String(call._id),
      metadata: { reason: decision.reason }, occurredAt: now,
    })
    result.blocked += 1
    return
  }

  if (env.DIALER_DRY_RUN) {
    // Gates ran, the decision is recorded, no provider is touched. This is how
    // an operator validates their configuration against real contacts before a
    // single phone rings.
    await DialerJob.updateOne({ _id: job._id, organizationId }, {
      $set: { status: 'completed', voiceCallId: call._id },
      $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 },
    })
    await VoiceCall.updateOne({ _id: call._id, organizationId }, {
      $set: { status: 'cancelled', blockedReason: 'dry_run: gates passed, no call placed' },
    })
    result.placed += 1
    return
  }

  // Move the lease before touching the provider. Past this point a call may
  // exist, and an expired lease resolves to outcome_unknown rather than retry.
  const moved = await DialerJob.updateOne(
    { _id: job._id, organizationId, status: 'processing', leaseStage: 'before_dial', leaseOwner: LEASE_OWNER },
    { $set: { leaseStage: 'dial_started', leaseExpiresAt: new Date(now.getTime() + 120_000) } },
  )
  if (!Number((moved as any).modifiedCount || 0)) return

  try {
    const placed = await telephonyProvider.placeCall({
      organizationId,
      toNumber: String(contact.phone),
      fromNumber: String(job.fromNumber || ''),
      voiceCallId: String(call._id),
      maxDurationSeconds: Number(version.maxCallSeconds || 300),
      recordingEnabled: Boolean(version.disclosures?.recordingEnabled),
    })
    await VoiceCall.updateOne({ _id: call._id, organizationId }, {
      $set: { providerCallId: placed.providerCallId, startedAt: new Date() },
    })
    await DialerJob.updateOne({ _id: job._id, organizationId }, {
      $set: { status: 'completed', voiceCallId: call._id },
      $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 },
    })
    result.placed += 1
  } catch (error: any) {
    const unavailable = error instanceof VoiceProviderUnavailableError
    await VoiceCall.updateOne({ _id: call._id, organizationId }, {
      $set: { status: 'failed', lastError: { code: unavailable ? 'PROVIDER_UNIMPLEMENTED' : 'DIAL_FAILED', message: String(error?.message || '').slice(0, 500), at: now } },
    })
    await DialerJob.updateOne({ _id: job._id, organizationId }, {
      $set: {
        // A provider that does not exist is not a transient failure. Retrying
        // it on a schedule produces noise, not calls.
        status: unavailable ? 'blocked' : (job.attempts >= job.maxAttempts ? 'failed' : 'pending'),
        blockedReason: unavailable ? 'provider_unimplemented' : undefined,
        lastError: { code: unavailable ? 'PROVIDER_UNIMPLEMENTED' : 'DIAL_FAILED', message: String(error?.message || '').slice(0, 500), at: now },
      },
      $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 },
    })
    if (unavailable) result.blocked += 1
    else result.failed += 1
  }
}

export async function runDialerTick(options: { max?: number } = {}): Promise<DialerTickResult> {
  const now = new Date()
  const result: DialerTickResult = { claimed: 0, placed: 0, blocked: 0, deferred: 0, failed: 0, outcomeUnknown: 0 }
  await recoverExpiredLeases(now)

  const max = Math.max(1, Math.min(options.max ?? env.DIALER_BATCH, 100))
  for (let index = 0; index < max; index += 1) {
    // tenant-safe: cross-tenant dialer claiming the next due job; each job carries its own organisation
    const claimed: any = await DialerJob.findOneAndUpdate(
      { status: 'pending', earliestAt: { $lte: now } },
      {
        $set: { status: 'processing', leaseStage: 'before_dial', leaseExpiresAt: new Date(now.getTime() + 120_000), leaseOwner: LEASE_OWNER },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { earliestAt: 1 } },
    ).lean()
    if (!claimed) break
    result.claimed += 1
    try {
      await runOneJob(claimed, now, result)
    } catch (error) {
      pino.error({ err: error, dialerJobId: String(claimed._id) }, 'dialer job failed unexpectedly')
      await DialerJob.updateOne({ _id: claimed._id, organizationId: String(claimed.organizationId) }, {
        $set: { status: 'failed', lastError: { code: 'DIALER_ERROR', message: String((error as any)?.message || '').slice(0, 500), at: now } },
        $unset: { leaseExpiresAt: 1, leaseStage: 1, leaseOwner: 1 },
      })
      result.failed += 1
    }
  }

  if (result.claimed > 0) pino.info({ ...result, dryRun: env.DIALER_DRY_RUN }, 'dialer tick complete')
  return result
}
