import type { CustomFieldDefinitionView, CustomFieldType } from './customFields'
import { coerceValue, normaliseFieldKey } from './customFields'
import { LocationError, radiusQuery } from './location'

/**
 * Compiling a saved segment into a MongoDB query.
 *
 * The rule: a client never supplies a query fragment, only a structured
 * condition tree, and this module is the only thing that turns one into the
 * other. Accepting a query fragment and passing it to the driver hands the
 * caller `$where` and `$function` (server-side JavaScript), `$expr` (arbitrary
 * aggregation), an unbounded `$regex` (catastrophic backtracking against the
 * whole collection), and `$lookup` into collections belonging to other tenants.
 * There is no sanitiser that reliably closes all of those; not opening them is
 * the only durable answer.
 *
 * So every field name is resolved against an allow-list, every operator against
 * a fixed set, and every value is coerced to the type the field actually holds.
 * Anything unrecognised is an error rather than a passthrough.
 */

export const SEGMENT_OPERATORS = [
  'equals', 'not_equals', 'contains', 'not_contains', 'starts_with',
  'greater_than', 'less_than', 'before', 'after',
  'is_empty', 'is_not_empty', 'in', 'not_in', 'within_radius',
] as const
export type SegmentOperator = (typeof SEGMENT_OPERATORS)[number]

export interface SegmentCondition {
  field: string
  operator: SegmentOperator
  value?: unknown
}

export interface SegmentDefinition {
  match: 'all' | 'any'
  conditions: SegmentCondition[]
}

export const MAX_SEGMENT_CONDITIONS = 25
const MAX_IN_VALUES = 200

export class SegmentError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join('; '))
    this.name = 'SegmentError'
    this.issues = issues
  }
}

/** Built-in Contact fields a segment may filter on, with their type. */
const BUILT_IN_FIELDS: Readonly<Record<string, CustomFieldType>> = Object.freeze({
  email: 'email',
  phone: 'phone',
  name: 'text',
  firstName: 'text',
  lastName: 'text',
  companyName: 'text',
  country: 'text',
  postalCode: 'text',
  website: 'url',
  source: 'text',
  timezone: 'timezone',
  lifecycleStatus: 'text',
  ownerUserId: 'text',
  tags: 'multi_select',
  createdAt: 'date',
  updatedAt: 'date',
  lastActivityAt: 'date',
  lastInboundAt: 'date',
  revenueMinorUnits: 'number',
  addressLine1: 'text',
  city: 'text',
  region: 'text',
  jobTitle: 'text',
  secondaryPhone: 'phone',
  preferredContactMethod: 'text',
  referredBy: 'text',
  leadScore: 'number',
  nextActionAt: 'date',
})

/**
 * Fields that are not custom fields and not plain scalars. Handled ahead of the
 * generic path because their operators and value shapes are their own.
 */
const GEO_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  location: 'location',
})

/** Which operators make sense for which type. */
const OPERATORS_BY_TYPE: Readonly<Record<string, readonly SegmentOperator[]>> = Object.freeze({
  text: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'is_empty', 'is_not_empty', 'in', 'not_in'],
  longtext: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
  email: ['equals', 'not_equals', 'contains', 'starts_with', 'is_empty', 'is_not_empty', 'in', 'not_in'],
  phone: ['equals', 'not_equals', 'starts_with', 'is_empty', 'is_not_empty', 'in', 'not_in'],
  url: ['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'],
  timezone: ['equals', 'not_equals', 'is_empty', 'is_not_empty', 'in', 'not_in'],
  number: ['equals', 'not_equals', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'],
  boolean: ['equals', 'not_equals', 'is_empty', 'is_not_empty'],
  date: ['before', 'after', 'is_empty', 'is_not_empty'],
  single_select: ['equals', 'not_equals', 'is_empty', 'is_not_empty', 'in', 'not_in'],
  multi_select: ['contains', 'not_contains', 'is_empty', 'is_not_empty', 'in', 'not_in'],
})

/**
 * Escape every regex metacharacter. User text is a literal, never a pattern.
 *
 * The ESLint security rule below is right to flag a non-literal RegExp: a
 * user-supplied pattern is a ReDoS sink, and an unescaped `(a+)+$` against a
 * whole collection will hang a worker. It is suppressed here, and only here,
 * because the input cannot be a pattern by the time it reaches the constructor:
 *
 *  - Every metacharacter in the standard set — `. * + ? ^ $ { } ( ) | [ ] \` —
 *    is escaped immediately below, which leaves a string with no quantifiers,
 *    no alternation and no grouping. Catastrophic backtracking needs at least
 *    one of those.
 *  - The fragment is bounded to 200 characters by `coerceComparison` before it
 *    arrives, so even linear scanning is bounded.
 *
 * If either of those two properties is ever removed, this suppression must go
 * with it.
 */
