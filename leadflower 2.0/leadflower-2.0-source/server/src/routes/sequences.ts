import { Router } from 'express'
import { Types } from 'mongoose'
import MessagingIdentity from '../models/MessagingIdentity'
import ScheduledStep from '../models/ScheduledStep'
import SendRecord from '../models/SendRecord'
import Sequence from '../models/Sequence'
import SequenceEnrolment from '../models/SequenceEnrolment'
import SequenceVersion from '../models/SequenceVersion'
import SuppressionEntry from '../models/SuppressionEntry'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor'
import { requireOrganizationId } from '../types/authenticatedRequest'
import { recordAudit } from '../services/audit'
import { enrolContact, enrolmentProgress, exitEnrolment, publishSequenceVersion } from '../services/sequences/enrolmentService'
import { canonicaliseSequenceDefinition, SequenceDefinitionError } from '../services/sequences/sequenceDefinition'
import { addSuppression, removeSuppression, SUPPRESSION_CHANNELS, SUPPRESSION_REASONS, type SuppressionChannel, type SuppressionReason } from '../services/sequences/suppression'
import { domainAuthGuidance, storeIdentityCredentials, type MessagingProvider } from '../services/sequences/messagingIdentity'
import { UNVERIFIED_PROVIDERS } from '../services/sequences/channels'

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

/* ------------------------------------------------------------------ sequences */

router.get('/', asyncHandler(async (req, res) => {
  const query: any = { organizationId: requireOrganizationId(req) }
  if (req.query.status) query.status = String(req.query.status).slice(0, 32)
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await Sequence.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    sequences: rows.slice(0, limit).map((row) => ({
      id: String(row._id),
      name: row.name,
      description: row.description,
      status: row.status,
      latestVersion: Number(row.latestVersion || 0),
      publishedVersionId: row.publishedVersionId ? String(row.publishedVersionId) : null,
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
    })),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

router.post('/', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const name = String(req.body?.name || '').trim().slice(0, 200)
  if (!name) throw new HttpError(400, 'Name required', 'A sequence name is required')
  try {
    const created: any = await Sequence.create({
      organizationId,
      name,
      description: String(req.body?.description || '').slice(0, 2_000) || undefined,
      status: 'draft',
      createdBy: req.auth?.userId,
    })
    await recordAudit({ req, organizationId, action: 'sequence.created', entityType: 'Sequence', entityId: String(created._id), metadata: { name } })
    res.status(201).json({ id: String(created._id), name, status: 'draft' })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Sequence already exists', 'A sequence with that name already exists in this organisation', problemType('sequence-duplicate-name'))
    throw error
  }
}))

router.post('/:sequenceId/versions', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const sequenceId = objectId(req.params.sequenceId, 'sequence')
  const result = await publishSequenceVersion({ organizationId, sequenceId, definition: req.body?.definition ?? req.body, userId: req.auth?.userId })
  res.status(201).json(result)
}))

router.get('/:sequenceId/versions', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const sequenceId = objectId(req.params.sequenceId, 'sequence')
  const rows: any[] = await SequenceVersion.find({ organizationId, sequenceId }).sort({ version: -1 }).limit(50).lean()
  res.json({
    versions: rows.map((row) => ({
      id: String(row._id),
      version: Number(row.version),
      definitionHash: row.definitionHash,
      stepCount: (row.steps || []).length,
      quietHours: row.quietHours,
      exitConditions: row.exitConditions,
      createdAt: row.createdAt,
    })),
  })
}))

/**
 * Activating a sequence is what allows new enrolments; pausing stops sending
 * for enrolments already running, which the step runner enforces before every
 * step rather than only at enrolment.
 */
router.post('/:sequenceId/status', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const sequenceId = objectId(req.params.sequenceId, 'sequence')
  const status = String(req.body?.status || '')
  if (!['active', 'paused', 'archived', 'draft'].includes(status)) throw new HttpError(400, 'Invalid status', 'Status must be draft, active, paused or archived')

  const sequence: any = await Sequence.findOne({ _id: sequenceId, organizationId }).lean()
  if (!sequence) throw new HttpError(404, 'Sequence not found', 'No sequence with that identifier exists in this organisation', problemType('sequence-not-found'))
  if (status === 'active' && !sequence.publishedVersionId) {
    throw new HttpError(409, 'No published version', 'Publish a version before activating this sequence', problemType('sequence-version-missing'))
  }

  await Sequence.updateOne({ _id: sequenceId, organizationId }, { $set: { status, updatedBy: req.auth?.userId } })
  await recordAudit({ req, organizationId, action: 'sequence.status_changed', entityType: 'Sequence', entityId: sequenceId, metadata: { from: sequence.status, to: status } })
  res.json({ id: sequenceId, status })
}))

