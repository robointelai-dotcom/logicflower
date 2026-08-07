import crypto from 'crypto'
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { Types } from 'mongoose'
import Contact from '../models/Contact'
import CustomFieldDefinition from '../models/CustomFieldDefinition'
import Deal from '../models/Deal'
import FormSubmission from '../models/FormSubmission'
import HostedForm from '../models/HostedForm'
import Pipeline from '../models/Pipeline'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { requireOrganizationId } from '../types/authenticatedRequest'
import { recordAudit } from '../services/audit'
import { applyCustomFields, CustomFieldError, normaliseFieldKey, type CustomFieldDefinitionView } from '../services/crm/customFields'
import { recordActivity } from '../services/crm/contactActivity'
import { enrolContact } from '../services/sequences/enrolmentService'
import { normalizeEmail, normalizePhone } from '../services/batchNormalization'

/**
 * Hosted forms.
 *
 * The submission endpoint is public and unauthenticated by necessity — it is
 * embedded on a customer's own website — which makes it the widest attack
 * surface in Phase 2. The controls, in the order they apply:
 *
 *  - The form is addressed by an unguessable slug, not by its document id, so
 *    the estate cannot be enumerated.
 *  - The organisation is derived from the matched form. Nothing in the request
 *    body selects a tenant.
 *  - Only fields the form declares are read. A submission carrying extra keys
 *    has them ignored, not stored, so the endpoint cannot be used to write
 *    arbitrary contact data or custom fields the operator never defined.
 *  - Rate limited per IP, and the response does not reveal whether a contact
 *    already existed.
 */

const router = Router()
export const publicFormRouter = Router()

const submissionLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false })
const formFetchLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false })

/** Built-in contact fields a form may collect. Deliberately short. */
const BUILT_IN_FORM_FIELDS = new Set(['firstName', 'lastName', 'name', 'companyName', 'email', 'phone', 'timezone', 'country', 'postalCode', 'website'])

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

async function definitionsFor(organizationId: string): Promise<CustomFieldDefinitionView[]> {
  const rows: any[] = await CustomFieldDefinition.find({ organizationId }).limit(500).lean()
  return rows.map((row) => ({
    key: row.key, label: row.label, type: row.type, required: Boolean(row.required),
    options: row.options || [], min: row.min, max: row.max, helpText: row.helpText,
  }))
}

function validateFormFields(input: unknown, definitions: CustomFieldDefinitionView[]) {
  const fields = Array.isArray(input) ? input : []
  if (!fields.length) throw new HttpError(400, 'Form has no fields', 'A form requires at least one field')
  if (fields.length > 40) throw new HttpError(400, 'Too many fields', 'A form cannot have more than 40 fields')

  const definedKeys = new Set(definitions.map((definition) => definition.key))
  const seen = new Set<string>()
  return fields.map((field: any, position: number) => {
    const name = String(field?.field || '').trim()
    if (!name) throw new HttpError(400, 'Field required', `Field ${position + 1} has no field name`)
    if (seen.has(name)) throw new HttpError(400, 'Duplicate field', `Field "${name}" appears more than once`)
    seen.add(name)

    if (name.startsWith('custom:')) {
      const key = normaliseFieldKey(name.slice('custom:'.length))
      if (!definedKeys.has(key)) {
        throw new HttpError(400, 'Unknown custom field', `Field "${name}" has no custom field definition`, problemType('custom-field-invalid'))
      }
    } else if (!BUILT_IN_FORM_FIELDS.has(name)) {
      throw new HttpError(400, 'Unknown field', `"${name}" is not a collectable contact field`, problemType('form-field-invalid'))
    }

    return {
      field: name,
      label: String(field?.label || name).slice(0, 200),
      required: Boolean(field?.required),
      placeholder: field?.placeholder ? String(field.placeholder).slice(0, 200) : undefined,
      position,
    }
  })
}

/* ---------------------------------------------------------- management (auth) */

router.get('/', asyncHandler(async (req, res) => {
  const rows: any[] = await HostedForm.find({ organizationId: requireOrganizationId(req) }).sort({ _id: -1 }).limit(100).lean()
  res.json({
    forms: rows.map((row) => ({
      id: String(row._id), name: row.name, slug: row.slug, status: row.status,
      fields: row.fields, enrolSequenceId: row.enrolSequenceId ? String(row.enrolSequenceId) : null,
      submissionCount: Number(row.submissionCount || 0), consentText: row.consentText,
      allowedOrigins: row.allowedOrigins || [],
    })),
  })
}))

