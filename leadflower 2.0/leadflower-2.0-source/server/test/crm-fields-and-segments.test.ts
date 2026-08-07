import { describe, expect, it } from 'vitest'
import {
  applyCustomFields,
  coerceValue,
  CustomFieldError,
  normaliseFieldKey,
  validateDefinition,
  type CustomFieldDefinitionView,
} from '../src/services/crm/customFields'
import { compileSegment, SegmentError, segmentFieldCatalogue } from '../src/services/crm/segments'

const ORG = 'org-1'

function definition(overrides: Partial<CustomFieldDefinitionView> & { key: string; type: any }): CustomFieldDefinitionView {
  return { label: overrides.key, required: false, options: [], ...overrides } as CustomFieldDefinitionView
}

describe('custom field definitions', () => {
  it('normalises keys so casing and spacing converge on one field', () => {
    expect(normaliseFieldKey('Preferred Contact Time')).toBe('preferred_contact_time')
    expect(normaliseFieldKey('preferredContactTime')).toBe('preferred_contact_time')
    expect(normaliseFieldKey('  JOB__TITLE  ')).toBe('job_title')
    expect(normaliseFieldKey('roof-type')).toBe('roof_type')
  })

  it('rejects keys that collide with built-in contact fields', () => {
    // A custom field called "email" that is not the contact's email makes every
    // segment and merge tag ambiguous.
    expect(() => validateDefinition({ key: 'email', label: 'Work email', type: 'email' })).toThrow(/collides with a built-in/)
    expect(() => validateDefinition({ key: 'tags', label: 'Tags', type: 'text' })).toThrow(/collides with a built-in/)
  })

  it('requires options on select fields and forbids them elsewhere', () => {
    expect(() => validateDefinition({ key: 'roof_type', label: 'Roof type', type: 'single_select' })).toThrow(/at least one option/)
    expect(() => validateDefinition({ key: 'notes', label: 'Notes', type: 'text', options: ['a'] })).toThrow(/only single_select and multi_select/)
    const valid = validateDefinition({ key: 'roof_type', label: 'Roof type', type: 'single_select', options: ['Tile', 'Slate', 'Tile'] })
    expect(valid.options).toEqual(['Tile', 'Slate'])
  })

  it('validates number bounds coherently', () => {
    expect(() => validateDefinition({ key: 'headcount', label: 'Headcount', type: 'number', min: 10, max: 5 })).toThrow(/cannot exceed max/)
    expect(() => validateDefinition({ key: 'note', label: 'Note', type: 'text', min: 1 })).toThrow(/only number fields/)
  })
})

describe('custom field value coercion', () => {
  it('parses numbers the way an import and a form actually supply them', () => {
    const field = definition({ key: 'headcount', type: 'number' })
    expect(coerceValue(field, ' 1,234 ')).toBe(1234)
    expect(coerceValue(field, 42)).toBe(42)
    expect(() => coerceValue(field, 'lots')).toThrow(/is not a number/)
  })

  it('enforces number bounds', () => {
    const field = definition({ key: 'score', type: 'number', min: 0, max: 100 })
    expect(coerceValue(field, '50')).toBe(50)
    expect(() => coerceValue(field, '101')).toThrow(/cannot be greater than 100/)
    expect(() => coerceValue(field, '-1')).toThrow(/cannot be less than 0/)
  })

  it('accepts the boolean spellings people actually type', () => {
    const field = definition({ key: 'opted_in', type: 'boolean' })
    for (const truthy of [true, 'true', 'Yes', 'y', '1', 'ON']) expect(coerceValue(field, truthy)).toBe(true)
    for (const falsy of [false, 'false', 'No', 'n', '0', 'off']) expect(coerceValue(field, falsy)).toBe(false)
    expect(() => coerceValue(field, 'maybe')).toThrow(/not a yes\/no value/)
  })

  it('refuses a URL that is not http or https', () => {
    const field = definition({ key: 'portfolio', type: 'url' })
    expect(coerceValue(field, 'https://example.com/a')).toBe('https://example.com/a')
    // A stored javascript: URL becomes XSS the moment any surface links it.
    expect(() => coerceValue(field, 'javascript:alert(1)')).toThrow(/only http and https/)
    expect(() => coerceValue(field, 'data:text/html,<script>')).toThrow(/only http and https/)
    expect(() => coerceValue(field, 'not a url')).toThrow(/not a valid URL/)
  })

  it('constrains select values to declared options', () => {
    const single = definition({ key: 'roof_type', type: 'single_select', options: ['Tile', 'Slate'] })
    expect(coerceValue(single, 'Tile')).toBe('Tile')
    expect(() => coerceValue(single, 'Thatch')).toThrow(/not one of the permitted options/)

    const multi = definition({ key: 'services', type: 'multi_select', options: ['Gutters', 'Roofing', 'Solar'] })
    expect(coerceValue(multi, 'Gutters, Solar')).toEqual(['Gutters', 'Solar'])
    expect(coerceValue(multi, ['Roofing', 'Roofing'])).toEqual(['Roofing'])
    expect(() => coerceValue(multi, ['Roofing', 'Plumbing'])).toThrow(/"Plumbing" not among/)
  })

  it('treats an empty value as unset, unless the field is required', () => {
    const optional = definition({ key: 'note', type: 'text' })
    expect(coerceValue(optional, '')).toBeUndefined()
    expect(coerceValue(optional, null)).toBeUndefined()
    const required = definition({ key: 'note', type: 'text', required: true })
    expect(() => coerceValue(required, '   ')).toThrow(/a value is required/)
  })
})

