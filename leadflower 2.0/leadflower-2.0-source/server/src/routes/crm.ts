import { Router } from 'express'
import { Types } from 'mongoose'
import Contact from '../models/Contact'
import Appointment from '../models/Appointment'
import ContactActivity from '../models/ContactActivity'
import ContactNote from '../models/ContactNote'
import Task from '../models/Task'
import CustomFieldDefinition from '../models/CustomFieldDefinition'
import Deal from '../models/Deal'
import Pipeline from '../models/Pipeline'
import SavedSegment from '../models/SavedSegment'
import SendRecord from '../models/SendRecord'
import SequenceEnrolment from '../models/SequenceEnrolment'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor'
import { requireOrganizationId } from '../types/authenticatedRequest'
import { recordAudit } from '../services/audit'
import { applyCustomFields, CustomFieldError, validateDefinition, type CustomFieldDefinitionView } from '../services/crm/customFields'
import { compileSegment, SegmentError, segmentFieldCatalogue, type SegmentDefinition } from '../services/crm/segments'
import { canonicaliseStages, assertStageSequencesExist, moveDeal, pipelineBoard, PipelineError } from '../services/crm/pipelines'
import { contactTimeline, recordActivity } from '../services/crm/contactActivity'
import { applyImport, previewImport, suggestMapping, MAX_IMPORT_ROWS, type ColumnMapping } from '../services/crm/contactImport'
import { createPaymentLink, markPaymentReceived, storeStripeCredential } from '../services/crm/payments'
import PaymentLink from '../models/PaymentLink'
import Artifact from '../models/Artifact'
import Company from '../models/Company'
import TagRule from '../models/TagRule'
import { applyTagChanges, dedupeTags, normaliseTagKey, tagCatalogue } from '../services/crm/tags'
import { openArtifact, safeDownloadFileName, storeArtifactFromBuffer, deleteStoredArtifact } from '../services/artifactStore'
import { pipeline } from 'stream/promises'

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

function dealView(row: any) {
  return {
    id: String(row._id),
    contactId: String(row.contactId),
    pipelineId: String(row.pipelineId),
    stageId: row.stageId,
    title: row.title,
    valueMinorUnits: Number(row.valueMinorUnits || 0),
    currency: row.currency,
    expectedCloseAt: row.expectedCloseAt,
    ownerUserId: row.ownerUserId,
    status: row.status,
    lostReason: row.lostReason,
    stageEnteredAt: row.stageEnteredAt,
    createdAt: row.createdAt,
  }
}

async function definitionsFor(organizationId: string): Promise<CustomFieldDefinitionView[]> {
  const rows: any[] = await CustomFieldDefinition.find({ organizationId }).limit(500).lean()
  return rows.map((row) => ({
    key: row.key, label: row.label, type: row.type, required: Boolean(row.required),
    options: row.options || [], min: row.min, max: row.max, helpText: row.helpText,
  }))
}

function asCustomFieldProblem(error: unknown): never {
  if (error instanceof CustomFieldError) {
    throw new HttpError(400, 'Custom fields invalid', error.issues.join('; '), problemType('custom-field-invalid'))
  }
  throw error
}

/* --------------------------------------------------------- field definitions */

router.get('/fields', asyncHandler(async (req, res) => {
  const definitions = await definitionsFor(requireOrganizationId(req))
  res.json({ fields: definitions })
}))

router.post('/fields', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const count = await CustomFieldDefinition.countDocuments({ organizationId })
  if (count >= 200) throw new HttpError(409, 'Field limit reached', 'An organisation cannot define more than 200 custom fields', problemType('custom-field-limit'))

  let definition: CustomFieldDefinitionView
  try { definition = validateDefinition(req.body) } catch (error) { asCustomFieldProblem(error) }

  try {
    const created: any = await CustomFieldDefinition.create({ organizationId, ...definition, createdBy: req.auth?.userId })
    await recordAudit({ req, organizationId, action: 'crm.field_defined', entityType: 'CustomFieldDefinition', entityId: String(created._id), metadata: { key: definition.key, type: definition.type } })
    res.status(201).json({ id: String(created._id), ...definition })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Field already exists', `A custom field with key "${definition.key}" already exists`, problemType('custom-field-duplicate'))
    throw error
  }
}))

/**
 * Changing a field's type is refused rather than attempted.
 *
 * Existing values were coerced under the old type and cannot be reinterpreted
 * safely — "12/03" is a date under one reading and a string under another, and
 * getting it wrong corrupts data that looks fine. Define a new field and
 * migrate deliberately.
 */
router.patch('/fields/:fieldId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const fieldId = objectId(req.params.fieldId, 'field')
  const existing: any = await CustomFieldDefinition.findOne({ _id: fieldId, organizationId }).lean()
  if (!existing) throw new HttpError(404, 'Field not found', 'No custom field with that identifier exists in this organisation')

  if (req.body?.type && String(req.body.type) !== existing.type) {
    throw new HttpError(409, 'Field type is immutable', 'Existing values were validated under the current type and cannot be safely reinterpreted. Define a new field and migrate.', problemType('custom-field-type-immutable'))
  }
  if (req.body?.key && String(req.body.key) !== existing.key) {
    throw new HttpError(409, 'Field key is immutable', 'Renaming a key would orphan every stored value and every segment referencing it', problemType('custom-field-key-immutable'))
  }

  let definition: CustomFieldDefinitionView
  try { definition = validateDefinition({ ...existing, ...req.body, key: existing.key, type: existing.type }) } catch (error) { asCustomFieldProblem(error) }

  await CustomFieldDefinition.updateOne({ _id: fieldId, organizationId }, { $set: { label: definition.label, required: definition.required, options: definition.options, min: definition.min, max: definition.max, helpText: definition.helpText } })
  await recordAudit({ req, organizationId, action: 'crm.field_updated', entityType: 'CustomFieldDefinition', entityId: fieldId, metadata: { key: definition.key } })
  res.json({ id: fieldId, ...definition })
}))

/* ------------------------------------------------------------------ contacts */

router.get('/contacts', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const query: any = { organizationId, archivedAt: null }

  const search = String(req.query.q || '').trim().slice(0, 200)
  if (search) query.$text = { $search: search }
  if (req.query.lifecycleStatus) query.lifecycleStatus = String(req.query.lifecycleStatus).slice(0, 32)
  if (req.query.ownerUserId) query.ownerUserId = String(req.query.ownerUserId).slice(0, 64)
  if (req.query.tag) query.tags = String(req.query.tag).slice(0, 64)

  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) query._id = { $lt: cursor }

  const rows: any[] = await Contact.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    contacts: rows.slice(0, limit).map((row) => ({
      id: String(row._id),
      name: row.name,
      firstName: row.firstName,
      lastName: row.lastName,
      companyName: row.companyName,
      email: row.email,
      phone: row.phone,
      tags: row.tags || [],
      lifecycleStatus: row.lifecycleStatus,
      ownerUserId: row.ownerUserId,
      lastActivityAt: row.lastActivityAt,
      customFields: row.customFields || {},
    })),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