/**
 * One version, with its steps.
 *
 * The editor needs this to load an existing sequence for editing. Versions are
 * immutable, so editing means loading the published one, changing it, and
 * publishing a new version — the old one keeps running for anybody already
 * enrolled on it.
 */
router.get('/:sequenceId/versions/:versionId', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const sequenceId = objectId(req.params.sequenceId, 'sequence')
  const versionId = objectId(req.params.versionId, 'version')
  const version: any = await SequenceVersion.findOne({ _id: versionId, sequenceId, organizationId }).lean()
  if (!version) throw new HttpError(404, 'Version not found', 'No version with that identifier exists for this sequence')
  res.json({
    id: String(version._id),
    version: Number(version.version),
    definitionHash: version.definitionHash,
    definition: {
      steps: (version.steps || []).map((step: any) => ({
        channel: step.channel,
        wait: step.wait,
        subjectTemplate: step.subjectTemplate,
        bodyTemplate: step.bodyTemplate,
        whatsappTemplate: step.whatsappTemplate,
        messagingIdentityId: step.messagingIdentityId ? String(step.messagingIdentityId) : null,
      })),
      exitConditions: version.exitConditions,
      quietHours: version.quietHours,
      defaultTimeZone: version.defaultTimeZone,
    },
  })
}))

/**
 * Validate a definition without publishing it.
 *
 * Lets the editor show errors as somebody types rather than only when they hit
 * publish, using exactly the same validator the publish path uses — so there is
 * no chance of the editor accepting something the server would reject.
 */
router.post('/:sequenceId/versions/validate', asyncHandler(async (req, res) => {
  requireOperator(req)
  requireOrganizationId(req)
  objectId(req.params.sequenceId, 'sequence')
  try {
    const definition = canonicaliseSequenceDefinition(req.body?.definition ?? req.body)
    res.json({ valid: true, stepCount: definition.steps.length, issues: [] })
  } catch (error) {
    if (error instanceof SequenceDefinitionError) return res.json({ valid: false, issues: error.issues })
    throw error
  }
}))

/* ---------------------------------------------------------------- enrolments */

router.post('/:sequenceId/enrolments', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const sequenceId = objectId(req.params.sequenceId, 'sequence')
  const contactId = objectId(req.body?.contactId, 'contact')
  const result = await enrolContact({ organizationId, sequenceId, contactId, source: String(req.body?.source || 'manual').slice(0, 64), userId: req.auth?.userId })
  res.status(result.created ? 201 : 200).json(result)
}))

router.get('/enrolments/:enrolmentId', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const enrolmentId = objectId(req.params.enrolmentId, 'enrolment')
  const progress = await enrolmentProgress({ organizationId, enrolmentId })
  if (!progress) throw new HttpError(404, 'Enrolment not found', 'No enrolment with that identifier exists in this organisation')
  res.json(progress)
}))

/**
 * The exit signal endpoint.
 *
 * Phase 1 has no inbound message handling, so replies and conversions are not
 * detected automatically — they arrive here, from the operator's own systems.
 * Automatic reply detection is a Phase 3 concern and depends on the unified
 * inbox; until then this endpoint is the only honest way for a reply to stop a
 * sequence, and it is documented as such.
 */
router.post('/enrolments/:enrolmentId/exit', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const enrolmentId = objectId(req.params.enrolmentId, 'enrolment')
  const reason = String(req.body?.reason || 'manually_removed')
  if (!['replied', 'converted', 'manually_removed', 'unsubscribed'].includes(reason)) {
    throw new HttpError(400, 'Invalid exit reason', 'Reason must be replied, converted, unsubscribed or manually_removed')
  }
  const result = await exitEnrolment({ organizationId, enrolmentId, reason: reason as any, userId: req.auth?.userId })
  res.json(result)
}))