describe('applying a custom field payload', () => {
  const definitions = [
    definition({ key: 'roof_type', type: 'single_select', options: ['Tile', 'Slate'] }),
    definition({ key: 'headcount', type: 'number' }),
    definition({ key: 'urgent', type: 'boolean', required: true }),
  ]

  it('rejects an undefined key on an operator write', () => {
    // This is the rule that stops the contact store becoming unqueryable.
    expect(() => applyCustomFields({ definitions, values: { roof_type: 'Tile', urgent: 'yes', mystery: 'x' }, strict: true }))
      .toThrow(/no custom field with this key is defined/)
  })

  it('reports but does not store an undefined key on an inbound CRM sync', () => {
    // The external system's field set is not the operator's to control, and
    // losing the lead over a field nobody asked for is the wrong trade.
    const result = applyCustomFields({ definitions, values: { roof_type: 'Slate', mystery: 'x' }, strict: false })
    expect(result.values).toEqual({ roof_type: 'Slate' })
    expect(result.undefinedKeys).toEqual(['mystery'])
  })

  it('normalises incoming keys before matching them to definitions', () => {
    // "Roof Type", "roofType" and "roof_type" are the same field. Note that
    // "headCount" is NOT the same key as "headcount": a snake_case normaliser
    // reads the former as two words, and it cannot know the latter is one.
    // That is correct, and it is why the definition key is the canonical form.
    expect(applyCustomFields({ definitions, values: { 'Roof Type': 'Tile' }, strict: true }).values).toEqual({ roof_type: 'Tile' })
    expect(applyCustomFields({ definitions, values: { roofType: 'Slate' }, strict: true }).values).toEqual({ roof_type: 'Slate' })
    expect(applyCustomFields({ definitions, values: { HEADCOUNT: '12' }, strict: true }).values).toEqual({ headcount: 12 })
  })

  it('refuses prototype-polluting keys', () => {
    // Built with JSON.parse rather than an object literal, because that is the
    // actual threat vector: `{ __proto__: 'x' }` in source sets the prototype
    // and creates no own property, whereas a parsed JSON request body creates a
    // real own key that Object.entries will iterate.
    const parsed = JSON.parse('{"__proto__":"x","constructor":"y","roof_type":"Tile"}')
    expect(() => applyCustomFields({ definitions, values: parsed, strict: true })).toThrow(CustomFieldError)
    try {
      applyCustomFields({ definitions, values: parsed, strict: true })
    } catch (error: any) {
      expect(error.issues.some((issue: string) => issue.startsWith('__proto__'))).toBe(true)
      expect(error.issues.some((issue: string) => issue.startsWith('constructor'))).toBe(true)
    }
    expect(({} as any).polluted).toBeUndefined()
  })

  it('enforces required fields only when asked to', () => {
    expect(applyCustomFields({ definitions, values: { roof_type: 'Tile' }, strict: true }).values).toEqual({ roof_type: 'Tile' })
    expect(() => applyCustomFields({ definitions, values: { roof_type: 'Tile' }, strict: true, enforceRequired: true }))
      .toThrow(/urgent: a value is required/)
  })

  it('collects every issue rather than failing on the first', () => {
    try {
      applyCustomFields({ definitions, values: { roof_type: 'Thatch', headcount: 'lots' }, strict: true })
      throw new Error('should have thrown')
    } catch (error: any) {
      expect(error).toBeInstanceOf(CustomFieldError)
      expect(error.issues).toHaveLength(2)
    }
  })
})

