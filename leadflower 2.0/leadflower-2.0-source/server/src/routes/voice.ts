import { Router } from 'express'
import { Types } from 'mongoose'
import Contact from '../models/Contact'
import DialerJob from '../models/DialerJob'
import Organization from '../models/Organization'
import VoiceAgent from '../models/VoiceAgent'
import VoiceAgentVersion from '../models/VoiceAgentVersion'
import VoiceCall from '../models/VoiceCall'
import { env } from '../env'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor'
import { requireOrganizationId } from '../types/authenticatedRequest'
import { decryptString } from '../security/encryption'
import { recordAudit } from '../services/audit'
import {
  AgentDefinitionError,
  agentDefinitionHash,
  canonicaliseAgentDefinition,
  openingDisclosures,
  PERMITTED_VARIABLES,
} from '../services/voice/agentDefinition'
import {
  assertValidWindow,
  CONSERVATIVE_WINDOW,
  isWiderThanDefault,
} from '../services/voice/callingWindows'
import { callingPolicyFor } from '../services/voice/dialer'
import { evaluateDialGates, voiceProviderStatus } from '../services/voice/voiceProvider'
import { assertNotSuppressed, SuppressedRecipientError } from '../services/sequences/suppression'

const router = Router()

function objectId(value: unknown, label: string): string {
  const id = String(value || '')
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, `Invalid ${label}`, `${label} identifier is invalid`)
  return id
}

function requireOperator(req: any): void {
  if (!['owner', 'admin', 'operator'].includes(String(req.auth?.role || ''))) {
    throw new HttpError(403, 'Insufficient role', 'Owner, admin, or operator role is required')
  }
}

/** Only an owner or admin may change what the system is permitted to do legally. */
function requireManager(req: any): void {
  if (!['owner', 'admin'].includes(String(req.auth?.role || ''))) {
    throw new HttpError(403, 'Insufficient role', 'Owner or admin role is required to change calling policy')
  }
}

/* ------------------------------------------------------------------- status */

router.get('/status', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const policy = await callingPolicyFor(organizationId)
  res.json({
    providers: voiceProviderStatus(),
    dialer: {
      enabled: env.DIALER_ENABLED,
      // Surfaced prominently: an operator must know whether gates are being
      // evaluated for practice or for real.
      dryRun: env.DIALER_DRY_RUN,
      note: env.DIALER_DRY_RUN
        ? 'Dry run is ON. Every gate is evaluated and every decision recorded, and no call is placed.'
        : 'Dry run is OFF. Calls will be attempted once a telephony provider is implemented.',
    },
    callingPolicy: {
      label: policy.label,
      window: policy.window,
      blackoutDates: policy.blackoutDates,
      widerThanDefault: isWiderThanDefault(policy.window),
      legalReviewRecordedBy: policy.legalReviewRecordedBy,
      legalReviewedAt: policy.legalReviewedAt,
    },
    permittedPromptVariables: PERMITTED_VARIABLES,
  })
}))

/* ----------------------------------------------------------- calling policy */

/**
 * Set the calling policy.
 *
 * Widening beyond the conservative default requires `legalReviewRecordedBy`.
 * The software does not get to decide that 07:00 calls are acceptable; a named
 * person does, and their name is stored against the decision.
 */