router.post('/', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const name = String(req.body?.name || '').trim().slice(0, 120)
  if (!name) throw new HttpError(400, 'Name required', 'A form name is required')

  const definitions = await definitionsFor(organizationId)
  const fields = validateFormFields(req.body?.fields, definitions)

  if (req.body?.createDealInPipelineId) {
    const pipeline: any = await Pipeline.findOne({ _id: objectId(req.body.createDealInPipelineId, 'pipeline'), organizationId }).lean()
    if (!pipeline) throw new HttpError(404, 'Pipeline not found', 'No pipeline with that identifier exists in this organisation')
    const stageId = String(req.body?.createDealInStageId || '')
    if (!(pipeline.stages || []).some((stage: any) => String(stage.stageId) === stageId)) {
      throw new HttpError(400, 'Stage not found', 'That stage does not exist in the selected pipeline', problemType('pipeline-stage-not-found'))
    }
  }

  try {
    const created: any = await HostedForm.create({
      organizationId,
      name,
      // 18 random bytes, not the document id: an enumerable endpoint invites
      // someone to walk every form in the estate.
      slug: crypto.randomBytes(18).toString('base64url'),
      status: 'draft',
      fields,
      enrolSequenceId: req.body?.enrolSequenceId ? objectId(req.body.enrolSequenceId, 'sequence') : null,
      createDealInPipelineId: req.body?.createDealInPipelineId ? objectId(req.body.createDealInPipelineId, 'pipeline') : null,
      createDealInStageId: req.body?.createDealInStageId ? String(req.body.createDealInStageId) : null,
      applyTags: Array.isArray(req.body?.applyTags) ? req.body.applyTags.map((tag: unknown) => String(tag).slice(0, 64)).slice(0, 20) : [],
      successMessage: String(req.body?.successMessage || 'Thanks — we have your details.').slice(0, 500),
      allowedOrigins: Array.isArray(req.body?.allowedOrigins) ? req.body.allowedOrigins.map((origin: unknown) => String(origin).slice(0, 200)).slice(0, 20) : [],
      consentText: req.body?.consentText ? String(req.body.consentText).slice(0, 2_000) : null,
      createdBy: req.auth?.userId,
    })
    await recordAudit({ req, organizationId, action: 'crm.form_created', entityType: 'HostedForm', entityId: String(created._id), metadata: { name } })
    res.status(201).json({ id: String(created._id), slug: created.slug, status: 'draft' })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Form already exists', 'A form with that name already exists', problemType('form-duplicate-name'))
    throw error
  }
}))

router.post('/:formId/status', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const formId = objectId(req.params.formId, 'form')
  const status = String(req.body?.status || '')
  if (!['draft', 'published', 'disabled'].includes(status)) throw new HttpError(400, 'Invalid status', 'Status must be draft, published or disabled')
  const result = await HostedForm.updateOne({ _id: formId, organizationId }, { $set: { status } })
  if (!Number((result as any).matchedCount || 0)) throw new HttpError(404, 'Form not found', 'No form with that identifier exists in this organisation')
  await recordAudit({ req, organizationId, action: 'crm.form_status_changed', entityType: 'HostedForm', entityId: formId, metadata: { status } })
  res.json({ id: formId, status })
}))

router.get('/:formId/submissions', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const formId = objectId(req.params.formId, 'form')
  const rows: any[] = await FormSubmission.find({ organizationId, formId }).sort({ _id: -1 }).limit(100).lean()
  res.json({
    submissions: rows.map((row) => ({
      id: String(row._id), contactId: row.contactId ? String(row.contactId) : null,
      values: row.values, createdAt: row.createdAt, origin: row.origin,
      // The wording shown at the time, copied not referenced: a later edit to
      // the form must not rewrite what a past submitter agreed to.
      consentTextShown: row.consentTextShown, consentGivenAt: row.consentGivenAt,
    })),
  })
}))

/* ------------------------------------------------------------- public (open) */

/** Render contract for an embedded form. Published forms only. */
publicFormRouter.get('/:slug', formFetchLimiter, asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').slice(0, 64)
  // tenant-safe: public endpoint; the unguessable slug is the identifier and the organisation is derived from the matched form
  const form: any = await HostedForm.findOne({ slug, status: 'published' }).select('name fields successMessage consentText').lean()
  if (!form) throw new HttpError(404, 'Form not found', 'No published form matches this address', problemType('form-not-found'))
  res.json({
    name: form.name,
    fields: [...(form.fields || [])].sort((a: any, b: any) => a.position - b.position),
    consentText: form.consentText,
    successMessage: form.successMessage,
  })
}))

