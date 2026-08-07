import Contact from '../../models/Contact'
import CustomFieldDefinition from '../../models/CustomFieldDefinition'
import { normalizeEmail, normalizePhone } from '../batchNormalization'
import { recordActivity } from './contactActivity'
import { applyCustomFields, CustomFieldError, normaliseFieldKey, type CustomFieldDefinitionView } from './customFields'

/**
 * Importing contacts from a CSV.
 *
 * The specification calls for reusing the existing batch preview-and-approve
 * machinery, and the shape here follows it: a file is parsed, every row is
 * validated, a preview is returned, and nothing is written until an operator
 * approves what they have seen.
 *
 * The one deviation is deliberate. `batchService` canonicalises operations
 * against EXTERNAL connector providers — HighLevel, HubSpot, Klaviyo — and
 * every operation it knows about ends in a call to one of them. A local
 * contact import writes to this database and calls no provider, so routing it
 * through that path would mean adding a fake provider whose executor writes
 * locally. That would put a local write behind machinery built around
 * remote-call semantics: lease stages named `remote_started`, `outcome_unknown`
 * for calls that may have happened. None of it applies, and pretending it does
 * would make the batch code harder to reason about for everyone.
 *
 * So this module reuses the *pattern* — validate everything, preview, approve,
 * then apply — without pretending a local insert is a remote call.
 *
 * WHAT IMPORT DOES NOT DO
 *
 * It does not create consent. A list uploaded from a spreadsheet carries no
 * lawful basis for contacting anyone on it, and nothing here manufactures one.
 * Imported contacts are still subject to suppression on every send.
 */

export const MAX_IMPORT_ROWS = 50_000

/** Built-in contact fields a CSV column may map to. */
export const IMPORTABLE_FIELDS = [
  'firstName', 'lastName', 'name', 'companyName', 'email', 'phone',
  'timezone', 'country', 'postalCode', 'website', 'source', 'tags', 'lifecycleStatus',
] as const
export type ImportableField = (typeof IMPORTABLE_FIELDS)[number]

const LIFECYCLE_VALUES = new Set(['lead', 'engaged', 'qualified', 'customer', 'churned', 'unqualified'])

export interface ColumnMapping {
  /** CSV header. */
  column: string
  /** Built-in field name, or `custom:<key>`, or null to ignore the column. */
  field: string | null
}

export interface ImportRowResult {
  rowNumber: number
  status: 'create' | 'update' | 'skip'
  reason?: string
  email?: string
  phone?: string
  name?: string
}

export interface ImportPreview {
  totalRows: number
  toCreate: number
  toUpdate: number
  toSkip: number
  /** First N rows, for the operator to eyeball before approving. */
  sample: ImportRowResult[]
  /** Per-reason counts, so a systematic mapping error is visible at a glance. */
  skipReasons: Record<string, number>
  unmappedColumns: string[]
}

/**
 * Suggest a mapping from CSV headers to fields.
 *
 * A suggestion the operator confirms, never applied silently. A column headed
 * "Mobile" mapping itself to `phone` is helpful; the same column silently
 * overwriting every contact's primary number without anyone looking is not.
 */
export function suggestMapping(headers: string[], definitions: CustomFieldDefinitionView[]): ColumnMapping[] {
  const byNormalised = new Map<string, string>()
  for (const field of IMPORTABLE_FIELDS) byNormalised.set(normaliseFieldKey(field), field)
  // Common header spellings that do not normalise onto a field name.
  //
  // The single-word forms matter as much as the aliases: "lastname" normalises
  // to `lastname`, while the field `lastName` normalises to `last_name`, so
  // they do not meet without being listed. A snake_case normaliser cannot know
  // "lastname" is two words, and these are among the most common headers in a
  // real CSV export.
  for (const [alias, field] of [
    ['firstname', 'firstName'], ['lastname', 'lastName'], ['companyname', 'companyName'],
    ['fullname', 'name'], ['contactname', 'name'], ['postalcode', 'postalCode'],
    ['phonenumber', 'phone'], ['emailaddress', 'email'], ['mobilenumber', 'phone'],
    ['zipcode', 'postalCode'], ['lifecycle', 'lifecycleStatus'], ['status', 'lifecycleStatus'],
    ['mobile', 'phone'], ['phone_number', 'phone'], ['telephone', 'phone'], ['cell', 'phone'],
    ['email_address', 'email'], ['e_mail', 'email'],
    ['first', 'firstName'], ['given_name', 'firstName'],
    ['last', 'lastName'], ['surname', 'lastName'], ['family_name', 'lastName'],
    ['company', 'companyName'], ['organisation', 'companyName'], ['organization', 'companyName'],
    ['zip', 'postalCode'], ['zip_code', 'postalCode'], ['postcode', 'postalCode'],
    ['full_name', 'name'], ['contact_name', 'name'],
  ] as const) byNormalised.set(alias, field)

  for (const definition of definitions) byNormalised.set(definition.key, `custom:${definition.key}`)

  return headers.map((column) => ({
    column,
    field: byNormalised.get(normaliseFieldKey(column)) ?? null,
  }))
}