router.post('/contacts', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const definitions = await definitionsFor(organizationId)

  let customFields: Record<string, unknown>
  let undefinedKeys: string[] = []
  try {
    const applied = applyCustomFields({ definitions, values: req.body?.customFields, strict: true, enforceRequired: true })
    customFields = applied.values
    undefinedKeys = applied.undefinedKeys
  } catch (error) { asCustomFieldProblem(error) }

  const created: any = await Contact.create({
    organizationId,
    firstName: req.body?.firstName ? String(req.body.firstName).slice(0, 120) : undefined,
    lastName: req.body?.lastName ? String(req.body.lastName).slice(0, 120) : undefined,
    name: req.body?.name ? String(req.body.name).slice(0, 240) : undefined,
    companyName: req.body?.companyName ? String(req.body.companyName).slice(0, 240) : undefined,
    email: req.body?.email ? String(req.body.email).toLowerCase().slice(0, 320) : undefined,
    phone: req.body?.phone ? String(req.body.phone).slice(0, 32) : undefined,
    timezone: req.body?.timezone ? String(req.body.timezone).slice(0, 64) : undefined,
    tags: Array.isArray(req.body?.tags) ? dedupeTags(req.body.tags.map(String)) : [],
    lifecycleStatus: req.body?.lifecycleStatus || 'lead',
    ownerUserId: req.body?.ownerUserId ? String(req.body.ownerUserId).slice(0, 64) : null,
    source: String(req.body?.source || 'manual').slice(0, 64),
    customFields,
  })

  await recordActivity({ organizationId, contactId: String(created._id), type: 'contact.created', summary: 'Contact created', actorUserId: req.auth?.userId, metadata: { source: created.source } })
  await recordAudit({ req, organizationId, action: 'crm.contact_created', entityType: 'Contact', entityId: String(created._id) })
  res.status(201).json({ id: String(created._id), undefinedKeys })
}))

/**
 * The single contact view.
 *
 * Assembled from the collections that own each part rather than denormalised
 * onto the contact, so nothing here can drift from the record it describes.
 */
router.get('/contacts/:contactId', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.params.contactId, 'contact')

  const contact: any = await Contact.findOne({ _id: contactId, organizationId }).lean()
  if (!contact) throw new HttpError(404, 'Contact not found', 'No contact with that identifier exists in this organisation')

  const [notes, enrolments, messages, deals, timeline, definitions, attachments] = await Promise.all([
    ContactNote.find({ organizationId, contactId }).sort({ pinned: -1, createdAt: -1 }).limit(50).lean(),
    SequenceEnrolment.find({ organizationId, contactId }).sort({ createdAt: -1 }).limit(50).lean(),
    SendRecord.find({ organizationId, contactId }).sort({ createdAt: -1 }).limit(100).lean(),
    Deal.find({ organizationId, contactId }).sort({ createdAt: -1 }).limit(50).lean(),
    contactTimeline({ organizationId, contactId, limit: 50 }),
    definitionsFor(organizationId),
    Artifact.find({ organizationId, contactId, kind: 'contact_attachment', status: 'ready' }).sort({ _id: -1 }).limit(50).lean(),
  ])

  const definedKeys = new Set(definitions.map((definition) => definition.key))
  const storedKeys = Object.keys(contact.customFields || {})

  res.json({
    contact: {
      id: String(contact._id),
      name: contact.name,
      firstName: contact.firstName,
      lastName: contact.lastName,
      companyName: contact.companyName,
      email: contact.email,
      phone: contact.phone,
      timezone: contact.timezone,
      tags: contact.tags || [],
      lifecycleStatus: contact.lifecycleStatus,
      ownerUserId: contact.ownerUserId,
      source: contact.source,
      addressLine1: contact.addressLine1,
      addressLine2: contact.addressLine2,
      city: contact.city,
      region: contact.region,
      postalCode: contact.postalCode,
      country: contact.country,
      jobTitle: contact.jobTitle,
      secondaryPhone: contact.secondaryPhone,
      preferredContactMethod: contact.preferredContactMethod,
      referredBy: contact.referredBy,
      companyId: contact.companyId ? String(contact.companyId) : null,
      leadScore: contact.leadScore,
      nextActionAt: contact.nextActionAt,
      nextActionNote: contact.nextActionNote,
      revenueMinorUnits: Number(contact.revenueMinorUnits || 0),
      revenueCurrency: contact.revenueCurrency,
      lastActivityAt: contact.lastActivityAt,
      lastInboundAt: contact.lastInboundAt,
      customFields: contact.customFields || {},
    },
    // Values stored before a definition existed, or after one was removed. They
    // are surfaced rather than deleted: silently discarding a customer's data
    // to satisfy a newer rule is the wrong trade.
    undefinedCustomFieldKeys: storedKeys.filter((key) => !definedKeys.has(key)),
    notes: notes.map((note: any) => ({ id: String(note._id), body: note.body, authorName: note.authorName, pinned: note.pinned, createdAt: note.createdAt })),
    enrolments: enrolments.map((row: any) => ({ id: String(row._id), sequenceId: String(row.sequenceId), status: row.status, stepIndex: row.stepIndex, nextDueAt: row.nextDueAt, exitReason: row.exitReason })),
    // Message history across every channel. Metadata only — bodies stay on the
    // send record, and addresses are already redacted there.
    messages: messages.map((row: any) => ({ id: String(row._id), channel: row.channel, status: row.status, recipientPreview: row.recipientPreview, sentAt: row.sentAt, deliveredAt: row.deliveredAt, bouncedAt: row.bouncedAt })),
    deals: deals.map((row: any) => ({ id: String(row._id), title: row.title, pipelineId: String(row.pipelineId), stageId: row.stageId, status: row.status, valueMinorUnits: Number(row.valueMinorUnits || 0), currency: row.currency })),
    attachments: (attachments as any[]).map((row: any) => ({
      id: String(row._id), fileName: row.fileName, contentType: row.contentType,
      sizeBytes: Number(row.plaintextSize || 0), createdAt: row.createdAt,
    })),
    timeline,
  })
}))