publicFormRouter.post('/:slug/submissions', submissionLimiter, asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').slice(0, 64)
  // tenant-safe: public endpoint; the unguessable slug is the identifier and the organisation is derived from the matched form
  const form: any = await HostedForm.findOne({ slug, status: 'published' }).lean()
  if (!form) throw new HttpError(404, 'Form not found', 'No published form matches this address', problemType('form-not-found'))

  const organizationId = String(form.organizationId)
  const origin = String(req.headers.origin || '').slice(0, 200)
  if ((form.allowedOrigins || []).length && origin && !form.allowedOrigins.includes(origin)) {
    throw new HttpError(403, 'Origin rejected', 'This form does not accept submissions from that origin', problemType('form-origin-rejected'))
  }

  const submitted = req.body && typeof req.body === 'object' ? req.body : {}
  const values: Record<string, unknown> = {}
  const customValues: Record<string, unknown> = {}

  // Only declared fields are read. Extra keys in the body are ignored rather
  // than stored, so this endpoint cannot write contact data the form never
  // asked for or custom fields the operator never defined.
  for (const field of form.fields || []) {
    const raw = (submitted as Record<string, unknown>)[field.field]
    const isEmpty = raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())
    if (isEmpty) {
      if (field.required) throw new HttpError(400, 'Missing field', `"${field.label}" is required`, problemType('form-field-required'))
      continue
    }
    if (String(field.field).startsWith('custom:')) customValues[normaliseFieldKey(String(field.field).slice('custom:'.length))] = raw
    else values[field.field] = typeof raw === 'string' ? raw.slice(0, 1_000) : raw
  }

  let customFields: Record<string, unknown> = {}
  try {
    customFields = applyCustomFields({ definitions: await definitionsFor(organizationId), values: customValues, strict: true }).values
  } catch (error) {
    if (error instanceof CustomFieldError) throw new HttpError(400, 'Submission invalid', error.issues.join('; '), problemType('custom-field-invalid'))
    throw error
  }

  const email = values.email ? normalizeEmail(String(values.email)) : ''
  const phone = values.phone ? normalizePhone(String(values.phone), '') : ''
  if (!email && !phone.startsWith('+')) {
    throw new HttpError(400, 'No contact address', 'A submission must include a valid email address or phone number', problemType('form-no-address'))
  }

  // Match an existing contact on either identifier so a repeat submitter is
  // updated rather than duplicated.
  const match: Record<string, unknown> = { organizationId }
  const identifiers: Array<Record<string, unknown>> = []
  if (email) identifiers.push({ email })
  if (phone.startsWith('+')) identifiers.push({ phone })
  match.$or = identifiers

  const existing: any = await Contact.findOne(match).select('_id').lean()
  let contactId: string
  const contactUpdate: Record<string, unknown> = {
    ...(email ? { email } : {}),
    ...(phone.startsWith('+') ? { phone } : {}),
    ...(values.firstName ? { firstName: String(values.firstName).slice(0, 120) } : {}),
    ...(values.lastName ? { lastName: String(values.lastName).slice(0, 120) } : {}),
    ...(values.name ? { name: String(values.name).slice(0, 240) } : {}),
    ...(values.companyName ? { companyName: String(values.companyName).slice(0, 240) } : {}),
    ...(values.timezone ? { timezone: String(values.timezone).slice(0, 64) } : {}),
    ...(values.country ? { country: String(values.country).slice(0, 120) } : {}),
    ...(values.postalCode ? { postalCode: String(values.postalCode).slice(0, 32) } : {}),
    ...(values.website ? { website: String(values.website).slice(0, 500) } : {}),
  }

  if (existing) {
    contactId = String(existing._id)
    const merged: any = await Contact.findOne({ _id: contactId, organizationId }).select('customFields').lean()
    await Contact.updateOne({ _id: contactId, organizationId }, {
      $set: { ...contactUpdate, customFields: { ...(merged?.customFields || {}), ...customFields } },
      ...(form.applyTags?.length ? { $addToSet: { tags: { $each: form.applyTags } } } : {}),
    })
  } else {
    const created: any = await Contact.create({
      organizationId, ...contactUpdate, customFields,
      tags: form.applyTags || [], source: `form:${form.name}`, lifecycleStatus: 'lead',
    })
    contactId = String(created._id)
    await recordActivity({ organizationId, contactId, type: 'contact.created', summary: `Contact created from form "${form.name}"`, metadata: { source: `form:${form.name}` } })
  }

  const submission: any = await FormSubmission.create({
    organizationId,
    formId: form._id,
    contactId,
    values: { ...values, ...customFields },
    consentTextShown: form.consentText || null,
    consentGivenAt: form.consentText ? new Date() : null,
    submittedFromIp: String(req.ip || '').slice(0, 64),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
    origin,
  })

  let dealId: string | null = null
  if (form.createDealInPipelineId && form.createDealInStageId) {
    const deal: any = await Deal.create({
      organizationId, contactId,
      pipelineId: form.createDealInPipelineId,
      stageId: form.createDealInStageId,
      title: `Enquiry from ${form.name}`,
      status: 'open',
    })
    dealId = String(deal._id)
  }

  let enrolmentId: string | null = null
  if (form.enrolSequenceId) {
    const enrolment = await enrolContact({ organizationId, sequenceId: String(form.enrolSequenceId), contactId, source: `form:${form.name}` })
    enrolmentId = enrolment.enrolmentId || null
  }

  await FormSubmission.updateOne({ _id: submission._id, organizationId }, { $set: { dealId, enrolmentId } })
  await HostedForm.updateOne({ _id: form._id, organizationId }, { $inc: { submissionCount: 1 } })
  await recordActivity({ organizationId, contactId, type: 'form.submitted', summary: `Submitted form "${form.name}"`, entityType: 'FormSubmission', entityId: String(submission._id), metadata: { form: form.name } })

  // The response is identical whether a contact was created or updated: telling
  // a submitter "you already exist here" is an account-enumeration oracle.
  res.status(201).json({ ok: true, message: form.successMessage })
}))

export default router
