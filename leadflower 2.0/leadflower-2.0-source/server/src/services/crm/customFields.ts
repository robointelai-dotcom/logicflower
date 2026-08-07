import { normalizeEmail, normalizePhone } from '../batchNormalization'
import { isSupportedTimeZone } from '../sequences/scheduleArithmetic'

/**
 * Custom field definitions.
 *
 * The rule this module exists to enforce: a contact cannot carry a custom field
 * key that has no definition. It sounds bureaucratic and it is the difference
 * between a contact store and a junk drawer. Once arbitrary keys are permitted,
 * `phone_2`, `phone2`, `secondaryPhone` and `Phone 2` all coexist, no segment
 * can be built over any of them, and no import can be validated. Recovering
 * from that requires a data migration nobody will authorise.
 *
 * So: definitions are per organisation, declare a type, and values are coerced
 * and validated against that type on every write.
 *
 * Values are stored as a map rather than as schema fields because Mongo has no
 * per-tenant schema, and adding a real field per customer field would make the
 * collection unmanageable across thousands of organisations.
 */

export const CUSTOM_FIELD_TYPES = [
  'text', 'longtext', 'number', 'boolean', 'date', 'email', 'phone', 'url', 'single_select', 'multi_select', 'timezone',
] as const
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

export const MAX_DEFINITIONS_PER_ORGANIZATION = 200
export const MAX_TEXT_LENGTH = 1_000
export const MAX_LONGTEXT_LENGTH = 20_000
export const MAX_SELECT_OPTIONS = 200
export const MAX_MULTI_SELECT_VALUES = 50

export interface CustomFieldDefinitionInput {
  key: string
  label: string
  type: CustomFieldType
  required?: boolean
  options?: string[]
  /** Applies to number fields only. */
  min?: number
  max?: number
  helpText?: string
}

export interface CustomFieldDefinitionView extends CustomFieldDefinitionInput {
  options: string[]
}

export class CustomFieldError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join('; '))
    this.name = 'CustomFieldError'
    this.issues = issues
  }
}

/**
 * Canonical form of a field key.
 *
 * Lowercase snake_case, letters/digits/underscore only, must start with a
 * letter. Normalising rather than rejecting mixed case means an operator typing
 * "Preferred Contact Time" gets `preferred_contact_time` instead of an error,
 * while `preferredContactTime` and `Preferred Contact Time` collapse to the
 * same key rather than becoming two fields.
 */
