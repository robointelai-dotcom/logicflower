import { describe, expect, it } from 'vitest'
import { dedupeTags, displayTag, hasTag, MAX_RULE_DEPTH, MAX_TAGS_PER_CONTACT, normaliseTagKey } from '../src/services/crm/tags'
import { compileSegment, segmentFieldCatalogue } from '../src/services/crm/segments'
import { platformChargeNotice } from '../src/services/nodeLibrary'

describe('tag normalisation', () => {
  it('treats casing, punctuation and surrounding space as the same tag', () => {
    // The failure this prevents: a rule written for "vip" silently stops firing
    // the day somebody types "VIP", and nobody connects the two events.
    const keys = new Set(['VIP', 'vip', 'V.I.P.', ' Vip '].map(normaliseTagKey))
    expect(keys.size).toBe(1)
    expect([...keys][0]).toBe('vip')
  })

  it('treats separated words as a distinct tag, and that boundary is deliberate', () => {
    // "V I P" is NOT merged with "VIP". Separators normalise to a hyphen rather
    // than vanishing, which keeps the rule predictable: word boundaries are
    // meaningful, punctuation and case are not.
    //
    // The alternative — stripping separators entirely — would merge "V I P"
    // with "VIP" but also merge tags an operator meant to keep apart, and would
    // make the result of typing a tag much harder to predict. The common real
    // case is "Needs Quote" versus "needs-quote", and those DO merge.
    expect(normaliseTagKey('V I P')).toBe('v-i-p')
    expect(normaliseTagKey('VIP')).toBe('vip')
    expect(normaliseTagKey('Needs Quote')).toBe(normaliseTagKey('needs-quote'))
  })

  it('normalises multi-word tags predictably', () => {
    expect(normaliseTagKey('Needs Quote')).toBe('needs-quote')
    expect(normaliseTagKey('needs_quote')).toBe('needs-quote')
    expect(normaliseTagKey('needs quote')).toBe('needs-quote')
    expect(normaliseTagKey("Client's Referral")).toBe('clients-referral')
  })

  it('rejects a tag that normalises to nothing', () => {
    for (const empty of ['', '   ', '...', '---', '!!!']) expect(normaliseTagKey(empty)).toBe('')
  })

  it('preserves the display form the operator typed', () => {
    expect(displayTag('  VIP  Customer ')).toBe('VIP Customer')
    expect(displayTag('needs quote')).toBe('needs quote')
  })
})

describe('tag lists', () => {
  it('keeps one entry per tag, first spelling winning', () => {
    // Without this a contact tagged "VIP" then "vip" would flicker between the
    // two spellings on every write.
    expect(dedupeTags(['VIP', 'vip', 'V.I.P.'])).toEqual(['VIP'])
    expect(dedupeTags(['needs quote', 'Needs Quote', 'no-show'])).toEqual(['needs quote', 'no-show'])
  })

  it('drops unusable entries and bounds the list', () => {
    expect(dedupeTags(['ok', '', '   ', '...'])).toEqual(['ok'])
    expect(dedupeTags(Array.from({ length: 80 }, (_, index) => `tag-${index}`))).toHaveLength(MAX_TAGS_PER_CONTACT)
  })

  it('matches a tag regardless of how it was typed', () => {
    const tags = ['VIP', 'Needs Quote']
    expect(hasTag(tags, 'vip')).toBe(true)
    expect(hasTag(tags, 'V.I.P.')).toBe(true)
    expect(hasTag(tags, 'needs-quote')).toBe(true)
    expect(hasTag(tags, 'needs quote')).toBe(true)
    expect(hasTag(tags, 'no-show')).toBe(false)
    expect(hasTag(tags, '')).toBe(false)
    expect(hasTag(undefined, 'vip')).toBe(false)
  })

  it('bounds how far a chain of rules may run', () => {
    // Two rules that apply each other's tag would otherwise loop until the
    // process dies, and it would read as a hung request rather than a
    // configuration error.
    expect(MAX_RULE_DEPTH).toBeGreaterThan(0)
    expect(MAX_RULE_DEPTH).toBeLessThanOrEqual(5)
  })
})

describe('local tag workflow nodes', () => {
  it('flags the HighLevel tag actions as incurring a platform charge', () => {
    // The commercial point of the local nodes: same behaviour, no per-action fee.
    expect(platformChargeNotice('action.ghl.addTag')).toMatch(/per-action/)
    expect(platformChargeNotice('action.ghl.removeTag')).toMatch(/per-action/)
    expect(platformChargeNotice('action.tag.add')).toMatch(/per-action/)
  })

  it('does not flag the local tag actions', () => {
    expect(platformChargeNotice('action.contact.tag.add')).toBeUndefined()
    expect(platformChargeNotice('action.contact.tag.remove')).toBeUndefined()
    expect(platformChargeNotice('condition.contact.hasTag')).toBeUndefined()
  })
})

describe('new CRM fields in segments', () => {
  function compile(conditions: any[]) {
    return compileSegment({ organizationId: 'org-1', definition: { match: 'all', conditions }, definitions: [] })
  }

  it('filters on the standard CRM fields', () => {
    const query: any = compile([
      { field: 'city', operator: 'equals', value: 'Chennai' },
      { field: 'leadScore', operator: 'greater_than', value: 70 },
      { field: 'jobTitle', operator: 'contains', value: 'director' },
    ])
    expect(query.$and[0]).toEqual({ city: 'Chennai' })
    expect(query.$and[1]).toEqual({ leadScore: { $gt: 70 } })
    expect(query.$and[2].jobTitle).toBeInstanceOf(RegExp)
  })

  it('filters on the next action date', () => {
    const query: any = compile([{ field: 'nextActionAt', operator: 'before', value: '2026-09-01' }])
    expect(query.$and[0].nextActionAt.$lt).toBeInstanceOf(Date)
  })

  it('publishes the new fields in the builder catalogue', () => {
    const fields = segmentFieldCatalogue([]).map((entry) => entry.field)
    for (const field of ['city', 'region', 'jobTitle', 'leadScore', 'nextActionAt', 'referredBy', 'preferredContactMethod']) {
      expect(fields).toContain(field)
    }
    // Still not filterable, and must never become so.
    expect(fields).not.toContain('organizationId')
  })
})