router.put('/calling-policy', asyncHandler(async (req, res) => {
  requireManager(req)
  const organizationId = requireOrganizationId(req)

  const window = {
    startMinute: Number(req.body?.window?.startMinute ?? CONSERVATIVE_WINDOW.startMinute),
    endMinute: Number(req.body?.window?.endMinute ?? CONSERVATIVE_WINDOW.endMinute),
    permittedWeekdays: Array.isArray(req.body?.window?.permittedWeekdays)
      ? req.body.window.permittedWeekdays.map(Number)
      : [...CONSERVATIVE_WINDOW.permittedWeekdays],
  }
  try { assertValidWindow(window) } catch (error: any) {
    throw new HttpError(400, 'Invalid calling window', String(error?.message || 'invalid'), problemType('calling-window-invalid'))
  }

  const reviewer = req.body?.legalReviewRecordedBy ? String(req.body.legalReviewRecordedBy).slice(0, 200) : null
  if (isWiderThanDefault(window) && !reviewer) {
    throw new HttpError(
      409,
      'Legal review required',
      'This window is wider than the conservative default. Record who reviewed the legal position for calling hours in this jurisdiction before widening it.',
      problemType('calling-window-unreviewed'),
    )
  }

  const blackoutDates = (Array.isArray(req.body?.blackoutDates) ? req.body.blackoutDates : [])
    .map((date: unknown) => String(date).slice(0, 10))
    .filter((date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .slice(0, 100)

  await Organization.updateOne({ _id: organizationId }, {
    $set: {
      callingPolicy: {
        label: String(req.body?.label || 'Configured').slice(0, 200),
        window,
        blackoutDates,
        legalReviewRecordedBy: reviewer,
        legalReviewedAt: reviewer ? new Date() : null,
      },
    },
  })
  await recordAudit({
    req, organizationId, action: 'voice.calling_policy_updated',
    entityType: 'Organization', entityId: organizationId,
    metadata: { window, widerThanDefault: isWiderThanDefault(window), legalReviewRecordedBy: reviewer },
  })
  res.json({ updated: true, widerThanDefault: isWiderThanDefault(window) })
}))

/* -------------------------------------------------------------------- agents */

router.get('/agents', asyncHandler(async (req, res) => {
  const rows: any[] = await VoiceAgent.find({ organizationId: requireOrganizationId(req) }).sort({ _id: -1 }).limit(100).lean()
  res.json({
    agents: rows.map((row) => ({
      id: String(row._id), name: row.name, description: row.description, status: row.status,
      latestVersion: Number(row.latestVersion || 0),
      publishedVersionId: row.publishedVersionId ? String(row.publishedVersionId) : null,
    })),
  })
}))

router.post('/agents', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const name = String(req.body?.name || '').trim().slice(0, 120)
  if (!name) throw new HttpError(400, 'Name required', 'An agent name is required')
  try {
    const created: any = await VoiceAgent.create({ organizationId, name, description: req.body?.description, status: 'draft', createdBy: req.auth?.userId })
    res.status(201).json({ id: String(created._id), name, status: 'draft' })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Agent already exists', 'An agent with that name already exists', problemType('voice-agent-duplicate'))
    throw error
  }
}))

/**
 * Publish an immutable version.
 *
 * Pinned per call. After a complaint the question is "what exactly did it say",
 * and the answer must be a document nobody could have edited since.
 */
router.post('/agents/:agentId/versions', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const agentId = objectId(req.params.agentId, 'agent')

  const agent: any = await VoiceAgent.findOne({ _id: agentId, organizationId }).lean()
  if (!agent) throw new HttpError(404, 'Agent not found', 'No agent with that identifier exists in this organisation')

  let definition
  try {
    definition = canonicaliseAgentDefinition({ name: agent.name, ...(req.body?.definition ?? req.body) })
  } catch (error) {
    if (error instanceof AgentDefinitionError) throw new HttpError(400, 'Agent definition is invalid', error.issues.join('; '), problemType('voice-agent-invalid'))
    throw error
  }

  const version = Number(agent.latestVersion || 0) + 1
  const created: any = await VoiceAgentVersion.create({
    organizationId, voiceAgentId: agentId, version,
    definitionHash: agentDefinitionHash(definition),
    prompt: definition.prompt, voiceId: definition.voiceId, language: definition.language,
    permittedActions: definition.permittedActions, maxCallSeconds: definition.maxCallSeconds,
    disclosures: definition.disclosures, createdBy: req.auth?.userId,
  })
  await VoiceAgent.updateOne({ _id: agentId, organizationId }, { $set: { latestVersion: version, publishedVersionId: created._id } })
  await recordAudit({ req, organizationId, action: 'voice.agent_version_published', entityType: 'VoiceAgentVersion', entityId: String(created._id), metadata: { version, definitionHash: created.definitionHash } })

  res.status(201).json({
    versionId: String(created._id), version, definitionHash: created.definitionHash,
    // Returned so an operator sees exactly what will be spoken before the
    // conversation begins, rather than trusting it is in there somewhere.
    openingDisclosures: openingDisclosures(definition),
  })
}))

