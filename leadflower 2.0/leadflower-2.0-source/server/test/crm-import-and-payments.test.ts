import { describe, expect, it } from 'vitest'
import { IMPORTABLE_FIELDS, MAX_IMPORT_ROWS, suggestMapping } from '../src/services/crm/contactImport'
import { MAX_AMOUNT_MINOR_UNITS, MIN_AMOUNT_MINOR_UNITS, stripeCredentialAad } from '../src/services/crm/payments'
import { workspaceKeyAad } from '../src/services/social/trypostPublisher'

describe('CSV import column mapping', () => {
  const definitions = [
    { key: 'roof_type', label: 'Roof type', type: 'single_select' as const, required: false, options: ['Tile'] },
  ]

  it('maps headers that match a field name, whatever the casing', () => {
    const mapping = suggestMapping(['First Name', 'lastname', 'EMAIL', 'Company Name'], definitions)
    const byColumn = new Map(mapping.map((entry) => [entry.column, entry.field]))
    expect(byColumn.get('First Name')).toBe('firstName')
    expect(byColumn.get('lastname')).toBe('lastName')
    expect(byColumn.get('EMAIL')).toBe('email')
    expect(byColumn.get('Company Name')).toBe('companyName')
  })

  it('maps the header spellings people actually export', () => {
    // A real CSV from a supplier says "Mobile", not "phone".
    const mapping = suggestMapping(['Mobile', 'Telephone', 'E-Mail', 'Postcode', 'Organisation', 'Surname'], definitions)
    const byColumn = new Map(mapping.map((entry) => [entry.column, entry.field]))
    expect(byColumn.get('Mobile')).toBe('phone')
    expect(byColumn.get('Telephone')).toBe('phone')
    expect(byColumn.get('E-Mail')).toBe('email')
    expect(byColumn.get('Postcode')).toBe('postalCode')
    expect(byColumn.get('Organisation')).toBe('companyName')
    expect(byColumn.get('Surname')).toBe('lastName')
  })

  it('maps a declared custom field by key', () => {
    const mapping = suggestMapping(['Roof Type'], definitions)
    expect(mapping[0]?.field).toBe('custom:roof_type')
  })

  it('leaves an unrecognised column unmapped rather than guessing', () => {
    // A wrong guess writes a supplier's internal reference into someone's
    // company name, silently, across the whole file.
    const mapping = suggestMapping(['Internal Ref', 'Legacy ID'], definitions)
    expect(mapping.every((entry) => entry.field === null)).toBe(true)
  })

  it('never suggests a field that is not importable', () => {
    const mapping = suggestMapping(['organizationId', 'revenueMinorUnits', '_id', 'archivedAt'], definitions)
    for (const entry of mapping) {
      if (entry.field && !entry.field.startsWith('custom:')) {
        expect(IMPORTABLE_FIELDS).toContain(entry.field as any)
      }
    }
    expect(mapping.find((entry) => entry.column === 'organizationId')?.field).toBeNull()
    expect(mapping.find((entry) => entry.column === 'revenueMinorUnits')?.field).toBeNull()
  })

  it('bounds import size', () => {
    expect(MAX_IMPORT_ROWS).toBeLessThanOrEqual(50_000)
  })
})

describe('credential isolation', () => {
  it('binds a Stripe credential to its own organisation', () => {
    // A credential readable across organisations would route one operator's
    // customer payments into another's account.
    expect(stripeCredentialAad('org-1')).not.toBe(stripeCredentialAad('org-2'))
    expect(stripeCredentialAad('org-1')).toContain('org-1')
  })

  it('keeps payment and social credentials in separate AAD namespaces', () => {
    // Same organisation, different purposes: a ciphertext for one must not open
    // as the other.
    expect(stripeCredentialAad('org-1')).not.toBe(workspaceKeyAad('org-1'))
  })

  it('bounds payment amounts', () => {
    expect(MIN_AMOUNT_MINOR_UNITS).toBeGreaterThan(0)
    expect(MAX_AMOUNT_MINOR_UNITS).toBeGreaterThan(MIN_AMOUNT_MINOR_UNITS)
  })
})
