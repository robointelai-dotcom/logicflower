import { describe, expect, it } from 'vitest'
import {
  CONSERVATIVE_WINDOW,
  UnavailableDndChecker,
  assertValidWindow,
  evaluateCallingWindow,
  isWiderThanDefault,
  localWeekday,
  nextPermittedInstant,
  type JurisdictionPolicy,
} from '../src/services/voice/callingWindows'
import {
  evaluateDialGates,
  isDeferrable,
  UnimplementedConversationEngine,
  UnimplementedTelephonyProvider,
  VoiceProviderUnavailableError,
  voiceProviderStatus,
} from '../src/services/voice/voiceProvider'
import {
  AgentDefinitionError,
  agentDefinitionHash,
  canonicaliseAgentDefinition,
  detectOptOut,
  openingDisclosures,
  PROVIDER_DEFAULTS,
  renderPrompt,
} from '../src/services/voice/agentDefinition'

const IST = 'Asia/Kolkata'

function policy(overrides: Partial<JurisdictionPolicy> = {}): JurisdictionPolicy {
  return {
    label: 'Test jurisdiction',
    window: { ...CONSERVATIVE_WINDOW, permittedWeekdays: [...CONSERVATIVE_WINDOW.permittedWeekdays] },
    blackoutDates: [],
    legalReviewRecordedBy: null,
    legalReviewedAt: null,
    ...overrides,
  }
}

describe('calling windows', () => {
  it('permits a call inside the default window', () => {
    // 09:00 UTC is 14:30 in Kolkata on a Monday.
    const decision = evaluateCallingWindow({ now: new Date('2026-03-02T09:00:00Z'), timeZone: IST, policy: policy() })
    expect(decision.permitted).toBe(true)
  })

  it('refuses a call outside the window and offers the next permitted instant', () => {
    // 02:00 UTC is 07:30 local — before the 09:00 start.
    const decision = evaluateCallingWindow({ now: new Date('2026-03-02T02:00:00Z'), timeZone: IST, policy: policy() })
    expect(decision.permitted).toBe(false)
    expect(decision.reason).toBe('outside_calling_window')
    expect(decision.nextPermittedAt).toBeInstanceOf(Date)
    // The next permitted instant must itself pass the same predicate.
    expect(evaluateCallingWindow({ now: decision.nextPermittedAt!, timeZone: IST, policy: policy() }).permitted).toBe(true)
  })

  it('excludes Sunday by default', () => {
    // 2026-03-01 is a Sunday. 09:00 UTC is 14:30 local, inside the hours.
    expect(localWeekday(new Date('2026-03-01T09:00:00Z'), IST)).toBe(0)
    const decision = evaluateCallingWindow({ now: new Date('2026-03-01T09:00:00Z'), timeZone: IST, policy: policy() })
    expect(decision.permitted).toBe(false)
  })

  it('refuses a call when the contact timezone cannot be resolved', () => {
    // For a message an unresolvable zone is a timing error. For a phone call it
    // means dialling a stranger at an hour decided by accident, so it blocks.
    for (const zone of [null, undefined, '', 'Not/AZone']) {
      const decision = evaluateCallingWindow({ now: new Date('2026-03-02T09:00:00Z'), timeZone: zone, policy: policy() })
      expect(decision.permitted).toBe(false)
      expect(decision.reason).toBe('invalid_timezone')
    }
  })

  it('refuses a widened window that nobody has reviewed', () => {
    // Software must not be the thing that decided 07:00 calls were acceptable.
    const wide = policy({ window: { startMinute: 7 * 60, endMinute: 21 * 60, permittedWeekdays: [0, 1, 2, 3, 4, 5, 6] } })
    const decision = evaluateCallingWindow({ now: new Date('2026-03-02T09:00:00Z'), timeZone: IST, policy: wide })
    expect(decision.permitted).toBe(false)
    expect(decision.reason).toBe('unreviewed_window')

    // With a recorded review it is permitted.
    const reviewed = { ...wide, legalReviewRecordedBy: 'user-1', legalReviewedAt: new Date() }
    expect(evaluateCallingWindow({ now: new Date('2026-03-02T09:00:00Z'), timeZone: IST, policy: reviewed }).permitted).toBe(true)
  })

  it('allows narrowing without review', () => {
    // A more cautious operator needs no permission to be more cautious.
    const narrow = policy({ window: { startMinute: 10 * 60, endMinute: 17 * 60, permittedWeekdays: [1, 2, 3, 4, 5] } })
    expect(isWiderThanDefault(narrow.window)).toBe(false)
    expect(evaluateCallingWindow({ now: new Date('2026-03-02T09:00:00Z'), timeZone: IST, policy: narrow }).permitted).toBe(true)
  })

  it('honours blackout dates in local time', () => {
    const blacked = policy({ blackoutDates: ['2026-03-02'] })
    const decision = evaluateCallingWindow({ now: new Date('2026-03-02T09:00:00Z'), timeZone: IST, policy: blacked })
    expect(decision.permitted).toBe(false)
    expect(decision.reason).toBe('blackout_date')
    expect(decision.nextPermittedAt).toBeInstanceOf(Date)
  })

  it('rejects an overnight window as a configuration error', () => {
    // Permitting one would let a misconfiguration authorise 3am calls.
    expect(() => assertValidWindow({ startMinute: 21 * 60, endMinute: 8 * 60, permittedWeekdays: [1] }))
      .toThrow(/must start before it ends/)
    expect(() => assertValidWindow({ startMinute: 0, endMinute: 0, permittedWeekdays: [1] })).toThrow()
    expect(() => assertValidWindow({ startMinute: 9 * 60, endMinute: 17 * 60, permittedWeekdays: [] })).toThrow(/at least one weekday/)
    expect(() => assertValidWindow({ startMinute: 9 * 60, endMinute: 17 * 60, permittedWeekdays: [9] })).toThrow(/0 \(Sunday\) to 6/)
  })

  it('finds no permitted instant when nothing is permitted', () => {
    const impossible = policy({ blackoutDates: Array.from({ length: 20 }, (_, offset) => `2026-03-${String(offset + 2).padStart(2, '0')}`) })
    expect(nextPermittedInstant(new Date('2026-03-02T09:00:00Z'), IST, impossible, 5)).toBeUndefined()
  })
})