export function normaliseFieldKey(input: string): string {
  return String(input || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
}

/**
 * Keys that would collide with a first-class Contact field.
 *
 * A custom field called `email` that is not the contact's email address is a
 * trap: every segment, every merge tag and every import mapping then has two
 * plausible meanings.
 */
const RESERVED_KEYS = new Set([
  'id', '_id', 'organization_id', 'organizationid', 'connection_id', 'name', 'first_name', 'last_name',
  'company_name', 'phone', 'email', 'timezone', 'country', 'source', 'postal_code', 'website', 'tags',
  'owner', 'lifecycle_status', 'created_at', 'updated_at', 'custom_fields',
])

export function validateDefinition(input: CustomFieldDefinitionInput): CustomFieldDefinitionView {
  const issues: string[] = []
  const key = normaliseFieldKey(input.key)

  if (!key) issues.push('key: a field key is required')
  else if (!/^[a-z][a-z0-9_]*$/.test(key)) issues.push(`key: "${key}" must start with a letter and contain only letters, digits and underscores`)
  else if (RESERVED_KEYS.has(key)) issues.push(`key: "${key}" collides with a built-in contact field and would make segments ambiguous`)

  const label = String(input.label || '').trim().slice(0, 120)
  if (!label) issues.push('label: a human-readable label is required')

  if (!CUSTOM_FIELD_TYPES.includes(input.type)) {
    issues.push(`type: must be one of ${CUSTOM_FIELD_TYPES.join(', ')}`)
  }

  const options = Array.isArray(input.options)
    ? [...new Set(input.options.map((option) => String(option).trim()).filter(Boolean))].slice(0, MAX_SELECT_OPTIONS)
    : []

  if (input.type === 'single_select' || input.type === 'multi_select') {
    if (!options.length) issues.push(`options: a ${input.type} field requires at least one option`)
  } else if (options.length) {
    issues.push('options: only single_select and multi_select fields may declare options')
  }

  if (input.type === 'number') {
    if (input.min !== undefined && !Number.isFinite(input.min)) issues.push('min: must be a finite number')
    if (input.max !== undefined && !Number.isFinite(input.max)) issues.push('max: must be a finite number')
    if (input.min !== undefined && input.max !== undefined && input.min > input.max) issues.push('min: cannot exceed max')
  } else if (input.min !== undefined || input.max !== undefined) {
    issues.push('min/max: only number fields may declare bounds')
  }

  if (issues.length) throw new CustomFieldError(issues)

  return {
    key,
    label,
    type: input.type,
    required: Boolean(input.required),
    options,
    ...(input.min !== undefined ? { min: input.min } : {}),
    ...(input.max !== undefined ? { max: input.max } : {}),
    ...(input.helpText ? { helpText: String(input.helpText).slice(0, 500) } : {}),
  }
}

/**
 * Coerce and validate a single value against its definition.
 *
 * Returns `undefined` for an empty value, which the caller treats as "unset"
 * rather than as the string "". A field that is required and unset is an error;
 * a field that is optional and unset is simply absent from the map, so a
 * segment filtering on "field is empty" gets a consistent answer.
 */
export function coerceValue(definition: CustomFieldDefinitionView, raw: unknown): unknown {
  const isEmpty = raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim()) || (Array.isArray(raw) && !raw.length)
  if (isEmpty) {
    if (definition.required) throw new CustomFieldError([`${definition.key}: a value is required`])
    return undefined
  }

  switch (definition.type) {
    case 'text':
    case 'longtext': {
      const limit = definition.type === 'text' ? MAX_TEXT_LENGTH : MAX_LONGTEXT_LENGTH
      const value = String(raw).trim()
      if (value.length > limit) throw new CustomFieldError([`${definition.key}: cannot exceed ${limit} characters`])
      return value
    }
    case 'number': {
      // Accepts "1,234" and " 42 " because those are what a CSV import and a
      // hand-typed form field actually produce.
      const value = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, '').trim())
      if (!Number.isFinite(value)) throw new CustomFieldError([`${definition.key}: "${String(raw)}" is not a number`])
      if (definition.min !== undefined && value < definition.min) throw new CustomFieldError([`${definition.key}: cannot be less than ${definition.min}`])
      if (definition.max !== undefined && value > definition.max) throw new CustomFieldError([`${definition.key}: cannot be greater than ${definition.max}`])
      return value
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw
      const value = String(raw).trim().toLowerCase()
      if (['true', 'yes', 'y', '1', 'on'].includes(value)) return true
      if (['false', 'no', 'n', '0', 'off'].includes(value)) return false
      throw new CustomFieldError([`${definition.key}: "${String(raw)}" is not a yes/no value`])
    }
    case 'date': {
      const value = raw instanceof Date ? raw : new Date(String(raw).trim())
      if (Number.isNaN(value.getTime())) throw new CustomFieldError([`${definition.key}: "${String(raw)}" is not a date`])
      return value
    }
    case 'email': {
      const value = normalizeEmail(String(raw))
      if (!value) throw new CustomFieldError([`${definition.key}: "${String(raw)}" is not a valid email address`])
      return value
    }
    case 'phone': {
      const value = normalizePhone(String(raw), '')
      if (!value.startsWith('+') || value.length < 8) {
        throw new CustomFieldError([`${definition.key}: "${String(raw)}" is not a phone number in international format`])
      }
      return value
    }
    case 'url': {
      let parsed: URL
      try { parsed = new URL(String(raw).trim()) } catch { throw new CustomFieldError([`${definition.key}: "${String(raw)}" is not a valid URL`]) }
      // Only http(s). A stored `javascript:` or `data:` URL becomes an XSS
      // vector the moment any surface renders it as a link.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new CustomFieldError([`${definition.key}: only http and https URLs are permitted`])
      }
      return parsed.toString()
    }
    case 'timezone': {
      const value = String(raw).trim()
      if (!isSupportedTimeZone(value)) throw new CustomFieldError([`${definition.key}: "${value}" is not a timezone this system can resolve`])
      return value
    }
    case 'single_select': {
      const value = String(raw).trim()
      if (!definition.options.includes(value)) {
        throw new CustomFieldError([`${definition.key}: "${value}" is not one of the permitted options`])
      }
      return value
    }
    case 'multi_select': {
      const values = (Array.isArray(raw) ? raw : String(raw).split(',')).map((item) => String(item).trim()).filter(Boolean)
      const unique = [...new Set(values)]
      if (unique.length > MAX_MULTI_SELECT_VALUES) throw new CustomFieldError([`${definition.key}: cannot hold more than ${MAX_MULTI_SELECT_VALUES} values`])
      const unknown = unique.filter((value) => !definition.options.includes(value))
      if (unknown.length) throw new CustomFieldError([`${definition.key}: ${unknown.map((value) => `"${value}"`).join(', ')} not among the permitted options`])
      return unique
    }
    default:
      throw new CustomFieldError([`${definition.key}: unsupported field type`])
  }
}