function literalRegex(value: string, anchor: 'contains' | 'starts_with'): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Anchoring `starts_with` also lets an index be used rather than a full scan.
  // eslint-disable-next-line security/detect-non-literal-regexp -- input is metacharacter-escaped above and length-bounded by coerceComparison, so it cannot express a backtracking pattern
  return new RegExp(anchor === 'starts_with' ? `^${escaped}` : escaped, 'i')
}

interface ResolvedField {
  path: string
  type: CustomFieldType
  definition?: CustomFieldDefinitionView
}

function resolveField(field: string, definitions: CustomFieldDefinitionView[]): ResolvedField {
  const raw = String(field || '').trim()

  if (raw.startsWith('custom:')) {
    const key = normaliseFieldKey(raw.slice('custom:'.length))
    const definition = definitions.find((candidate) => candidate.key === key)
    if (!definition) throw new SegmentError([`${raw}: no custom field with this key is defined`])
    // The key is drawn from a stored definition and matched against
    // /^[a-z][a-z0-9_]*$/ at definition time, so it cannot introduce a `$` or a
    // dot into the query path.
    return { path: `customFields.${definition.key}`, type: definition.type, definition }
  }

  const builtIn = BUILT_IN_FIELDS[raw as keyof typeof BUILT_IN_FIELDS]
  if (!builtIn) throw new SegmentError([`${raw}: is not a filterable contact field`])
  return { path: raw, type: builtIn }
}

/** Operators whose value is a fragment rather than a whole field value. */
const SUBSTRING_OPERATORS: ReadonlySet<SegmentOperator> = new Set<SegmentOperator>(['contains', 'not_contains', 'starts_with'])

const MAX_SUBSTRING_LENGTH = 200

/**
 * Coerce a comparison value to the field's type.
 *
 * Reuses the custom-field coercion so a date typed into a segment builder and a
 * date typed into a contact form are parsed identically — otherwise a segment
 * silently fails to match the values it was built to find.
 *
 * Substring operators are exempt, and must be: "starts with jane" against an
 * email field compares a fragment, and `jane` is not a valid email address.
 * Coercing it would reject the most obviously useful filter on the field. The
 * fragment is instead bounded in length and escaped into a literal by the
 * caller, so exempting it costs nothing in safety.
 */
function coerceComparison(resolved: ResolvedField, value: unknown, operator: SegmentOperator): unknown {
  if (SUBSTRING_OPERATORS.has(operator)) {
    const fragment = String(value ?? '').trim()
    if (!fragment) throw new SegmentError([`${resolved.path}: "${operator}" requires a non-empty value`])
    if (fragment.length > MAX_SUBSTRING_LENGTH) throw new SegmentError([`${resolved.path}: a search fragment cannot exceed ${MAX_SUBSTRING_LENGTH} characters`])
    return fragment
  }

  const definition: CustomFieldDefinitionView = resolved.definition ?? {
    key: resolved.path,
    label: resolved.path,
    type: resolved.type,
    required: false,
    options: [],
  }
  if (resolved.type === 'multi_select' || resolved.type === 'single_select') {
    return String(value ?? '').trim()
  }
  return coerceValue({ ...definition, required: true }, value)
}