router.patch('/contacts/:contactId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.params.contactId, 'contact')
  const definitions = await definitionsFor(organizationId)

  const update: Record<string, unknown> = {}
  for (const field of [
    'firstName', 'lastName', 'name', 'companyName', 'timezone', 'source',
    'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country',
    'jobTitle', 'secondaryPhone', 'referredBy', 'nextActionNote',
  ] as const) {
    if (req.body?.[field] !== undefined) update[field] = String(req.body[field]).slice(0, 240)
  }
  if (req.body?.email !== undefined) update.email = String(req.body.email).toLowerCase().slice(0, 320)
  if (req.body?.phone !== undefined) update.phone = String(req.body.phone).slice(0, 32)
  if (req.body?.lifecycleStatus !== undefined) update.lifecycleStatus = String(req.body.lifecycleStatus)
  if (req.body?.ownerUserId !== undefined) update.ownerUserId = req.body.ownerUserId ? String(req.body.ownerUserId).slice(0, 64) : null
  // Tags are NOT set through this route. Replacing the array wholesale would
  // skip the rule engine entirely, so a tag added here would fire no
  // automation — the exact bug that makes an operator distrust their own
  // configuration. Use the tag endpoints below.
  if (req.body?.tags !== undefined) {
    throw new HttpError(400, 'Use the tag endpoints', 'Tags drive automation and must be changed through /crm/contacts/:id/tags so their rules run.', problemType('contact-tags-via-tag-endpoint'))
  }
  if (req.body?.leadScore !== undefined) {
    const score = req.body.leadScore === null ? null : Number(req.body.leadScore)
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) {
      throw new HttpError(400, 'Invalid lead score', 'Lead score must be a number between 0 and 100, or null')
    }
    update.leadScore = score
  }
  if (req.body?.nextActionAt !== undefined) {
    if (req.body.nextActionAt === null) update.nextActionAt = null
    else {
      const nextAction = new Date(String(req.body.nextActionAt))
      if (Number.isNaN(nextAction.getTime())) throw new HttpError(400, 'Invalid date', 'nextActionAt must be a valid date')
      update.nextActionAt = nextAction
    }
  }
  if (req.body?.preferredContactMethod !== undefined) {
    const method = req.body.preferredContactMethod
    if (method !== null && !['email', 'phone', 'sms', 'whatsapp'].includes(String(method))) {
      throw new HttpError(400, 'Invalid contact method', 'Preferred contact method must be email, phone, sms, whatsapp, or null')
    }
    update.preferredContactMethod = method
  }
  if (req.body?.companyId !== undefined) {
    if (req.body.companyId === null) update.companyId = null
    else {
      const companyId = objectId(req.body.companyId, 'company')
      if (!await Company.exists({ _id: companyId, organizationId })) throw new HttpError(404, 'Company not found', 'No company with that identifier exists in this organisation')
      update.companyId = companyId
    }
  }

  if (req.body?.customFields !== undefined) {
    try {
      // Merged, not replaced: a partial update that dropped every unmentioned
      // custom field would silently erase data on every edit.
      const existing: any = await Contact.findOne({ _id: contactId, organizationId }).select('customFields').lean()
      const applied = applyCustomFields({ definitions, values: req.body.customFields, strict: true })
      update.customFields = { ...(existing?.customFields || {}), ...applied.values }
    } catch (error) { asCustomFieldProblem(error) }
  }

  const result = await Contact.updateOne({ _id: contactId, organizationId }, { $set: update })
  if (!Number((result as any).matchedCount || 0)) throw new HttpError(404, 'Contact not found', 'No contact with that identifier exists in this organisation')

  await recordActivity({ organizationId, contactId, type: 'contact.updated', summary: `Contact updated (${Object.keys(update).join(', ') || 'no changes'})`, actorUserId: req.auth?.userId })
  await recordAudit({ req, organizationId, action: 'crm.contact_updated', entityType: 'Contact', entityId: contactId, metadata: { fields: Object.keys(update) } })
  res.json({ id: contactId, updated: Object.keys(update) })
}))

router.post('/contacts/:contactId/notes', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.params.contactId, 'contact')
  const body = String(req.body?.body || '').trim().slice(0, 20_000)
  if (!body) throw new HttpError(400, 'Note body required', 'A note requires a body')
  if (!await Contact.exists({ _id: contactId, organizationId })) throw new HttpError(404, 'Contact not found', 'No contact with that identifier exists in this organisation')

  const created: any = await ContactNote.create({ organizationId, contactId, body, authorUserId: req.auth?.userId, pinned: Boolean(req.body?.pinned) })
  await recordActivity({ organizationId, contactId, type: 'note.added', summary: 'Note added', entityType: 'ContactNote', entityId: String(created._id), actorUserId: req.auth?.userId })
  res.status(201).json({ id: String(created._id) })
}))

/**
 * Archive a contact.
 *
 * Reversible, and the default way to remove someone from view. Active sequence
 * enrolments are exited: an archived contact who keeps receiving automated
 * follow-up is the exact failure the archive was meant to stop.
 */
router.post('/contacts/:contactId/archive', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.params.contactId, 'contact')
  const restore = req.body?.restore === true

  const result = await Contact.updateOne({ _id: contactId, organizationId }, { $set: { archivedAt: restore ? null : new Date() } })
  if (!Number((result as any).matchedCount || 0)) throw new HttpError(404, 'Contact not found', 'No contact with that identifier exists in this organisation')

  if (!restore) {
    const { exitEnrolmentsForContact } = await import('../services/sequences/enrolmentService')
    await exitEnrolmentsForContact({ organizationId, contactId, reason: 'manually_removed' })
  }
  await recordActivity({
    organizationId, contactId, type: restore ? 'contact.restored' : 'contact.archived',
    summary: restore ? 'Contact restored' : 'Contact archived', actorUserId: req.auth?.userId,
  })
  await recordAudit({ req, organizationId, action: restore ? 'crm.contact_restored' : 'crm.contact_archived', entityType: 'Contact', entityId: contactId })
  res.json({ id: contactId, archived: !restore })
}))

/**
 * Delete a contact permanently.
 *
 * Deletes the contact and its notes, activity, enrolments, tasks and deals.
 * Suppression entries are deliberately NOT removed: deleting the record that
 * says "this person asked us to stop" would silently re-permit contact if they
 * ever re-enter the system, which is the same failure the retention guardrail
 * exists to prevent.
 *
 * Archiving is the reversible option and should be the default. This exists for
 * an erasure request about one individual, where the organisation as a whole is
 * staying.
 */
router.delete('/contacts/:contactId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.params.contactId, 'contact')
  if (String(req.query.confirm || '') !== 'permanent') {
    throw new HttpError(400, 'Confirmation required', 'Permanent deletion requires ?confirm=permanent. Consider archiving instead, which is reversible.', problemType('contact-delete-unconfirmed'))
  }

  const contact: any = await Contact.findOne({ _id: contactId, organizationId }).select('_id').lean()
  if (!contact) throw new HttpError(404, 'Contact not found', 'No contact with that identifier exists in this organisation')

  const { exitEnrolmentsForContact } = await import('../services/sequences/enrolmentService')
  await exitEnrolmentsForContact({ organizationId, contactId, reason: 'manually_removed' })

  const removed: Record<string, number> = {}
  for (const [name, model] of [
    ['notes', ContactNote], ['activities', ContactActivity], ['deals', Deal],
    ['tasks', Task], ['appointments', Appointment], ['enrolments', SequenceEnrolment],
  ] as const) {
    const result: any = await (model as any).deleteMany({ organizationId, contactId })
    removed[name] = Number(result?.deletedCount || 0)
  }
  await Contact.deleteOne({ _id: contactId, organizationId })

  await recordAudit({
    req, organizationId, action: 'crm.contact_deleted', entityType: 'Contact', entityId: contactId,
    // Suppression is recorded as retained, so the decision is visible in the
    // audit trail rather than inferred from its absence.
    metadata: { ...removed, suppressionRetained: true },
  })
  res.json({ id: contactId, deleted: true, removed, suppressionRetained: true })
}))

