import { describe, expect, it } from 'vitest'
import { isOptOutKeyword, messageAad, previewOf } from '../src/services/inbox/inboundIngestion'
import { isMissedCallStatus } from '../src/services/inbox/missedCall'
import {
  assertNoComplianceClaims,
  listSnapshots,
  loadSnapshots,
  snapshotSchema,
  type IndustrySnapshot,
} from '../src/services/snapshots/industrySnapshots'
import { canonicaliseStages } from '../src/services/crm/pipelines'
import { canonicaliseSequenceDefinition } from '../src/services/sequences/sequenceDefinition'
import { validateDefinition } from '../src/services/crm/customFields'

describe('inbound message handling', () => {
  it('recognises opt-out keywords only as a whole message', () => {
    for (const keyword of ['STOP', 'stop', ' Stop. ', 'unsubscribe', 'CANCEL', 'opt-out']) {
      expect(isOptOutKeyword(keyword)).toBe(true)
    }
    // "stop by the shop tomorrow" is a conversation, not a withdrawal of
    // consent. Treating it as one silently loses a customer.
    for (const message of ['stop by the shop tomorrow', 'can you stop the work', 'I want to cancel my 3pm', 'please end the quote at 500']) {
      expect(isOptOutKeyword(message)).toBe(false)
    }
    expect(isOptOutKeyword('')).toBe(false)
  })

  it('builds a preview that is single-line and bounded', () => {
    expect(previewOf('  hello\n\n  world  ')).toBe('hello world')
    expect(previewOf('x'.repeat(500))).toHaveLength(140)
    expect(previewOf('')).toBe('')
  })

  it('binds a message ciphertext to its own record and field', () => {
    // A shared AAD would let a body ciphertext be swapped for a subject, or one
    // message's content be relabelled as another's.
    const bodyAad = messageAad('org-1', 'msg-1', 'body')
    expect(bodyAad).not.toBe(messageAad('org-1', 'msg-1', 'subject'))
    expect(bodyAad).not.toBe(messageAad('org-1', 'msg-2', 'body'))
    expect(bodyAad).not.toBe(messageAad('org-2', 'msg-1', 'body'))
  })
})

describe('missed call detection', () => {
  it('treats only genuine no-answers as missed', () => {
    for (const status of ['no-answer', 'busy', 'failed', 'canceled', 'NO-ANSWER']) {
      expect(isMissedCallStatus(status)).toBe(true)
    }
    // Texting someone you just spoke to reads as automation nobody is minding.
    for (const status of ['completed', 'in-progress', 'ringing', 'queued', '']) {
      expect(isMissedCallStatus(status)).toBe(false)
    }
  })
})