export interface CustomFieldApplyResult {
  values: Record<string, unknown>
  /** Keys present in the input that have no definition. */
  undefinedKeys: string[]
}

/**
 * Validate a whole custom-field payload against an organisation's definitions.
 *
 * `strict` controls what happens to keys with no definition. On an operator-
 * driven write (API, form) it is true and undefined keys are an error, because
 * silently dropping data the user typed is worse than refusing it. On an
 * inbound sync from an external CRM it is false: the external system's field
 * set is not under the operator's control, and refusing the whole record would
 * lose the lead over a field nobody asked for. In that mode undefined keys are
 * reported so an operator can define them, and are not stored.
 */
export function applyCustomFields(input: {
  definitions: CustomFieldDefinitionView[]
  values: Record<string, unknown> | undefined | null
  strict: boolean
  /** When true, definitions not present in `values` are checked for requiredness. */
  enforceRequired?: boolean
}): CustomFieldApplyResult {
  const byKey = new Map(input.definitions.map((definition) => [definition.key, definition]))
  const incoming = input.values && typeof input.values === 'object' ? input.values : {}
  const issues: string[] = []
  const undefinedKeys: string[] = []
  const values: Record<string, unknown> = {}

  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    // Prototype-pollution guard: these keys reach an object literal below.
    if (['__proto__', 'prototype', 'constructor'].includes(rawKey)) {
      issues.push(`${rawKey}: is not a permitted field key`)
      continue
    }
    const key = normaliseFieldKey(rawKey)
    const definition = byKey.get(key)
    if (!definition) {
      undefinedKeys.push(rawKey)
      if (input.strict) issues.push(`${rawKey}: no custom field with this key is defined for this organisation`)
      continue
    }
    try {
      const coerced = coerceValue(definition, rawValue)
      if (coerced !== undefined) values[key] = coerced
    } catch (error) {
      if (error instanceof CustomFieldError) issues.push(...error.issues)
      else throw error
    }
  }

  if (input.enforceRequired) {
    for (const definition of input.definitions) {
      if (definition.required && values[definition.key] === undefined) {
        issues.push(`${definition.key}: a value is required`)
      }
    }
  }

  if (issues.length) throw new CustomFieldError(issues)
  return { values, undefinedKeys }
}