interface PreparedRow {
  rowNumber: number
  contactFields: Record<string, unknown>
  customValues: Record<string, unknown>
  email: string
  phone: string
  tags: string[]
  issues: string[]
}

function prepareRow(row: Record<string, string>, rowNumber: number, mapping: ColumnMapping[]): PreparedRow {
  const contactFields: Record<string, unknown> = {}
  const customValues: Record<string, unknown> = {}
  const issues: string[] = []
  let tags: string[] = []

  for (const entry of mapping) {
    if (!entry.field) continue
    const raw = String(row[entry.column] ?? '').trim()
    if (!raw) continue

    if (entry.field.startsWith('custom:')) {
      customValues[normaliseFieldKey(entry.field.slice('custom:'.length))] = raw
      continue
    }
    if (entry.field === 'tags') {
      tags = raw.split(/[;,|]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 50)
      continue
    }
    if (entry.field === 'lifecycleStatus') {
      if (!LIFECYCLE_VALUES.has(raw.toLowerCase())) issues.push(`lifecycleStatus "${raw}" is not a recognised value`)
      else contactFields.lifecycleStatus = raw.toLowerCase()
      continue
    }
    contactFields[entry.field] = raw.slice(0, 320)
  }

  const email = contactFields.email ? normalizeEmail(String(contactFields.email)) : ''
  const rawPhone = contactFields.phone ? normalizePhone(String(contactFields.phone), '') : ''
  const phone = rawPhone.startsWith('+') && rawPhone.length >= 8 ? rawPhone : ''

  if (contactFields.email && !email) issues.push(`"${String(contactFields.email)}" is not a valid email address`)
  if (contactFields.phone && !phone) issues.push(`"${String(contactFields.phone)}" is not a phone number in international format`)

  if (email) contactFields.email = email
  else delete contactFields.email
  if (phone) contactFields.phone = phone
  else delete contactFields.phone

  return { rowNumber, contactFields, customValues, email, phone, tags, issues }
}

async function classifyRow(organizationId: string, prepared: PreparedRow, definitions: CustomFieldDefinitionView[], seen: Set<string>): Promise<ImportRowResult> {
  const base = {
    rowNumber: prepared.rowNumber,
    email: prepared.email || undefined,
    phone: prepared.phone || undefined,
    name: (prepared.contactFields.name || [prepared.contactFields.firstName, prepared.contactFields.lastName].filter(Boolean).join(' ') || undefined) as string | undefined,
  }

  // A row with no reachable address cannot be sent to on any channel, so
  // importing it creates a contact every sequence immediately exits.
  if (!prepared.email && !prepared.phone) return { ...base, status: 'skip', reason: 'no_email_or_phone' }
  if (prepared.issues.length) return { ...base, status: 'skip', reason: prepared.issues[0] }

  // Duplicates WITHIN the file are caught here. Two rows for the same person
  // would otherwise become a create followed by an update, and whichever row
  // came last would silently win.
  const identity = prepared.email || prepared.phone
  if (seen.has(identity)) return { ...base, status: 'skip', reason: 'duplicate_within_file' }
  seen.add(identity)

  try {
    // Non-strict: an unrecognised column is reported, not fatal. A supplier's
    // export is not the operator's to control, and losing 500 leads over one
    // stray column is the wrong trade.
    applyCustomFields({ definitions, values: prepared.customValues, strict: false })
  } catch (error) {
    if (error instanceof CustomFieldError) return { ...base, status: 'skip', reason: error.issues[0] }
    throw error
  }

  const identifiers: Array<Record<string, unknown>> = []
  if (prepared.email) identifiers.push({ email: prepared.email })
  if (prepared.phone) identifiers.push({ phone: prepared.phone })
  const existing = await Contact.findOne({ organizationId, $or: identifiers }).select('_id').lean()
  return { ...base, status: existing ? 'update' : 'create' }
}