router.get('/contacts/:contactId/timeline', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.params.contactId, 'contact')
  const before = req.query.before ? new Date(String(req.query.before)) : undefined
  const timeline = await contactTimeline({ organizationId, contactId, limit: pageLimit(req.query.limit), before: before && !Number.isNaN(before.getTime()) ? before : undefined })
  res.json({ timeline })
}))

/* ------------------------------------------------------------------ segments */

router.get('/segments/fields', asyncHandler(async (req, res) => {
  res.json({ fields: segmentFieldCatalogue(await definitionsFor(requireOrganizationId(req))) })
}))

router.post('/segments/preview', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const definitions = await definitionsFor(organizationId)
  let query: Record<string, unknown>
  try {
    query = compileSegment({ organizationId, definition: req.body as SegmentDefinition, definitions })
  } catch (error) {
    if (error instanceof SegmentError) throw new HttpError(400, 'Segment is invalid', error.issues.join('; '), problemType('segment-invalid'))
    throw error
  }
  const [count, sample] = await Promise.all([
    Contact.countDocuments(query),
    Contact.find(query).sort({ _id: -1 }).limit(10).select('name email phone lifecycleStatus').lean(),
  ])
  res.json({ count, sample: sample.map((row: any) => ({ id: String(row._id), name: row.name, email: row.email, phone: row.phone, lifecycleStatus: row.lifecycleStatus })) })
}))

router.post('/segments', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const name = String(req.body?.name || '').trim().slice(0, 120)
  if (!name) throw new HttpError(400, 'Name required', 'A segment name is required')

  const definitions = await definitionsFor(organizationId)
  try {
    // Compiled at save time so an invalid segment is rejected by the person
    // building it, not discovered later by whatever tries to use it.
    compileSegment({ organizationId, definition: req.body as SegmentDefinition, definitions })
  } catch (error) {
    if (error instanceof SegmentError) throw new HttpError(400, 'Segment is invalid', error.issues.join('; '), problemType('segment-invalid'))
    throw error
  }

  try {
    const created: any = await SavedSegment.create({
      organizationId,
      name,
      description: req.body?.description ? String(req.body.description).slice(0, 1_000) : undefined,
      match: req.body?.match === 'any' ? 'any' : 'all',
      conditions: req.body?.conditions || [],
      createdBy: req.auth?.userId,
    })
    await recordAudit({ req, organizationId, action: 'crm.segment_created', entityType: 'SavedSegment', entityId: String(created._id), metadata: { name } })
    res.status(201).json({ id: String(created._id), name })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Segment already exists', 'A segment with that name already exists', problemType('segment-duplicate-name'))
    throw error
  }
}))

router.get('/segments', asyncHandler(async (req, res) => {
  const rows: any[] = await SavedSegment.find({ organizationId: requireOrganizationId(req) }).sort({ _id: -1 }).limit(100).lean()
  res.json({
    segments: rows.map((row) => ({
      id: String(row._id), name: row.name, description: row.description, match: row.match,
      conditions: row.conditions, lastCount: row.lastCount,
      // The count is explicitly stamped rather than presented as live, so a
      // stale figure is visibly stale.
      lastCountedAt: row.lastCountedAt,
    })),
  })
}))

/**
 * Run a saved segment.
 *
 * Compiled at read time from the stored condition tree, never from a cached
 * query. A segment is a live question — "contacts who match this" — and caching
 * the answer would return contacts who no longer qualify, which for a segment
 * used to pick who gets messaged is the wrong kind of wrong.
 *
 * Recompiling also means a segment referencing a custom field that has since
 * been deleted fails loudly here rather than silently matching nothing.
 */
router.get('/segments/:segmentId/contacts', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const segmentId = objectId(req.params.segmentId, 'segment')
  const segment: any = await SavedSegment.findOne({ _id: segmentId, organizationId }).lean()
  if (!segment) throw new HttpError(404, 'Segment not found', 'No segment with that identifier exists in this organisation')

  let query: Record<string, unknown>
  try {
    query = compileSegment({
      organizationId,
      definition: { match: segment.match, conditions: segment.conditions } as SegmentDefinition,
      definitions: await definitionsFor(organizationId),
    })
  } catch (error) {
    if (error instanceof SegmentError) {
      throw new HttpError(409, 'Segment can no longer be run', `${error.issues.join('; ')}. A field this segment relies on has probably been removed.`, problemType('segment-stale'))
    }
    throw error
  }

  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) (query as any)._id = { $lt: cursor }

  const rows: any[] = await Contact.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    segment: { id: segmentId, name: segment.name },
    contacts: rows.slice(0, limit).map((row) => ({
      id: String(row._id), name: row.name, firstName: row.firstName, lastName: row.lastName,
      email: row.email, phone: row.phone, lifecycleStatus: row.lifecycleStatus, tags: row.tags || [],
    })),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

/** Recount and stamp the result, so a displayed figure is visibly dated. */
router.post('/segments/:segmentId/count', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const segmentId = objectId(req.params.segmentId, 'segment')
  const segment: any = await SavedSegment.findOne({ _id: segmentId, organizationId }).lean()
  if (!segment) throw new HttpError(404, 'Segment not found', 'No segment with that identifier exists in this organisation')

  let query: Record<string, unknown>
  try {
    query = compileSegment({
      organizationId,
      definition: { match: segment.match, conditions: segment.conditions } as SegmentDefinition,
      definitions: await definitionsFor(organizationId),
    })
  } catch (error) {
    if (error instanceof SegmentError) throw new HttpError(409, 'Segment can no longer be run', error.issues.join('; '), problemType('segment-stale'))
    throw error
  }

  const count = await Contact.countDocuments(query)
  const countedAt = new Date()
  await SavedSegment.updateOne({ _id: segmentId, organizationId }, { $set: { lastCount: count, lastCountedAt: countedAt } })
  res.json({ id: segmentId, count, countedAt })
}))

router.patch('/segments/:segmentId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const segmentId = objectId(req.params.segmentId, 'segment')

  const update: Record<string, unknown> = {}
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 120)
    if (!name) throw new HttpError(400, 'Name required', 'A segment name cannot be empty')
    update.name = name
  }
  if (req.body?.description !== undefined) update.description = String(req.body.description).slice(0, 1_000)

  if (req.body?.conditions !== undefined || req.body?.match !== undefined) {
    const definition = {
      match: req.body?.match === 'any' ? 'any' : 'all',
      conditions: req.body?.conditions ?? [],
    } as SegmentDefinition
    try {
      // Revalidated on every edit, so a segment cannot be saved into a state
      // that only fails when someone tries to use it.
      compileSegment({ organizationId, definition, definitions: await definitionsFor(organizationId) })
    } catch (error) {
      if (error instanceof SegmentError) throw new HttpError(400, 'Segment is invalid', error.issues.join('; '), problemType('segment-invalid'))
      throw error
    }
    update.match = definition.match
    update.conditions = definition.conditions
    // The cached count no longer describes these conditions.
    update.lastCount = null
    update.lastCountedAt = null
  }

  if (!Object.keys(update).length) throw new HttpError(400, 'Nothing to update', 'Supply at least one field to change')
  const result = await SavedSegment.updateOne({ _id: segmentId, organizationId }, { $set: update })
  if (!Number((result as any).matchedCount || 0)) throw new HttpError(404, 'Segment not found', 'No segment with that identifier exists in this organisation')
  await recordAudit({ req, organizationId, action: 'crm.segment_updated', entityType: 'SavedSegment', entityId: segmentId, metadata: { fields: Object.keys(update) } })
  res.json({ id: segmentId, updated: Object.keys(update) })
}))