function buildClause(condition: SegmentCondition, definitions: CustomFieldDefinitionView[]): Record<string, unknown> {
  const operator = condition.operator
  if (!SEGMENT_OPERATORS.includes(operator)) throw new SegmentError([`${condition.field}: "${operator}" is not a supported operator`])

  // Geospatial conditions take a {latitude, longitude, radiusKm} value rather
  // than a scalar, so they are resolved before the generic scalar path.
  if (GEO_FIELDS[condition.field as keyof typeof GEO_FIELDS]) {
    if (operator !== 'within_radius') {
      throw new SegmentError([`${condition.field}: only "within_radius" can be used on a location field`])
    }
    const value = (condition.value || {}) as { latitude?: unknown; longitude?: unknown; radiusKm?: unknown }
    try {
      return radiusQuery({
        path: 'location',
        latitude: Number(value.latitude),
        longitude: Number(value.longitude),
        radiusKm: Number(value.radiusKm),
      })
    } catch (error) {
      if (error instanceof LocationError) throw new SegmentError(error.issues.map((issue) => `${condition.field}: ${issue}`))
      throw error
    }
  }
  if (operator === 'within_radius') {
    throw new SegmentError([`${condition.field}: "within_radius" can only be used on a location field`])
  }

  const resolved = resolveField(condition.field, definitions)
  const permitted = OPERATORS_BY_TYPE[resolved.type] || []
  if (!permitted.includes(operator)) {
    throw new SegmentError([`${condition.field}: "${operator}" cannot be used on a ${resolved.type} field`])
  }

  const path = resolved.path

  if (operator === 'is_empty') {
    return { $or: [{ [path]: { $exists: false } }, { [path]: null }, { [path]: '' }, { [path]: [] }] }
  }
  if (operator === 'is_not_empty') {
    return { [path]: { $nin: [null, '', []], $exists: true } }
  }

  if (operator === 'in' || operator === 'not_in') {
    const raw = Array.isArray(condition.value) ? condition.value : [condition.value]
    if (!raw.length) throw new SegmentError([`${condition.field}: "${operator}" requires at least one value`])
    if (raw.length > MAX_IN_VALUES) throw new SegmentError([`${condition.field}: cannot compare against more than ${MAX_IN_VALUES} values`])
    const values = raw.map((item) => coerceComparison(resolved, item, operator))
    return { [path]: operator === 'in' ? { $in: values } : { $nin: values } }
  }

  if (condition.value === undefined || condition.value === null) {
    throw new SegmentError([`${condition.field}: "${operator}" requires a value`])
  }

  const value = coerceComparison(resolved, condition.value, operator)

  switch (operator) {
    case 'equals': return { [path]: value }
    case 'not_equals': return { [path]: { $ne: value } }
    case 'contains': return { [path]: literalRegex(String(value), 'contains') }
    case 'not_contains': return { [path]: { $not: literalRegex(String(value), 'contains') } }
    case 'starts_with': return { [path]: literalRegex(String(value), 'starts_with') }
    case 'greater_than': return { [path]: { $gt: value } }
    case 'less_than': return { [path]: { $lt: value } }
    case 'before': return { [path]: { $lt: value } }
    case 'after': return { [path]: { $gt: value } }
    default: throw new SegmentError([`${condition.field}: unsupported operator`])
  }
}

/**
 * Compile a segment into a Mongo filter.
 *
 * The organisation predicate is applied here, at the top level, and is not
 * something a condition can reach: `organizationId` is absent from
 * BUILT_IN_FIELDS, so no condition can name it, override it, or wrap it in an
 * `$or` that makes it optional.
 */
export function compileSegment(input: {
  organizationId: string
  definition: SegmentDefinition
  definitions: CustomFieldDefinitionView[]
}): Record<string, unknown> {
  const conditions = Array.isArray(input.definition?.conditions) ? input.definition.conditions : []
  if (conditions.length > MAX_SEGMENT_CONDITIONS) {
    throw new SegmentError([`a segment cannot contain more than ${MAX_SEGMENT_CONDITIONS} conditions`])
  }

  const issues: string[] = []
  const clauses: Array<Record<string, unknown>> = []
  for (const condition of conditions) {
    try { clauses.push(buildClause(condition, input.definitions)) } catch (error) {
      if (error instanceof SegmentError) issues.push(...error.issues)
      else throw error
    }
  }
  if (issues.length) throw new SegmentError(issues)

  const query: Record<string, unknown> = { organizationId: input.organizationId, archivedAt: null }
  if (!clauses.length) return query

  // `$and` even for a single clause, so two conditions on the same field do not
  // silently collapse into one object key and lose the first.
  if (input.definition.match === 'any') query.$or = clauses
  else query.$and = clauses
  return query
}

/** The filterable fields, for rendering a segment builder. */
export function segmentFieldCatalogue(definitions: CustomFieldDefinitionView[]) {
  return [
    {
      field: 'location',
      label: 'Location',
      type: 'location',
      operators: ['within_radius'] as readonly SegmentOperator[],
      options: [] as string[],
    },
    ...Object.entries(BUILT_IN_FIELDS).map(([field, type]) => ({
      field, label: field, type, operators: OPERATORS_BY_TYPE[type] || [], options: [] as string[],
    })),
    ...definitions.map((definition) => ({
      field: `custom:${definition.key}`,
      label: definition.label,
      type: definition.type,
      operators: OPERATORS_BY_TYPE[definition.type] || [],
      options: definition.options,
    })),
  ]
}