export async function previewImport(input: {
  organizationId: string
  rows: Record<string, string>[]
  mapping: ColumnMapping[]
  sampleSize?: number
}): Promise<ImportPreview> {
  const definitions = await definitionsFor(input.organizationId)
  const seen = new Set<string>()
  const preview: ImportPreview = {
    totalRows: input.rows.length, toCreate: 0, toUpdate: 0, toSkip: 0,
    sample: [], skipReasons: {},
    unmappedColumns: input.mapping.filter((entry) => !entry.field).map((entry) => entry.column),
  }
  const sampleSize = Math.max(1, Math.min(input.sampleSize ?? 25, 200))

  for (const [index, row] of input.rows.entries()) {
    const result = await classifyRow(input.organizationId, prepareRow(row, index + 2, input.mapping), definitions, seen)
    if (result.status === 'create') preview.toCreate += 1
    else if (result.status === 'update') preview.toUpdate += 1
    else {
      preview.toSkip += 1
      const reason = result.reason || 'unknown'
      preview.skipReasons[reason] = (preview.skipReasons[reason] || 0) + 1
    }
    if (preview.sample.length < sampleSize) preview.sample.push(result)
  }
  return preview
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
  skipReasons: Record<string, number>
}

/**
 * Apply an import.
 *
 * Row by row rather than in bulk, because a bulk write that fails partway
 * leaves no record of which rows landed. At import sizes this runs in seconds
 * and the clarity is worth more than the throughput.
 */
export async function applyImport(input: {
  organizationId: string
  rows: Record<string, string>[]
  mapping: ColumnMapping[]
  source?: string
  userId?: string
}): Promise<ImportResult> {
  const definitions = await definitionsFor(input.organizationId)
  const seen = new Set<string>()
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, skipReasons: {} }

  for (const [index, row] of input.rows.entries()) {
    const prepared = prepareRow(row, index + 2, input.mapping)
    const classified = await classifyRow(input.organizationId, prepared, definitions, seen)
    if (classified.status === 'skip') {
      result.skipped += 1
      const reason = classified.reason || 'unknown'
      result.skipReasons[reason] = (result.skipReasons[reason] || 0) + 1
      continue
    }

    const customFields = applyCustomFields({ definitions, values: prepared.customValues, strict: false }).values
    const identifiers: Array<Record<string, unknown>> = []
    if (prepared.email) identifiers.push({ email: prepared.email })
    if (prepared.phone) identifiers.push({ phone: prepared.phone })

    const existing: any = await Contact.findOne({ organizationId: input.organizationId, $or: identifiers }).select('_id customFields').lean()
    if (existing) {
      await Contact.updateOne({ _id: existing._id, organizationId: input.organizationId }, {
        // Merged, not replaced: an import must not erase custom field values
        // the spreadsheet simply did not carry a column for.
        $set: { ...prepared.contactFields, customFields: { ...(existing.customFields || {}), ...customFields } },
        ...(prepared.tags.length ? { $addToSet: { tags: { $each: prepared.tags } } } : {}),
      })
      result.updated += 1
    } else {
      const created: any = await Contact.create({
        organizationId: input.organizationId,
        ...prepared.contactFields,
        customFields,
        tags: prepared.tags,
        source: input.source || 'csv_import',
        lifecycleStatus: prepared.contactFields.lifecycleStatus || 'lead',
      })
      await recordActivity({
        organizationId: input.organizationId, contactId: String(created._id), type: 'contact.created',
        summary: 'Contact created by CSV import', metadata: { source: input.source || 'csv_import' }, actorUserId: input.userId,
      })
      result.created += 1
    }
  }
  return result
}

async function definitionsFor(organizationId: string): Promise<CustomFieldDefinitionView[]> {
  const rows: any[] = await CustomFieldDefinition.find({ organizationId }).limit(500).lean()
  return rows.map((row) => ({
    key: row.key, label: row.label, type: row.type, required: Boolean(row.required),
    options: row.options || [], min: row.min, max: row.max, helpText: row.helpText,
  }))
}