router.delete('/segments/:segmentId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const segmentId = objectId(req.params.segmentId, 'segment')
  const result = await SavedSegment.deleteOne({ _id: segmentId, organizationId })
  if (!Number((result as any).deletedCount || 0)) throw new HttpError(404, 'Segment not found', 'No segment with that identifier exists in this organisation')
  await recordAudit({ req, organizationId, action: 'crm.segment_deleted', entityType: 'SavedSegment', entityId: segmentId })
  res.json({ id: segmentId, deleted: true })
}))

/* ----------------------------------------------------------------- pipelines */

router.get('/pipelines', asyncHandler(async (req, res) => {
  const rows: any[] = await Pipeline.find({ organizationId: requireOrganizationId(req), archivedAt: null }).limit(50).lean()
  res.json({
    pipelines: rows.map((row) => ({
      id: String(row._id), name: row.name, description: row.description, isDefault: Boolean(row.isDefault),
      stages: [...(row.stages || [])].sort((a: any, b: any) => a.position - b.position),
    })),
  })
}))

router.post('/pipelines', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const name = String(req.body?.name || '').trim().slice(0, 120)
  if (!name) throw new HttpError(400, 'Name required', 'A pipeline name is required')

  let stages
  try { stages = canonicaliseStages(req.body?.stages || []) } catch (error) {
    if (error instanceof PipelineError) throw new HttpError(400, 'Pipeline is invalid', error.issues.join('; '), problemType('pipeline-invalid'))
    throw error
  }
  await assertStageSequencesExist(organizationId, stages)

  try {
    const created: any = await Pipeline.create({ organizationId, name, description: req.body?.description, stages, isDefault: Boolean(req.body?.isDefault), createdBy: req.auth?.userId })
    await recordAudit({ req, organizationId, action: 'crm.pipeline_created', entityType: 'Pipeline', entityId: String(created._id), metadata: { name, stageCount: stages.length } })
    res.status(201).json({ id: String(created._id), name, stages })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Pipeline already exists', 'A pipeline with that name already exists', problemType('pipeline-duplicate-name'))
    throw error
  }
}))

router.put('/pipelines/:pipelineId/stages', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const pipelineId = objectId(req.params.pipelineId, 'pipeline')

  const existing: any = await Pipeline.findOne({ _id: pipelineId, organizationId }).lean()
  if (!existing) throw new HttpError(404, 'Pipeline not found', 'No pipeline with that identifier exists in this organisation')

  let stages
  try { stages = canonicaliseStages(req.body?.stages || []) } catch (error) {
    if (error instanceof PipelineError) throw new HttpError(400, 'Pipeline is invalid', error.issues.join('; '), problemType('pipeline-invalid'))
    throw error
  }
  await assertStageSequencesExist(organizationId, stages)

  // A stage that still holds deals cannot be removed silently. Refusing forces
  // the operator to move them, rather than leaving deals pointing at a stage
  // that no longer exists and vanishing from every board.
  const retained = new Set(stages.map((stage) => stage.stageId))
  const removed = (existing.stages || []).filter((stage: any) => !retained.has(String(stage.stageId)))
  for (const stage of removed) {
    const occupied = await Deal.countDocuments({ organizationId, pipelineId, stageId: stage.stageId })
    if (occupied > 0) {
      throw new HttpError(409, 'Stage still holds deals', `Stage "${stage.name}" still holds ${occupied} deal(s). Move them before removing it.`, problemType('pipeline-stage-occupied'))
    }
  }

  await Pipeline.updateOne({ _id: pipelineId, organizationId }, { $set: { stages } })
  await recordAudit({ req, organizationId, action: 'crm.pipeline_stages_updated', entityType: 'Pipeline', entityId: pipelineId, metadata: { stageCount: stages.length, removed: removed.length } })
  res.json({ id: pipelineId, stages })
}))

router.get('/pipelines/:pipelineId/board', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const pipelineId = objectId(req.params.pipelineId, 'pipeline')
  const board = await pipelineBoard({ organizationId, pipelineId, limitPerStage: pageLimit(req.query.limit) })
  if (!board) throw new HttpError(404, 'Pipeline not found', 'No pipeline with that identifier exists in this organisation')
  res.json(board)
}))

/* --------------------------------------------------------------------- deals */

router.post('/deals', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.body?.contactId, 'contact')
  const pipelineId = objectId(req.body?.pipelineId, 'pipeline')
  const title = String(req.body?.title || '').trim().slice(0, 200)
  if (!title) throw new HttpError(400, 'Title required', 'A deal title is required')

  const pipeline: any = await Pipeline.findOne({ _id: pipelineId, organizationId }).lean()
  if (!pipeline) throw new HttpError(404, 'Pipeline not found', 'No pipeline with that identifier exists in this organisation')
  if (!await Contact.exists({ _id: contactId, organizationId })) throw new HttpError(404, 'Contact not found', 'No contact with that identifier exists in this organisation')

  const stages = [...(pipeline.stages || [])].sort((a: any, b: any) => a.position - b.position)
  const requestedStageId = req.body?.stageId ? String(req.body.stageId) : String(stages[0]?.stageId || '')
  const stage = stages.find((candidate: any) => String(candidate.stageId) === requestedStageId)
  if (!stage) throw new HttpError(400, 'Stage not found', 'That stage does not exist in this pipeline', problemType('pipeline-stage-not-found'))

  const value = Number(req.body?.valueMinorUnits ?? 0)
  if (!Number.isInteger(value) || value < 0) throw new HttpError(400, 'Invalid value', 'Deal value must be a whole number of minor currency units and cannot be negative')

  const created: any = await Deal.create({
    organizationId, contactId, pipelineId, stageId: stage.stageId, title,
    valueMinorUnits: value,
    currency: String(req.body?.currency || 'USD').toUpperCase().slice(0, 3),
    expectedCloseAt: req.body?.expectedCloseAt ? new Date(String(req.body.expectedCloseAt)) : null,
    ownerUserId: req.body?.ownerUserId ? String(req.body.ownerUserId).slice(0, 64) : null,
    status: stage.outcome === 'open' ? 'open' : stage.outcome,
    createdBy: req.auth?.userId,
  })

  await recordActivity({ organizationId, contactId, type: 'deal.created', summary: `Deal "${title}" created in ${stage.name}`, entityType: 'Deal', entityId: String(created._id), metadata: { pipeline: pipeline.name, stage: stage.name }, actorUserId: req.auth?.userId })
  await recordAudit({ req, organizationId, action: 'crm.deal_created', entityType: 'Deal', entityId: String(created._id) })
  res.status(201).json({ id: String(created._id), stageId: stage.stageId })
}))