router.get('/enrolments', asyncHandler(async (req, res) => {
  const query: any = { organizationId: requireOrganizationId(req) }
  if (req.query.sequenceId) query.sequenceId = objectId(req.query.sequenceId, 'sequence')
  if (req.query.contactId) query.contactId = objectId(req.query.contactId, 'contact')
  if (req.query.status) query.status = String(req.query.status).slice(0, 32)
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await SequenceEnrolment.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    enrolments: rows.slice(0, limit).map((row) => ({
      id: String(row._id),
      sequenceId: String(row.sequenceId),
      contactId: String(row.contactId),
      status: row.status,
      stepIndex: Number(row.stepIndex || 0),
      nextDueAt: row.nextDueAt,
      exitReason: row.exitReason,
      sequenceVersion: Number(row.sequenceVersion || 0),
    })),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

/**
 * Operational health of the scheduler for this organisation.
 *
 * `outcomeUnknown` is surfaced first and deliberately not folded into a
 * failure count: those are the steps where a message may have gone out and no
 * one can say. They need a human, and a dashboard that hides them inside
 * "errors" is how they stay unresolved.
 */
router.get('/operations/health', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const now = new Date()
  const [pending, overdue, outcomeUnknown, failed, suppressed] = await Promise.all([
    ScheduledStep.countDocuments({ organizationId, status: 'pending' }),
    ScheduledStep.countDocuments({ organizationId, status: 'pending', dueAt: { $lt: new Date(now.getTime() - 15 * 60_000) } }),
    ScheduledStep.countDocuments({ organizationId, status: 'outcome_unknown' }),
    ScheduledStep.countDocuments({ organizationId, status: 'failed' }),
    SendRecord.countDocuments({ organizationId, status: 'suppressed' }),
  ])
  res.json({
    scheduledSteps: { pending, overdue, outcomeUnknown, failed },
    sends: { suppressed },
    note: 'Steps with an unknown outcome are not failures. A message may already have reached the recipient; resolve each one before re-sending.',
  })
}))

/* ------------------------------------------------------- messaging identities */

router.get('/identities', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const rows: any[] = await MessagingIdentity.find({ organizationId }).sort({ _id: -1 }).limit(100).lean()
  res.json({
    identities: rows.map((row) => ({
      id: String(row._id),
      channel: row.channel,
      provider: row.provider,
      label: row.label,
      status: row.status,
      isDefault: Boolean(row.isDefault),
      fromAddress: row.fromAddress,
      fromNumber: row.fromNumber,
      domainAuth: row.domainAuth,
      // Provenance, not reassurance: a provider whose contract has not been
      // confirmed against a live account is reported as unverified.
      providerVerification: UNVERIFIED_PROVIDERS.has(String(row.provider)) ? 'unverified' : 'verified',
      hasCredentials: Boolean(row.credentialsCiphertext),
    })),
  })
}))