router.post('/agents/:agentId/status', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const agentId = objectId(req.params.agentId, 'agent')
  const status = String(req.body?.status || '')
  if (!['draft', 'active', 'paused', 'archived'].includes(status)) throw new HttpError(400, 'Invalid status', 'Status must be draft, active, paused or archived')

  const agent: any = await VoiceAgent.findOne({ _id: agentId, organizationId }).lean()
  if (!agent) throw new HttpError(404, 'Agent not found', 'No agent with that identifier exists in this organisation')
  if (status === 'active' && !agent.publishedVersionId) {
    throw new HttpError(409, 'No published version', 'Publish a version before activating this agent', problemType('voice-agent-version-missing'))
  }
  await VoiceAgent.updateOne({ _id: agentId, organizationId }, { $set: { status } })
  await recordAudit({ req, organizationId, action: 'voice.agent_status_changed', entityType: 'VoiceAgent', entityId: agentId, metadata: { from: agent.status, to: status } })
  res.json({ id: agentId, status })
}))

/* -------------------------------------------------------------------- dialer */

/**
 * Evaluate the gates for a contact WITHOUT queueing anything.
 *
 * The most useful endpoint here. An operator can ask "would this call be
 * allowed, and if not why" for any contact, at any time, and get every gate
 * back with its verdict — before committing to anything.
 */
router.post('/dialer/preflight', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.body?.contactId, 'contact')

  const contact: any = await Contact.findOne({ _id: contactId, organizationId }).select('phone timezone').lean()
  if (!contact) throw new HttpError(404, 'Contact not found', 'No contact with that identifier exists in this organisation')
  if (!contact.phone) return res.json({ permitted: false, reason: 'no_phone_number', evaluated: [] })

  const policy = await callingPolicyFor(organizationId)
  const decision = await evaluateDialGates({
    now: new Date(),
    organizationId,
    phoneNumber: String(contact.phone),
    timeZone: contact.timezone,
    jurisdiction: policy.label,
    policy,
    suppressionCheck: async () => {
      try { await assertNotSuppressed({ organizationId, channel: 'sms', address: String(contact.phone) }); return null } catch (error) {
        if (error instanceof SuppressedRecipientError) return error.reason
        throw error
      }
    },
    hasConsentRecord: req.body?.consentRecorded === true,
  })
  res.json(decision)
}))

router.post('/dialer/jobs', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.body?.contactId, 'contact')
  const voiceAgentId = objectId(req.body?.voiceAgentId, 'agent')

  // Consent must be asserted explicitly at queue time. A phone number in a CRM
  // is not permission to place an automated call, and defaulting this to true
  // would make the gate that checks it meaningless.
  if (req.body?.consentRecorded !== true) {
    throw new HttpError(
      400,
      'Consent assertion required',
      'Queueing an automated call requires an explicit consentRecorded=true, asserting a lawful basis for calling this contact.',
      problemType('voice-consent-required'),
    )
  }

  const agent: any = await VoiceAgent.findOne({ _id: voiceAgentId, organizationId, status: 'active' }).lean()
  if (!agent) throw new HttpError(409, 'Agent not active', 'The agent must be active before calls can be queued', problemType('voice-agent-not-active'))

  try {
    const created: any = await DialerJob.create({
      organizationId, contactId, voiceAgentId,
      dealId: req.body?.dealId ? objectId(req.body.dealId, 'deal') : null,
      earliestAt: req.body?.earliestAt ? new Date(String(req.body.earliestAt)) : new Date(),
      fromNumber: req.body?.fromNumber ? String(req.body.fromNumber).slice(0, 32) : null,
      consentRecorded: true,
      source: String(req.body?.source || 'manual').slice(0, 32),
    })
    await recordAudit({ req, organizationId, action: 'voice.call_queued', entityType: 'DialerJob', entityId: String(created._id), metadata: { voiceAgentId } })
    res.status(201).json({ id: String(created._id), status: 'pending', dryRun: env.DIALER_DRY_RUN })
  } catch (error: any) {
    // The unique index: one outstanding job per contact per agent, so a
    // retriggered event does not double-dial a real person.
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Already queued', 'This contact already has an outstanding call queued for this agent', problemType('voice-job-duplicate'))
    throw error
  }
}))