router.get('/deals', asyncHandler(async (req, res) => {
  const query: any = { organizationId: requireOrganizationId(req) }
  if (req.query.pipelineId) query.pipelineId = objectId(req.query.pipelineId, 'pipeline')
  if (req.query.contactId) query.contactId = objectId(req.query.contactId, 'contact')
  if (req.query.stageId) query.stageId = String(req.query.stageId).slice(0, 32)
  if (req.query.status) query.status = String(req.query.status).slice(0, 16)
  if (String(req.query.mine || '') === 'true') query.ownerUserId = String(req.auth?.userId || '')
  else if (req.query.ownerUserId) query.ownerUserId = String(req.query.ownerUserId).slice(0, 64)

  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) query._id = { $lt: cursor }

  const rows: any[] = await Deal.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    deals: rows.slice(0, limit).map(dealView),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

router.get('/deals/:dealId', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const dealId = objectId(req.params.dealId, 'deal')
  const deal: any = await Deal.findOne({ _id: dealId, organizationId }).lean()
  if (!deal) throw new HttpError(404, 'Deal not found', 'No deal with that identifier exists in this organisation')
  res.json({ deal: dealView(deal) })
}))

/**
 * Edit a deal.
 *
 * Stage is deliberately NOT editable here. Moving stage fires sequence
 * triggers, raises tasks and writes a timeline entry, all of which live in
 * `moveDeal`. Allowing a stage change through a generic patch would bypass
 * every one of them and leave a deal sitting in a stage whose automation never
 * ran — a silent failure nobody would attribute to the edit.
 */
router.patch('/deals/:dealId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const dealId = objectId(req.params.dealId, 'deal')

  if (req.body?.stageId !== undefined) {
    throw new HttpError(400, 'Use the stage endpoint', 'Stage changes fire automation and must go through POST /deals/:dealId/stage', problemType('deal-stage-requires-move'))
  }

  const update: Record<string, unknown> = {}
  if (req.body?.title !== undefined) {
    const title = String(req.body.title).trim().slice(0, 200)
    if (!title) throw new HttpError(400, 'Title required', 'A deal title cannot be empty')
    update.title = title
  }
  if (req.body?.valueMinorUnits !== undefined) {
    const value = Number(req.body.valueMinorUnits)
    if (!Number.isInteger(value) || value < 0) throw new HttpError(400, 'Invalid value', 'Deal value must be a whole number of minor currency units and cannot be negative')
    update.valueMinorUnits = value
  }
  if (req.body?.currency !== undefined) update.currency = String(req.body.currency).toUpperCase().slice(0, 3)
  if (req.body?.ownerUserId !== undefined) update.ownerUserId = req.body.ownerUserId ? String(req.body.ownerUserId).slice(0, 64) : null
  if (req.body?.expectedCloseAt !== undefined) {
    if (req.body.expectedCloseAt === null) update.expectedCloseAt = null
    else {
      const expected = new Date(String(req.body.expectedCloseAt))
      if (Number.isNaN(expected.getTime())) throw new HttpError(400, 'Invalid date', 'expectedCloseAt must be a valid date')
      update.expectedCloseAt = expected
    }
  }
  if (req.body?.lostReason !== undefined) update.lostReason = String(req.body.lostReason).slice(0, 500)

  if (!Object.keys(update).length) throw new HttpError(400, 'Nothing to update', 'Supply at least one field to change')

  const result = await Deal.updateOne({ _id: dealId, organizationId }, { $set: update })
  if (!Number((result as any).matchedCount || 0)) throw new HttpError(404, 'Deal not found', 'No deal with that identifier exists in this organisation')
  await recordAudit({ req, organizationId, action: 'crm.deal_updated', entityType: 'Deal', entityId: dealId, metadata: { fields: Object.keys(update) } })
  res.json({ id: dealId, updated: Object.keys(update) })
}))

router.delete('/deals/:dealId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const dealId = objectId(req.params.dealId, 'deal')
  const deal: any = await Deal.findOne({ _id: dealId, organizationId }).lean()
  if (!deal) throw new HttpError(404, 'Deal not found', 'No deal with that identifier exists in this organisation')

  await Deal.deleteOne({ _id: dealId, organizationId })
  // The timeline entry survives the deal. "This deal existed and was deleted"
  // is more useful to whoever asks later than a gap in the history.
  await recordActivity({
    organizationId, contactId: String(deal.contactId), type: 'deal.deleted',
    summary: `Deal "${deal.title}" deleted`, entityType: 'Deal', entityId: dealId,
    metadata: { valueMinorUnits: Number(deal.valueMinorUnits || 0), currency: deal.currency }, actorUserId: req.auth?.userId,
  })
  await recordAudit({ req, organizationId, action: 'crm.deal_deleted', entityType: 'Deal', entityId: dealId, metadata: { title: deal.title } })
  res.json({ id: dealId, deleted: true })
}))

/** The kanban drag-and-drop target. */
router.post('/deals/:dealId/stage', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const dealId = objectId(req.params.dealId, 'deal')
  const toStageId = String(req.body?.stageId || '').trim()
  if (!toStageId) throw new HttpError(400, 'Stage required', 'A target stageId is required')
  const result = await moveDeal({ organizationId, dealId, toStageId, userId: req.auth?.userId })
  res.json(result)
}))

/* --------------------------------------------------------------------- tags */

router.get('/tags', asyncHandler(async (req, res) => {
  res.json({ tags: await tagCatalogue(requireOrganizationId(req)) })
}))

/**
 * Add or remove tags, running whatever they trigger.
 *
 * The only sanctioned way to change tags. Rules fire on ACTUAL changes only, so
 * re-applying a tag a contact already has is a no-op rather than a re-enrolment.
 */
router.post('/contacts/:contactId/tags', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.params.contactId, 'contact')
  const add = Array.isArray(req.body?.add) ? req.body.add.map(String) : []
  const remove = Array.isArray(req.body?.remove) ? req.body.remove.map(String) : []
  if (!add.length && !remove.length) throw new HttpError(400, 'Nothing to change', 'Supply tags to add or remove')

  const result = await applyTagChanges({ organizationId, contactId, add, remove, userId: req.auth?.userId, source: 'manual' })
  res.json(result)
}))

router.get('/tag-rules', asyncHandler(async (req, res) => {
  const rows: any[] = await TagRule.find({ organizationId: requireOrganizationId(req) }).sort({ _id: -1 }).limit(200).lean()
  res.json({
    rules: rows.map((row) => ({
      id: String(row._id), tagKey: row.tagKey, event: row.event, status: row.status,
      enrolSequenceId: row.enrolSequenceId ? String(row.enrolSequenceId) : null,
      exitSequenceId: row.exitSequenceId ? String(row.exitSequenceId) : null,
      setLifecycleStatus: row.setLifecycleStatus, addTags: row.addTags, removeTags: row.removeTags,
      createTask: row.createTask, fireCount: Number(row.fireCount || 0), lastFiredAt: row.lastFiredAt,
    })),
  })
}))

