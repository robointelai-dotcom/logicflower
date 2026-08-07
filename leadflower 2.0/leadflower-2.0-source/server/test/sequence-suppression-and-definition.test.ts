import { describe, expect, it } from 'vitest'
import {
  addressPreview,
  assertNotSuppressed,
  normaliseAddress,
  SuppressedRecipientError,
  suppressionDigest,
  type SuppressionLookup,
} from '../src/services/sequences/suppression'
import { canonicaliseSequenceDefinition, sequenceDefinitionHash, SequenceDefinitionError } from '../src/services/sequences/sequenceDefinition'
import { whatsappSessionMode, WHATSAPP_SESSION_WINDOW_MS } from '../src/services/sequences/channels'

const ORG = 'org-1'
const OTHER_ORG = 'org-2'

const emptyLookup: SuppressionLookup = async () => null

function lookupReturning(reason: any): SuppressionLookup {
  return async () => reason
}

describe('suppression enforcement', () => {
  it('normalises addresses per channel and rejects what it cannot normalise', () => {
    expect(normaliseAddress('email', '  Lead@Example.COM ')).toBe('lead@example.com')
    expect(normaliseAddress('email', 'not-an-address')).toBe('')
    expect(normaliseAddress('sms', '+91 98765 43210')).toBe('+919876543210')
    expect(normaliseAddress('sms', '9876543210', '91')).toBe('+919876543210')
    expect(normaliseAddress('sms', 'call me')).toBe('')
  })

  it('produces a stable digest that differs across organisations and channels', () => {
    const first = suppressionDigest(ORG, 'email', 'lead@example.com')
    expect(suppressionDigest(ORG, 'email', 'lead@example.com')).toBe(first)
    // The same person in two tenants must not be linkable across them.
    expect(suppressionDigest(OTHER_ORG, 'email', 'lead@example.com')).not.toBe(first)
    // The digest is keyed, so it is not a plain hash of the address.
    expect(first).not.toContain('lead')
    expect(first).toHaveLength(64)
  })

  it('refuses to digest an empty address rather than producing a matchable constant', () => {
    expect(() => suppressionDigest(ORG, 'email', '')).toThrow(/empty address/)
  })

  it('allows a send when the address is not on the list', async () => {
    const result = await assertNotSuppressed({ organizationId: ORG, channel: 'email', address: 'Lead@Example.com', lookup: emptyLookup })
    expect(result.normalisedAddress).toBe('lead@example.com')
    expect(result.addressDigest).toBe(suppressionDigest(ORG, 'email', 'lead@example.com'))
  })

  it('refuses a send on every channel when the address is suppressed', async () => {
    for (const channel of ['email', 'sms', 'whatsapp'] as const) {
      const address = channel === 'email' ? 'lead@example.com' : '+919876543210'
      await expect(assertNotSuppressed({ organizationId: ORG, channel, address, lookup: lookupReturning('unsubscribed') }))
        .rejects.toThrow(SuppressedRecipientError)
    }
  })

  it('carries the reason through, so an exit can be recorded accurately', async () => {
    await expect(assertNotSuppressed({ organizationId: ORG, channel: 'email', address: 'lead@example.com', lookup: lookupReturning('hard_bounce') }))
      .rejects.toMatchObject({ reason: 'hard_bounce' })
  })

  it('refuses rather than allows when an address cannot be normalised', async () => {
    // The failure mode this prevents: a junk address produces a digest that
    // matches nothing, the lookup returns null, and the send is waved through
    // to a recipient whose real address is on the list.
    await expect(assertNotSuppressed({ organizationId: ORG, channel: 'email', address: 'not-an-address', lookup: emptyLookup }))
      .rejects.toMatchObject({ reason: 'unresolvable_address' })
    await expect(assertNotSuppressed({ organizationId: ORG, channel: 'sms', address: '', lookup: emptyLookup }))
      .rejects.toThrow(SuppressedRecipientError)
  })

  it('fails closed when the lookup itself errors', async () => {
    const brokenLookup: SuppressionLookup = async () => { throw new Error('database unavailable') }
    await expect(assertNotSuppressed({ organizationId: ORG, channel: 'email', address: 'lead@example.com', lookup: brokenLookup }))
      .rejects.toThrow(/database unavailable/)
  })

  it('redacts addresses for display without making them recoverable', () => {
    expect(addressPreview('email', 'jane.doe@example.com')).toBe('j***e@example.com')
    expect(addressPreview('sms', '+919876543210')).toBe('+9198***3210')
    expect(addressPreview('sms', '+911234')).toBe('+9***')
  })
})