describe('dial gate chain', () => {
  const base = {
    now: new Date('2026-03-02T09:00:00Z'),
    organizationId: 'org-1',
    phoneNumber: '+919876543210',
    timeZone: IST,
    jurisdiction: 'IN',
    policy: policy(),
    suppressionCheck: async () => null,
    hasConsentRecord: true,
    dndChecker: { check: async () => ({ registered: false, checkedAt: new Date(), source: 'test' }) },
  }

  it('permits a call when every gate passes', async () => {
    const decision = await evaluateDialGates(base)
    expect(decision.permitted).toBe(true)
    expect(decision.evaluated.map((gate) => gate.gate)).toEqual(['suppression', 'consent_record', 'dnd_registry', 'calling_window'])
    expect(decision.evaluated.every((gate) => gate.passed)).toBe(true)
  })

  it('blocks every call when no DND checker is configured', async () => {
    // A checker that cannot verify must not report a number as clear. The
    // default fails closed, so a dialer without registry access does not dial.
    const checker = new UnavailableDndChecker()
    expect((await checker.check()).registered).toBe(true)

    const decision = await evaluateDialGates({ ...base, dndChecker: undefined })
    expect(decision.permitted).toBe(false)
    expect(decision.reason).toBe('dnd_registry')
    expect(decision.detail).toMatch(/No do-not-call registry checker is configured/)
  })

  it('blocks a suppressed number', async () => {
    const decision = await evaluateDialGates({ ...base, suppressionCheck: async () => 'unsubscribed' })
    expect(decision.permitted).toBe(false)
    expect(decision.reason).toBe('suppressed')
  })

  it('blocks when suppression cannot be verified', async () => {
    const decision = await evaluateDialGates({
      ...base,
      suppressionCheck: async () => { throw new Error('database unavailable') },
    })
    expect(decision.permitted).toBe(false)
    expect(decision.reason).toBe('suppressed')
    expect(decision.detail).toMatch(/refused rather than placed unverified/)
  })

  it('blocks a contact with no recorded consent basis', async () => {
    const decision = await evaluateDialGates({ ...base, hasConsentRecord: false })
    expect(decision.permitted).toBe(false)
    expect(decision.reason).toBe('no_consent_record')
  })

  it('evaluates every gate even after one fails, for the audit record', async () => {
    // "The call was blocked for a different reason first" is not an answer when
    // a regulator asks whether the DND registry was consulted.
    const decision = await evaluateDialGates({ ...base, hasConsentRecord: false, suppressionCheck: async () => 'unsubscribed' })
    expect(decision.permitted).toBe(false)
    expect(decision.evaluated).toHaveLength(4)
    expect(decision.evaluated.find((gate) => gate.gate === 'dnd_registry')).toBeDefined()
    expect(decision.evaluated.find((gate) => gate.gate === 'calling_window')).toBeDefined()
  })

  it('reports the first blocking reason rather than the last', async () => {
    const decision = await evaluateDialGates({ ...base, suppressionCheck: async () => 'hard_bounce', hasConsentRecord: false })
    expect(decision.reason).toBe('suppressed')
  })

  it('defers on timing but never on consent or registry status', async () => {
    // Retrying a DND-listed number on a schedule turns one misconfiguration
    // into a pattern of violations.
    expect(isDeferrable('outside_calling_window')).toBe(true)
    expect(isDeferrable('blackout_date')).toBe(true)
    expect(isDeferrable('dnd_registry')).toBe(false)
    expect(isDeferrable('no_consent_record')).toBe(false)
    expect(isDeferrable('suppressed')).toBe(false)
    expect(isDeferrable('invalid_timezone')).toBe(false)

    const decision = await evaluateDialGates({ ...base, now: new Date('2026-03-02T02:00:00Z') })
    expect(decision.permitted).toBe(false)
    expect(decision.reason).toBe('outside_calling_window')
    expect(decision.deferUntil).toBeInstanceOf(Date)
  })
})