router.post('/tag-rules', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const tagKey = normaliseTagKey(String(req.body?.tag || req.body?.tagKey || ''))
  if (!tagKey) throw new HttpError(400, 'Tag required', 'A tag is required')
  const event = req.body?.event === 'removed' ? 'removed' : 'added'

  // A rule whose own effect re-triggers it would loop until the depth guard
  // stops it. Refusing it here is clearer than letting it half-run.
  const addTags = dedupeTags(Array.isArray(req.body?.addTags) ? req.body.addTags.map(String) : [])
  const removeTags = dedupeTags(Array.isArray(req.body?.removeTags) ? req.body.removeTags.map(String) : [])
  const selfTrigger = event === 'added' ? addTags : removeTags
  if (selfTrigger.some((tag: string) => normaliseTagKey(tag) === tagKey)) {
    throw new HttpError(400, 'Rule would trigger itself', `This rule fires on "${tagKey}" and also applies it, which would loop.`, problemType('tag-rule-self-trigger'))
  }

  const created: any = await TagRule.create({
    organizationId, tagKey, event,
    enrolSequenceId: req.body?.enrolSequenceId ? objectId(req.body.enrolSequenceId, 'sequence') : null,
    exitSequenceId: req.body?.exitSequenceId ? objectId(req.body.exitSequenceId, 'sequence') : null,
    setLifecycleStatus: req.body?.setLifecycleStatus || null,
    addTags, removeTags,
    createTask: req.body?.createTask?.title ? {
      title: String(req.body.createTask.title).slice(0, 200),
      dueInHours: req.body.createTask.dueInHours == null ? null : Number(req.body.createTask.dueInHours),
      priority: ['low', 'high'].includes(req.body.createTask.priority) ? req.body.createTask.priority : 'normal',
    } : undefined,
    createdBy: req.auth?.userId,
  })
  await recordAudit({ req, organizationId, action: 'crm.tag_rule_created', entityType: 'TagRule', entityId: String(created._id), metadata: { tagKey, event } })
  res.status(201).json({ id: String(created._id), tagKey, event })
}))

router.delete('/tag-rules/:ruleId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const ruleId = objectId(req.params.ruleId, 'rule')
  const result = await TagRule.deleteOne({ _id: ruleId, organizationId })
  if (!Number((result as any).deletedCount || 0)) throw new HttpError(404, 'Rule not found', 'No tag rule with that identifier exists in this organisation')
  await recordAudit({ req, organizationId, action: 'crm.tag_rule_deleted', entityType: 'TagRule', entityId: ruleId })
  res.json({ id: ruleId, deleted: true })
}))

/* ---------------------------------------------------------------- companies */

router.get('/companies', asyncHandler(async (req, res) => {
  const query: any = { organizationId: requireOrganizationId(req), archivedAt: null }
  const search = String(req.query.q || '').trim().slice(0, 200)
  if (search) query.$text = { $search: search }
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await Company.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    companies: rows.slice(0, limit).map((row) => ({
      id: String(row._id), name: row.name, website: row.website, city: row.city,
      industry: row.industry, sizeBand: row.sizeBand, ownerUserId: row.ownerUserId,
      revenueMinorUnits: Number(row.revenueMinorUnits || 0), revenueCurrency: row.revenueCurrency,
    })),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

router.post('/companies', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const name = String(req.body?.name || '').trim().slice(0, 240)
  if (!name) throw new HttpError(400, 'Name required', 'A company name is required')
  try {
    const created: any = await Company.create({
      organizationId, name, nameLower: name.toLowerCase(),
      website: req.body?.website, phone: req.body?.phone, email: req.body?.email,
      industry: req.body?.industry, sizeBand: req.body?.sizeBand || null,
      addressLine1: req.body?.addressLine1, addressLine2: req.body?.addressLine2,
      city: req.body?.city, region: req.body?.region, postalCode: req.body?.postalCode, country: req.body?.country,
      ownerUserId: req.body?.ownerUserId || null,
      createdBy: req.auth?.userId,
    })
    res.status(201).json({ id: String(created._id), name })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Company already exists', 'A company with that name already exists', problemType('company-duplicate-name'))
    throw error
  }
}))

/** A company with everyone at it. The question a plain company name cannot answer. */
router.get('/companies/:companyId', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const companyId = objectId(req.params.companyId, 'company')
  const company: any = await Company.findOne({ _id: companyId, organizationId }).lean()
  if (!company) throw new HttpError(404, 'Company not found', 'No company with that identifier exists in this organisation')

  const [contacts, deals] = await Promise.all([
    Contact.find({ organizationId, companyId, archivedAt: null }).sort({ _id: -1 }).limit(200)
      .select('name firstName lastName email phone jobTitle lifecycleStatus').lean(),
    Deal.find({ organizationId, contactId: { $in: (await Contact.find({ organizationId, companyId }).select('_id').limit(200).lean()).map((row: any) => row._id) } })
      .sort({ _id: -1 }).limit(100).select('title stageId status valueMinorUnits currency').lean(),
  ])

  res.json({
    company: {
      id: companyId, name: company.name, website: company.website, phone: company.phone, email: company.email,
      industry: company.industry, sizeBand: company.sizeBand, ownerUserId: company.ownerUserId,
      addressLine1: company.addressLine1, addressLine2: company.addressLine2,
      city: company.city, region: company.region, postalCode: company.postalCode, country: company.country,
      revenueMinorUnits: Number(company.revenueMinorUnits || 0), revenueCurrency: company.revenueCurrency,
    },
    contacts: contacts.map((row: any) => ({
      id: String(row._id), name: row.name || [row.firstName, row.lastName].filter(Boolean).join(' '),
      jobTitle: row.jobTitle, email: row.email, phone: row.phone, lifecycleStatus: row.lifecycleStatus,
    })),
    deals: deals.map((row: any) => ({
      id: String(row._id), title: row.title, status: row.status,
      valueMinorUnits: Number(row.valueMinorUnits || 0), currency: row.currency,
    })),
  })
}))

/* -------------------------------------------------------------- attachments */

/**
 * Files against a contact.
 *
 * Stored through the existing artifact store — encrypted at rest, covered by
 * the same retention and organisation-erasure machinery as every other
 * artifact. There is deliberately no separate storage path for attachments: a
 * second place files can live is a second place they have to be found and
 * destroyed when someone asks.
 */
router.post('/contacts/:contactId/attachments', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.params.contactId, 'contact')
  if (!await Contact.exists({ _id: contactId, organizationId })) {
    throw new HttpError(404, 'Contact not found', 'No contact with that identifier exists in this organisation')
  }

  const fileName = String(req.body?.fileName || '').trim().slice(0, 240)
  const contentType = String(req.body?.contentType || 'application/octet-stream').slice(0, 120)
  const base64 = String(req.body?.contentBase64 || '')
  if (!fileName || !base64) throw new HttpError(400, 'File required', 'Supply fileName and contentBase64')

  const body = Buffer.from(base64, 'base64')
  if (!body.length) throw new HttpError(400, 'Empty file', 'The supplied file contains no data')

  const artifact = await storeArtifactFromBuffer({
    organizationId,
    kind: 'contact_attachment',
    fileName: safeDownloadFileName(fileName),
    contentType,
    body,
  })
  await Artifact.updateOne({ _id: (artifact as any).artifactId ?? (artifact as any)._id, organizationId }, { $set: { contactId } })

  await recordActivity({
    organizationId, contactId, type: 'contact.updated',
    summary: `File attached: ${safeDownloadFileName(fileName)}`,
    entityType: 'Artifact', entityId: String((artifact as any).artifactId ?? (artifact as any)._id),
    actorUserId: req.auth?.userId,
  })
  await recordAudit({ req, organizationId, action: 'crm.attachment_added', entityType: 'Contact', entityId: contactId, metadata: { fileName: safeDownloadFileName(fileName), bytes: body.length } })
  res.status(201).json({ id: String((artifact as any).artifactId ?? (artifact as any)._id), fileName: safeDownloadFileName(fileName) })
}))