describe('segment compilation', () => {
  const definitions = [
    definition({ key: 'roof_type', type: 'single_select', options: ['Tile', 'Slate'] }),
    definition({ key: 'headcount', type: 'number' }),
  ]

  function compile(conditions: any[], match: 'all' | 'any' = 'all') {
    return compileSegment({ organizationId: ORG, definition: { match, conditions }, definitions })
  }

  it('always constrains by organisation, even with no conditions', () => {
    expect(compile([])).toEqual({ organizationId: ORG, archivedAt: null })
  })

  it('compiles built-in and custom field conditions', () => {
    const query: any = compile([
      { field: 'lifecycleStatus', operator: 'equals', value: 'lead' },
      { field: 'custom:headcount', operator: 'greater_than', value: '10' },
    ])
    expect(query.organizationId).toBe(ORG)
    expect(query.$and).toEqual([
      { lifecycleStatus: 'lead' },
      { 'customFields.headcount': { $gt: 10 } },
    ])
  })

  it('uses $or for an any-match segment', () => {
    const query: any = compile([
      { field: 'lifecycleStatus', operator: 'equals', value: 'lead' },
      { field: 'lifecycleStatus', operator: 'equals', value: 'engaged' },
    ], 'any')
    expect(query.$or).toHaveLength(2)
    expect(query.$and).toBeUndefined()
  })

  it('refuses a field that is not on the allow-list', () => {
    expect(() => compile([{ field: 'credentialsCiphertext', operator: 'equals', value: 'x' }])).toThrow(/not a filterable contact field/)
    expect(() => compile([{ field: 'custom:undeclared', operator: 'equals', value: 'x' }])).toThrow(/no custom field with this key/)
  })

  it('cannot be used to reach or relax the organisation predicate', () => {
    // organizationId is deliberately absent from the filterable field list, so
    // no condition can name it, widen it, or wrap it in an $or.
    expect(() => compile([{ field: 'organizationId', operator: 'equals', value: 'org-2' }])).toThrow(/not a filterable contact field/)
    const query: any = compile([{ field: 'lifecycleStatus', operator: 'equals', value: 'lead' }], 'any')
    expect(query.organizationId).toBe(ORG)
  })

  it('refuses operator injection attempts', () => {
    expect(() => compile([{ field: 'email', operator: '$where' as any, value: 'return true' }])).toThrow(SegmentError)
    expect(() => compile([{ field: '$where', operator: 'equals', value: 'x' }])).toThrow(/not a filterable contact field/)
    expect(() => compile([{ field: 'custom:$ne', operator: 'equals', value: 'x' }])).toThrow(/no custom field with this key/)
  })

  it('treats user text as a literal, never as a regex pattern', () => {
    const query: any = compile([{ field: 'companyName', operator: 'contains', value: '.*' }])
    const pattern: RegExp = query.$and[0].companyName
    expect(pattern).toBeInstanceOf(RegExp)
    // The metacharacters are escaped, so this matches the literal string ".*"
    // rather than every record in the collection.
    expect(pattern.test('.*')).toBe(true)
    expect(pattern.test('Acme Roofing')).toBe(false)
  })

  it('anchors starts_with so it can use an index', () => {
    // A fragment, not a whole value: "jane" is not a valid email address, and
    // coercing it to the field type would reject the most useful filter on it.
    const query: any = compile([{ field: 'email', operator: 'starts_with', value: 'jane' }])
    expect(query.$and[0].email.source.startsWith('^')).toBe(true)
    expect(query.$and[0].email.test('jane@example.com')).toBe(true)
    expect(query.$and[0].email.test('bob@jane.com')).toBe(false)
  })

  it('bounds the length of a search fragment', () => {
    expect(() => compile([{ field: 'companyName', operator: 'contains', value: 'x'.repeat(201) }]))
      .toThrow(/cannot exceed 200 characters/)
    expect(() => compile([{ field: 'companyName', operator: 'contains', value: '   ' }]))
      .toThrow(/requires a non-empty value/)
  })

  it('rejects an operator that makes no sense for the field type', () => {
    expect(() => compile([{ field: 'createdAt', operator: 'contains', value: 'x' }])).toThrow(/cannot be used on a date field/)
    expect(() => compile([{ field: 'custom:headcount', operator: 'starts_with', value: '1' }])).toThrow(/cannot be used on a number field/)
  })

  it('coerces comparison values to the field type', () => {
    const query: any = compile([{ field: 'createdAt', operator: 'after', value: '2026-01-01' }])
    expect(query.$and[0].createdAt.$gt).toBeInstanceOf(Date)
  })

  it('bounds the number of conditions and in-list values', () => {
    const many = Array.from({ length: 26 }, () => ({ field: 'lifecycleStatus', operator: 'equals', value: 'lead' }))
    expect(() => compile(many)).toThrow(/more than 25 conditions/)
    expect(() => compile([{ field: 'lifecycleStatus', operator: 'in', value: Array.from({ length: 201 }, (_, i) => `v${i}`) }]))
      .toThrow(/more than 200 values/)
  })

  it('publishes a field catalogue covering built-ins and custom fields', () => {
    const catalogue = segmentFieldCatalogue(definitions)
    expect(catalogue.some((entry) => entry.field === 'lifecycleStatus')).toBe(true)
    expect(catalogue.some((entry) => entry.field === 'custom:roof_type')).toBe(true)
    expect(catalogue.some((entry) => entry.field === 'organizationId')).toBe(false)
  })
})