describe('sequence definition validation', () => {
  const validStep = { channel: 'email', wait: { kind: 'immediate' }, subjectTemplate: 'Hi', bodyTemplate: 'Body' }

  it('assigns step indices from position rather than trusting the caller', () => {
    const definition = canonicaliseSequenceDefinition({
      steps: [validStep, { channel: 'sms', wait: { kind: 'duration', minutes: 60 }, bodyTemplate: 'Follow up' }],
    })
    expect(definition.steps.map((step) => step.stepIndex)).toEqual([0, 1])
  })

  it('rejects a sequence with no steps', () => {
    expect(() => canonicaliseSequenceDefinition({ steps: [] })).toThrow(SequenceDefinitionError)
  })

  it('enforces per-channel content rules', () => {
    expect(() => canonicaliseSequenceDefinition({ steps: [{ channel: 'email', wait: { kind: 'immediate' }, bodyTemplate: 'No subject' }] }))
      .toThrow(/requires a subject/)
    expect(() => canonicaliseSequenceDefinition({ steps: [{ channel: 'sms', wait: { kind: 'immediate' } }] }))
      .toThrow(/requires a body/)
    expect(() => canonicaliseSequenceDefinition({ steps: [{ channel: 'sms', wait: { kind: 'immediate' }, bodyTemplate: 'x'.repeat(2_000) }] }))
      .toThrow(/1600 characters/)
    // A WhatsApp step without an approved template cannot be sent outside a
    // session window at all, so it is refused at publish rather than at send.
    expect(() => canonicaliseSequenceDefinition({ steps: [{ channel: 'whatsapp', wait: { kind: 'immediate' }, bodyTemplate: 'Hello' }] }))
      .toThrow(/approved template name/)
  })

  it('rejects an unusable timezone and a meaningless quiet-hours window', () => {
    expect(() => canonicaliseSequenceDefinition({ steps: [validStep], defaultTimeZone: 'Not/AZone' })).toThrow(/not a timezone/)
    expect(() => canonicaliseSequenceDefinition({ steps: [validStep], quietHours: { enabled: true, startMinute: 480, endMinute: 480 } }))
      .toThrow(/cannot be identical/)
  })

  it('flags a first step with an implausibly long wait', () => {
    expect(() => canonicaliseSequenceDefinition({ steps: [{ ...validStep, wait: { kind: 'duration', minutes: 60 * 24 * 40 } }] }))
      .toThrow(/configuration error/)
  })

  it('hashes executable content only, so republishing unchanged content is stable', () => {
    const first = canonicaliseSequenceDefinition({ steps: [validStep] })
    const second = canonicaliseSequenceDefinition({ steps: [validStep] })
    expect(sequenceDefinitionHash(first)).toBe(sequenceDefinitionHash(second))

    const changed = canonicaliseSequenceDefinition({ steps: [{ ...validStep, bodyTemplate: 'Different' }] })
    expect(sequenceDefinitionHash(changed)).not.toBe(sequenceDefinitionHash(first))
  })

  it('accepts a valid multi-channel sequence and preserves the wait specs', () => {
    const definition = canonicaliseSequenceDefinition({
      steps: [
        validStep,
        { channel: 'sms', wait: { kind: 'duration', minutes: 4_320 }, bodyTemplate: 'Still interested?' },
        { channel: 'whatsapp', wait: { kind: 'time_of_day', hour: 9, minute: 30 }, whatsappTemplate: { name: 'follow_up_v2', languageCode: 'en' } },
      ],
      quietHours: { enabled: true, startMinute: 1_260, endMinute: 480 },
      defaultTimeZone: 'Asia/Kolkata',
    })
    expect(definition.steps).toHaveLength(3)
    expect(definition.steps[1]?.wait).toEqual({ kind: 'duration', minutes: 4_320 })
    expect(definition.steps[2]?.whatsappTemplate?.variables).toEqual([])
    expect(definition.defaultTimeZone).toBe('Asia/Kolkata')
  })
})

describe('whatsapp session window', () => {
  const now = new Date('2026-03-01T12:00:00.000Z')

  it('requires an approved template when there has been no inbound message', () => {
    expect(whatsappSessionMode(null, now)).toBe('template_required')
    expect(whatsappSessionMode(undefined, now)).toBe('template_required')
  })

  it('permits free-form inside the 24-hour window and requires a template outside it', () => {
    expect(whatsappSessionMode(new Date(now.getTime() - 60_000), now)).toBe('free_form_permitted')
    expect(whatsappSessionMode(new Date(now.getTime() - WHATSAPP_SESSION_WINDOW_MS + 1_000), now)).toBe('free_form_permitted')
    // Exactly at the boundary the window has closed.
    expect(whatsappSessionMode(new Date(now.getTime() - WHATSAPP_SESSION_WINDOW_MS), now)).toBe('template_required')
    expect(whatsappSessionMode(new Date(now.getTime() - 48 * 60 * 60_000), now)).toBe('template_required')
  })
})