router.get('/contacts/:contactId/attachments', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.params.contactId, 'contact')
  const rows: any[] = await Artifact.find({ organizationId, contactId, kind: 'contact_attachment', status: 'ready' })
    .sort({ _id: -1 }).limit(200).lean()
  res.json({
    attachments: rows.map((row) => ({
      id: String(row._id), fileName: row.fileName, contentType: row.contentType,
      sizeBytes: Number(row.plaintextSize || 0), createdAt: row.createdAt,
    })),
  })
}))

router.get('/contacts/:contactId/attachments/:artifactId', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.params.contactId, 'contact')
  const artifactId = objectId(req.params.artifactId, 'attachment')

  // Scoped to the contact as well as the organisation, so an artifact id from
  // elsewhere in the estate cannot be fetched through this route.
  const artifact: any = await Artifact.findOne({ _id: artifactId, organizationId, contactId, kind: 'contact_attachment' }).select('fileName contentType').lean()
  if (!artifact) throw new HttpError(404, 'Attachment not found', 'No attachment with that identifier exists on this contact')

  const opened = await openArtifact(organizationId, artifactId)
  res.setHeader('Content-Type', artifact.contentType || 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename="${safeDownloadFileName(String(artifact.fileName))}"`)
  await recordAudit({ req, organizationId, action: 'crm.attachment_downloaded', entityType: 'Artifact', entityId: artifactId })
  await pipeline(opened.stream, res)
}))

router.delete('/contacts/:contactId/attachments/:artifactId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.params.contactId, 'contact')
  const artifactId = objectId(req.params.artifactId, 'attachment')
  if (!await Artifact.exists({ _id: artifactId, organizationId, contactId, kind: 'contact_attachment' })) {
    throw new HttpError(404, 'Attachment not found', 'No attachment with that identifier exists on this contact')
  }
  const deleted = await deleteStoredArtifact(organizationId, artifactId)
  await recordAudit({ req, organizationId, action: 'crm.attachment_deleted', entityType: 'Artifact', entityId: artifactId })
  res.json({ id: artifactId, deleted })
}))

/* ------------------------------------------------------------- contact import */

function importRows(req: any): Record<string, string>[] {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
  if (!rows.length) throw new HttpError(400, 'No rows', 'Supply parsed CSV rows to import')
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(400, 'Too many rows', `An import cannot exceed ${MAX_IMPORT_ROWS} rows`)
  return rows
}

function importMapping(req: any): ColumnMapping[] {
  const mapping = Array.isArray(req.body?.mapping) ? req.body.mapping : []
  if (!mapping.length) throw new HttpError(400, 'No mapping', 'Supply a column mapping')
  return mapping.map((entry: any) => ({ column: String(entry?.column || ''), field: entry?.field ? String(entry.field) : null }))
}

/** Suggest a mapping for review. Never applied without confirmation. */
router.post('/contacts/import/mapping', asyncHandler(async (req, res) => {
  requireOperator(req)
  const headers = Array.isArray(req.body?.headers) ? req.body.headers.map((header: unknown) => String(header)) : []
  if (!headers.length) throw new HttpError(400, 'No headers', 'Supply the CSV header row')
  res.json({ mapping: suggestMapping(headers, await definitionsFor(requireOrganizationId(req))) })
}))

/** Preview. Nothing is written. */
router.post('/contacts/import/preview', asyncHandler(async (req, res) => {
  requireOperator(req)
  res.json(await previewImport({
    organizationId: requireOrganizationId(req),
    rows: importRows(req),
    mapping: importMapping(req),
    sampleSize: Number(req.body?.sampleSize) || undefined,
  }))
}))

/**
 * Apply. Separate from preview on purpose — an operator sees what will happen
 * before anything is written, which is the whole point of the pattern.
 */
router.post('/contacts/import/apply', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const result = await applyImport({
    organizationId,
    rows: importRows(req),
    mapping: importMapping(req),
    source: req.body?.source ? String(req.body.source).slice(0, 64) : undefined,
    userId: req.auth?.userId,
  })
  await recordAudit({ req, organizationId, action: 'crm.contacts_imported', entityType: 'Organization', entityId: organizationId, metadata: { ...result } })
  res.status(201).json({
    ...result,
    // Stated on every import rather than left to documentation.
    note: 'Imported contacts carry no consent record. A list from a spreadsheet is not a lawful basis for contacting anyone on it.',
  })
}))

/* ----------------------------------------------------------------- payments */

router.post('/payments/credential', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  await storeStripeCredential({ organizationId, secretKey: String(req.body?.secretKey || ''), userId: req.auth?.userId })
  res.status(201).json({
    linked: true,
    note: 'This is your own Stripe account. Payments go to you, not to the platform.',
  })
}))

router.post('/payments/links', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  res.status(201).json(await createPaymentLink({
    organizationId,
    contactId: objectId(req.body?.contactId, 'contact'),
    dealId: req.body?.dealId ? objectId(req.body.dealId, 'deal') : null,
    description: String(req.body?.description || ''),
    amountMinorUnits: Number(req.body?.amountMinorUnits),
    currency: String(req.body?.currency || 'USD'),
    userId: req.auth?.userId,
  }))
}))

router.get('/payments/links', asyncHandler(async (req, res) => {
  const query: any = { organizationId: requireOrganizationId(req) }
  if (req.query.contactId) query.contactId = objectId(req.query.contactId, 'contact')
  if (req.query.status) query.status = String(req.query.status).slice(0, 16)
  const rows: any[] = await PaymentLink.find(query).sort({ _id: -1 }).limit(pageLimit(req.query.limit)).lean()
  res.json({
    links: rows.map((row) => ({
      id: String(row._id), contactId: String(row.contactId), description: row.description,
      amountMinorUnits: Number(row.amountMinorUnits || 0), currency: row.currency,
      status: row.status, url: row.url, paidAt: row.paidAt, createdAt: row.createdAt,
    })),
  })
}))

/**
 * Manual reconciliation, for a payment confirmed out of band.
 *
 * Idempotent: marking an already-paid link has no effect, so this cannot double
 * a contact's recorded revenue.
 */
router.post('/payments/links/:linkId/mark-paid', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const linkId = objectId(req.params.linkId, 'payment link')
  res.json(await markPaymentReceived({ organizationId, paymentLinkId: linkId }))
}))

export default router