router.get('/dialer/jobs', asyncHandler(async (req, res) => {
  const query: any = { organizationId: requireOrganizationId(req) }
  if (req.query.status) query.status = String(req.query.status).slice(0, 24)
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await DialerJob.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    jobs: rows.slice(0, limit).map((row) => ({
      id: String(row._id), contactId: String(row.contactId), status: row.status,
      earliestAt: row.earliestAt, attempts: row.attempts, deferralCount: row.deferralCount,
      blockedReason: row.blockedReason, voiceCallId: row.voiceCallId ? String(row.voiceCallId) : null,
    })),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

router.delete('/dialer/jobs/:jobId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const jobId = objectId(req.params.jobId, 'job')
  // Only a job that has not begun dialling can be cancelled. Once the lease has
  // moved to dial_started a call may exist, and cancelling the record would
  // hide it rather than stop it.
  const result = await DialerJob.updateOne(
    { _id: jobId, organizationId, status: { $in: ['pending', 'blocked'] } },
    { $set: { status: 'cancelled' } },
  )
  if (!Number((result as any).modifiedCount || 0)) {
    throw new HttpError(409, 'Cannot cancel', 'This job has already begun dialling or is no longer pending', problemType('voice-job-not-cancellable'))
  }
  res.json({ id: jobId, cancelled: true })
}))

/* --------------------------------------------------------------------- calls */

router.get('/calls', asyncHandler(async (req, res) => {
  const query: any = { organizationId: requireOrganizationId(req) }
  if (req.query.contactId) query.contactId = objectId(req.query.contactId, 'contact')
  if (req.query.status) query.status = String(req.query.status).slice(0, 24)
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await VoiceCall.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    calls: rows.slice(0, limit).map((row) => ({
      id: String(row._id), contactId: row.contactId ? String(row.contactId) : null,
      direction: row.direction, status: row.status, blockedReason: row.blockedReason,
      toNumberPreview: row.toNumberPreview, durationSeconds: Number(row.durationSeconds || 0),
      agentDefinitionHash: row.agentDefinitionHash, outcomeTags: row.outcomeTags || [],
      optedOutAt: row.optedOutAt, startedAt: row.startedAt, endedAt: row.endedAt,
    })),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

/**
 * One call, with its transcript decrypted.
 *
 * The only endpoint returning transcript plaintext, and therefore the one to
 * audit. A call transcript is a verbatim record of what a person said, captured
 * without them typing it.
 */
router.get('/calls/:callId', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const callId = objectId(req.params.callId, 'call')
  const call: any = await VoiceCall.findOne({ _id: callId, organizationId }).select('+transcriptCiphertext +summaryCiphertext').lean()
  if (!call) throw new HttpError(404, 'Call not found', 'No call with that identifier exists in this organisation')

  let transcript = ''
  let summary = ''
  try {
    if (call.transcriptCiphertext) transcript = decryptString(call.transcriptCiphertext, `voice-call:${organizationId}:${callId}:transcript`)
    if (call.summaryCiphertext) summary = decryptString(call.summaryCiphertext, `voice-call:${organizationId}:${callId}:summary`)
  } catch {
    transcript = ''
    summary = ''
  }

  await recordAudit({ req, organizationId, action: 'voice.transcript_read', entityType: 'VoiceCall', entityId: callId })
  res.json({
    call: {
      id: callId, status: call.status, blockedReason: call.blockedReason,
      direction: call.direction, toNumberPreview: call.toNumberPreview,
      durationSeconds: Number(call.durationSeconds || 0),
      agentDefinitionHash: call.agentDefinitionHash,
      disclosures: call.disclosures, optedOutAt: call.optedOutAt,
      sentiment: call.sentiment, outcomeTags: call.outcomeTags || [],
      retainUntil: call.retainUntil, recordingDeletedAt: call.recordingDeletedAt,
    },
    transcript,
    summary,
    unreadable: Boolean(call.transcriptCiphertext) && !transcript,
  })
}))

export default router