describe('voice providers', () => {
  it('refuses to place a call, with the documentation needed', async () => {
    await expect(new UnimplementedTelephonyProvider().placeCall({
      organizationId: 'org-1', toNumber: '+919876543210', fromNumber: '+911111111111',
      voiceCallId: 'call-1', maxDurationSeconds: 300, recordingEnabled: false,
    })).rejects.toBeInstanceOf(VoiceProviderUnavailableError)

    await expect(new UnimplementedConversationEngine().startSession({
      voiceCallId: 'call-1', providerCallId: 'p-1', prompt: 'x', language: 'en',
      openingLines: [], permittedActions: [],
    })).rejects.toBeInstanceOf(VoiceProviderUnavailableError)
  })

  it('reports both layers as unimplemented and separately documented', () => {
    const status = voiceProviderStatus()
    expect(status.telephony.implemented).toBe(false)
    expect(status.conversation.implemented).toBe(false)
    // Separate concerns, separate documentation: changing voice vendor must not
    // mean rewriting the telephony integration and the gate logic with it.
    expect(status.telephony.documentationNeeded).not.toBe(status.conversation.documentationNeeded)
  })
})

describe('voice agent definitions', () => {
  const valid = {
    name: 'Speed to lead',
    prompt: 'You are calling {{contact.firstName}} on behalf of {{organization.name}} about their recent enquiry. Be brief and helpful.',
    language: 'en',
    permittedActions: ['book_appointment', 'end_call'],
    disclosures: { aiDisclosureText: 'Hello, this is an automated assistant calling on behalf of the business.' },
  }

  it('accepts a valid agent and records the variables it uses', () => {
    const agent = canonicaliseAgentDefinition(valid)
    expect(agent.referencedVariables.sort()).toEqual(['contact.firstName', 'organization.name'])
  })

  it('refuses a prompt referencing a variable outside the allow-list', () => {
    // A prompt is read aloud. Letting it address arbitrary paths would let an
    // agent recite internal notes down a phone line.
    expect(() => canonicaliseAgentDefinition({ ...valid, prompt: 'Tell them about {{contact.customFields.diagnosis}} please, at length.' }))
      .toThrow(/not a permitted variable/)
    expect(() => canonicaliseAgentDefinition({ ...valid, prompt: 'Mention {{contact.email}} to them during the call somewhere.' }))
      .toThrow(/not a permitted variable/)
  })

  it('requires an AI disclosure and refuses to make it optional', () => {
    expect(() => canonicaliseAgentDefinition({ ...valid, disclosures: { aiDisclosureText: '' } })).toThrow(AgentDefinitionError)
    expect(() => canonicaliseAgentDefinition({ ...valid, disclosures: { aiDisclosureText: 'hi' } })).toThrow(AgentDefinitionError)
  })

  it('refuses recording without a consent announcement', () => {
    // Whether recording is lawful turns on consent rules this system cannot
    // evaluate, so it is refused rather than defaulted.
    expect(() => canonicaliseAgentDefinition({
      ...valid,
      disclosures: { aiDisclosureText: valid.disclosures.aiDisclosureText, recordingEnabled: true },
    })).toThrow(/cannot be enabled without a consent announcement/)

    expect(() => canonicaliseAgentDefinition({
      ...valid,
      disclosures: { aiDisclosureText: valid.disclosures.aiDisclosureText, recordingEnabled: true, recordingConsentText: 'This call is recorded for quality purposes.' },
    })).not.toThrow()
  })

  it('merges baseline opt-out phrases that configuration cannot remove', () => {
    // "Stop calling me" must end a call whether or not an operator listed it.
    const agent = canonicaliseAgentDefinition({ ...valid, disclosures: { ...valid.disclosures, optOutPhrases: ['no thanks mate'] } })
    expect(agent.disclosures.optOutPhrases).toContain('stop calling')
    expect(agent.disclosures.optOutPhrases).toContain('do not call')
    expect(agent.disclosures.optOutPhrases).toContain('no thanks mate')
  })

  it('detects an opt-out inside conversational speech', () => {
    const agent = canonicaliseAgentDefinition(valid)
    // Speech is conversational, so this matches on substring — unlike the SMS
    // keyword check, which matches the whole message.
    expect(detectOptOut('yeah look, just stop calling me please', agent).optedOut).toBe(true)
    expect(detectOptOut('Please REMOVE ME from your list.', agent).optedOut).toBe(true)
    // Apostrophe handling: both the utterance and the phrase list go through
    // the same normaliser, so contractions match. Normalising only one side is
    // a silent failure — the call simply continues.
    expect(detectOptOut("don't call again", agent).optedOut).toBe(true)
    expect(detectOptOut('dont call me anymore', agent).optedOut).toBe(true)
    // A false positive, and an acceptable one: "I don't call people back"
    // contains "dont call". Ending a call that was not quite a refusal costs
    // one call; missing a real refusal costs a regulatory complaint. The
    // asymmetry is chosen, not accidental.
    expect(detectOptOut('I don\u2019t call people back, sorry', agent).optedOut).toBe(true)
    expect(detectOptOut('yes that sounds good, can you call me back tomorrow', agent).optedOut).toBe(false)
    expect(detectOptOut('', agent).optedOut).toBe(false)
  })

  it('documents that keyword matching MISSES real opt-outs', () => {
    const agent = canonicaliseAgentDefinition(valid)
    // These are unambiguous refusals to a human ear and none contain a
    // configured phrase. This test asserts the gap deliberately: keyword
    // matching is a FLOOR, not a solution.
    //
    // The conversational provider must also signal opt-out intent, and its
    // signal must be honoured independently of this function. Relying on
    // keywords alone means an agent argues with someone who has already
    // refused — which is the single worst thing an automated caller can do and
    // exactly what regulators look at.
    for (const refusal of [
      'I would rather you did not contact me again',
      'no, I am not interested, please leave it',
      'take my number off whatever list this is',
    ]) {
      expect(detectOptOut(refusal, agent).optedOut).toBe(false)
    }
  })

  it('assembles the opening disclosures in order', () => {
    const agent = canonicaliseAgentDefinition({
      ...valid,
      disclosures: { aiDisclosureText: 'This is an automated assistant.', recordingEnabled: true, recordingConsentText: 'This call is recorded.' },
    })
    expect(openingDisclosures(agent)).toEqual(['This is an automated assistant.', 'This call is recorded.'])

    const noRecording = canonicaliseAgentDefinition(valid)
    expect(openingDisclosures(noRecording)).toEqual([valid.disclosures.aiDisclosureText])
  })

  it('renders a prompt and blanks unresolved variables', () => {
    const agent = canonicaliseAgentDefinition(valid)
    const rendered = renderPrompt(agent, { 'contact.firstName': 'Priya', 'organization.name': 'Acme Roofing' })
    expect(rendered).toContain('Priya')
    expect(rendered).toContain('Acme Roofing')
    expect(rendered).not.toContain('{{')

    // An agent reading "Hi {{contact.firstName}}" aloud is worse than "Hi".
    const partial = renderPrompt(agent, { 'organization.name': 'Acme Roofing' })
    expect(partial).not.toContain('{{')
    expect(partial).not.toContain('contact.firstName')
  })

  it('refuses a script on an agent type that ignores one', () => {
    // Only a sales representative follows a step-by-step script. Storing one on
    // the other types would leave an operator believing their script was being
    // followed when the platform never reads it.
    expect(() => canonicaliseAgentDefinition({ ...valid, agentType: 'support_agent', script: 'Step 1. Greet them.' }))
      .toThrow(/only a sales representative/)
    expect(() => canonicaliseAgentDefinition({ ...valid, agentType: 'sales_representative', script: 'Step 1. Greet them.' }))
      .not.toThrow()
  })

  it('refuses a restricted topic with no words to say instead', () => {
    // A restriction without wording leaves the agent to improvise the very
    // answer the restriction exists to prevent.
    expect(() => canonicaliseAgentDefinition({ ...valid, restrictedTopics: [{ topic: 'medical advice', refusalWording: '   ' }] }))
      .toThrow()
    expect(() => canonicaliseAgentDefinition({
      ...valid,
      restrictedTopics: [{ topic: 'medical advice', refusalWording: 'I will have someone qualified call you back.' }],
    })).not.toThrow()
  })

  it('carries the provider defaults rather than inventing our own', () => {
    const agent = canonicaliseAgentDefinition(valid)
    expect(agent.welcomeMessageDelaySeconds).toBe(PROVIDER_DEFAULTS.welcomeMessageDelaySeconds)
    expect(agent.machineTimeoutSeconds).toBe(PROVIDER_DEFAULTS.machineTimeoutSeconds)
  })

  it('changes the hash when behaviour changes, not only the prompt', () => {
    const base = canonicaliseAgentDefinition(valid)
    for (const change of [
      { goal: 'Book a survey' },
      { tone: 'Formal' },
      { welcomeMessage: 'Hello there.' },
      { restrictedTopics: [{ topic: 'pricing', refusalWording: 'A colleague will confirm that.' }] },
    ]) {
      expect(agentDefinitionHash(canonicaliseAgentDefinition({ ...valid, ...change }))).not.toBe(agentDefinitionHash(base))
    }
  })

  it('hashes executable content so a recording can be tied to a script', () => {
    const first = canonicaliseAgentDefinition(valid)
    expect(agentDefinitionHash(first)).toBe(agentDefinitionHash(canonicaliseAgentDefinition(valid)))

    const changed = canonicaliseAgentDefinition({ ...valid, prompt: `${valid.prompt} Also mention the warranty.` })
    expect(agentDefinitionHash(changed)).not.toBe(agentDefinitionHash(first))

    // A changed disclosure must change the hash: it is the part most likely to
    // be questioned after a complaint.
    const newDisclosure = canonicaliseAgentDefinition({ ...valid, disclosures: { aiDisclosureText: 'Hi, an automated assistant here calling for the business.' } })
    expect(agentDefinitionHash(newDisclosure)).not.toBe(agentDefinitionHash(first))
  })
})