router.post('/identities', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const channel = String(req.body?.channel || '')
  const provider = String(req.body?.provider || '')
  if (!SUPPRESSION_CHANNELS.includes(channel as SuppressionChannel)) throw new HttpError(400, 'Invalid channel', 'Channel must be email, sms or whatsapp')
  if (!['smtp', 'sendgrid', 'twilio', 'whatsapp_cloud'].includes(provider)) throw new HttpError(400, 'Invalid provider', 'Provider must be smtp, sendgrid, twilio or whatsapp_cloud')
  const label = String(req.body?.label || '').trim().slice(0, 120)
  if (!label) throw new HttpError(400, 'Label required', 'A label is required')

  let created: any
  try {
    created = await MessagingIdentity.create({
      organizationId,
      channel,
      provider,
      label,
      fromAddress: req.body?.fromAddress ? String(req.body.fromAddress).slice(0, 320) : undefined,
      fromName: req.body?.fromName ? String(req.body.fromName).slice(0, 120) : undefined,
      replyToAddress: req.body?.replyToAddress ? String(req.body.replyToAddress).slice(0, 320) : undefined,
      fromNumber: req.body?.fromNumber ? String(req.body.fromNumber).slice(0, 32) : undefined,
      isDefault: Boolean(req.body?.isDefault),
      createdBy: req.auth?.userId,
    })
  } catch (error: any) {
    // `{organizationId, channel, label}` is unique. Adding a second identity
    // under a label already in use surfaced the raw driver error as a 500,
    // which reads as the product being broken rather than as a name clash the
    // operator can resolve in a second. Same treatment as a duplicate sequence
    // name above.
    if (Number(error?.code) === 11_000) {
      throw new HttpError(409, 'Name already used', `You already have a ${channel} setup called “${label}”. Give this one a different name.`, problemType('messaging-identity-duplicate-label'))
    }
    throw error
  }

  // Credentials are stored in a second, separate write so they are never part
  // of the document creation payload that gets logged or echoed back.
  await storeIdentityCredentials({
    organizationId,
    identityId: String(created._id),
    provider: provider as MessagingProvider,
    credentials: req.body?.credentials,
  })

  if (req.body?.isDefault) {
    await MessagingIdentity.updateMany({ organizationId, channel, _id: { $ne: created._id } }, { $set: { isDefault: false } })
  }

  await recordAudit({ req, organizationId, action: 'messaging_identity.created', entityType: 'MessagingIdentity', entityId: String(created._id), metadata: { channel, provider, label } })
  res.status(201).json({
    id: String(created._id),
    channel,
    provider,
    label,
    providerVerification: UNVERIFIED_PROVIDERS.has(provider) ? 'unverified' : 'verified',
    ...(channel === 'email' && req.body?.fromAddress ? { domainAuth: domainAuthGuidance(String(req.body.fromAddress)) } : {}),
  })
}))

/* ------------------------------------------------------------------ suppression */

router.get('/suppression', asyncHandler(async (req, res) => {
  const query: any = { organizationId: requireOrganizationId(req) }
  if (req.query.channel) query.channel = String(req.query.channel).slice(0, 16)
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await SuppressionEntry.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    // The list is returned as digests and previews. It is a record of who not
    // to contact, not an exportable address book.
    entries: rows.slice(0, limit).map((row) => ({
      id: String(row._id),
      channel: row.channel,
      addressDigest: row.addressDigest,
      addressPreview: row.addressPreview,
      reason: row.reason,
      source: row.source,
      createdAt: row.createdAt,
    })),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

router.post('/suppression', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const channel = String(req.body?.channel || '')
  const reason = String(req.body?.reason || 'manual')
  if (!SUPPRESSION_CHANNELS.includes(channel as SuppressionChannel)) throw new HttpError(400, 'Invalid channel', 'Channel must be email, sms or whatsapp')
  if (!SUPPRESSION_REASONS.includes(reason as SuppressionReason)) throw new HttpError(400, 'Invalid reason', `Reason must be one of ${SUPPRESSION_REASONS.join(', ')}`)
  const address = String(req.body?.address || '').trim()
  if (!address) throw new HttpError(400, 'Address required', 'An address is required')

  const result = await addSuppression({
    organizationId,
    channel: channel as SuppressionChannel,
    address,
    reason: reason as SuppressionReason,
    source: 'operator',
    note: req.body?.note ? String(req.body.note).slice(0, 500) : undefined,
    createdBy: req.auth?.userId,
  })
  res.status(result.created ? 201 : 200).json(result)
}))

router.delete('/suppression/:addressDigest', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const channel = String(req.query.channel || '')
  if (!SUPPRESSION_CHANNELS.includes(channel as SuppressionChannel)) throw new HttpError(400, 'Invalid channel', 'A channel query parameter is required')
  const addressDigest = String(req.params.addressDigest || '').slice(0, 128)

  const result = await removeSuppression({
    organizationId,
    channel: channel as SuppressionChannel,
    addressDigest,
    removedBy: String(req.auth?.userId || ''),
    note: req.body?.note ? String(req.body.note).slice(0, 500) : undefined,
  })
  if (result.refusedReason) {
    throw new HttpError(
      409,
      'Entry cannot be removed',
      `This entry records an explicit ${result.refusedReason} by the recipient. Only a fresh opt-in from that person can reverse it.`,
      problemType('suppression-removal-refused'),
    )
  }
  res.json(result)
}))

export default router