describe('industry snapshots', () => {
  it('loads every shipped snapshot and validates it', () => {
    const snapshots = loadSnapshots()
    expect(snapshots.size).toBeGreaterThanOrEqual(3)
    for (const id of ['trades', 'healthcare_wellness', 'professional_services']) {
      expect(snapshots.has(id)).toBe(true)
    }
  })

  it('exposes a summary without loading the whole definition', () => {
    const listed = listSnapshots()
    const trades = listed.find((entry) => entry.id === 'trades')
    expect(trades?.sequenceCount).toBeGreaterThan(0)
    expect(trades?.stageCount).toBeGreaterThan(0)
    expect(Array.isArray(trades?.operatorNotes)).toBe(true)
  })

  /**
   * A snapshot is data, which makes it the easiest place for a marketing claim
   * to reach a customer without passing a code review.
   */
  it('rejects a snapshot asserting a compliance certification', () => {
    const base = loadSnapshots().get('healthcare_wellness') as IndustrySnapshot
    for (const claim of [
      'HIPAA-compliant intake form',
      'This practice is hipaa compliant',
      'GDPR compliant messaging',
      'SOC 2 certified',
      'certified with HIPAA',
    ]) {
      const offending = { ...base, operatorNotes: [claim] }
      expect(() => assertNoComplianceClaims(offending as IndustrySnapshot)).toThrow(/compliance certification/)
    }
  })

  it('permits describing the controls without asserting the certification', () => {
    const base = loadSnapshots().get('trades') as IndustrySnapshot
    const acceptable = {
      ...base,
      operatorNotes: [
        'Privacy controls suitable for handling health information, subject to your own compliance programme.',
        'Encrypted message logs, role-based access and an audit trail are provided.',
        'Take your own advice on HIPAA and GDPR obligations.',
      ],
    }
    expect(() => assertNoComplianceClaims(acceptable as IndustrySnapshot)).not.toThrow()
  })

  it('every shipped snapshot is free of compliance claims', () => {
    for (const snapshot of loadSnapshots().values()) {
      expect(() => assertNoComplianceClaims(snapshot)).not.toThrow()
    }
  })

  /**
   * The snapshot format promises that a new vertical is a JSON file rather than
   * a release. That only holds if the data in one actually satisfies the same
   * validators the API applies, so each shipped snapshot is pushed through them
   * here rather than trusted.
   */
  it('every shipped snapshot produces valid custom fields, stages and sequences', () => {
    for (const snapshot of loadSnapshots().values()) {
      for (const field of snapshot.customFields) {
        expect(() => validateDefinition(field)).not.toThrow()
      }
      if (snapshot.pipeline) {
        const stages = canonicaliseStages(snapshot.pipeline.stages.map((stage) => ({
          name: stage.name, outcome: stage.outcome, probability: stage.probability, taskTemplates: stage.taskTemplates,
        })))
        expect(stages.length).toBe(snapshot.pipeline.stages.length)
        expect(stages.some((stage) => stage.outcome === 'open')).toBe(true)
      }
      for (const template of snapshot.sequences) {
        expect(() => canonicaliseSequenceDefinition({
          steps: template.steps,
          quietHours: template.quietHours,
          defaultTimeZone: template.defaultTimeZone || 'UTC',
        })).not.toThrow()
      }
    }
  })

  it('rejects a malformed snapshot rather than skipping it', () => {
    // A snapshot that is silently ignored looks identical to one that does not
    // exist, and the first anyone hears of it is a customer asking why
    // onboarding produced nothing.
    expect(snapshotSchema.safeParse({ id: 'Bad Id', name: 'x', version: 1 }).success).toBe(false)
    expect(snapshotSchema.safeParse({ id: 'ok', name: '', version: 1 }).success).toBe(false)
    expect(snapshotSchema.safeParse({ id: 'ok', name: 'x', version: 0 }).success).toBe(false)
  })

  it('ships healthcare templates that carry no clinical detail', () => {
    // SMS and email are not confidential channels: a reminder that names a
    // procedure discloses it to anyone who sees the phone screen.
    const healthcare = loadSnapshots().get('healthcare_wellness') as IndustrySnapshot
    const templateText = healthcare.sequences
      .flatMap((sequence) => sequence.steps.map((step) => `${step.subjectTemplate || ''} ${step.bodyTemplate || ''}`))
      .join(' ')
      .toLowerCase()
    for (const clinicalTerm of ['diagnosis', 'prescription', 'treatment for', 'test result', 'symptom', 'procedure']) {
      expect(templateText).not.toContain(clinicalTerm)
    }
    // And the operator is told why, not left to infer it.
    expect(healthcare.operatorNotes.join(' ')).toMatch(/not confidential channels|no clinical detail/i)
  })

  it('creates sequences and forms as drafts, never active', () => {
    // A snapshot must not begin messaging real people the moment an onboarding
    // wizard finishes. This is asserted on the shipped data's shape: no
    // snapshot may declare a status at all.
    for (const snapshot of loadSnapshots().values()) {
      for (const sequence of snapshot.sequences) {
        expect((sequence as unknown as Record<string, unknown>).status).toBeUndefined()
      }
      for (const form of snapshot.forms) {
        expect((form as unknown as Record<string, unknown>).status).toBeUndefined()
      }
    }
  })
})
