import { describe, expect, it } from 'vitest'
import { canonicaliseStages, MAX_STAGES, PipelineError } from '../src/services/crm/pipelines'

describe('pipeline stage canonicalisation', () => {
  const openStage = { name: 'New enquiry' }

  it('assigns positions from array order rather than trusting the caller', () => {
    const stages = canonicaliseStages([{ name: 'New' }, { name: 'Quoted' }, { name: 'Won', outcome: 'won' }])
    expect(stages.map((stage) => stage.position)).toEqual([0, 1, 2])
    expect(stages.map((stage) => stage.name)).toEqual(['New', 'Quoted', 'Won'])
  })

  it('generates a stable stage identifier and preserves one that is supplied', () => {
    const first = canonicaliseStages([openStage])
    expect(first[0]?.stageId).toMatch(/^[a-f0-9]{16}$/)

    // Renaming must keep the identifier, or every deal in the stage is orphaned
    // and any sequence trigger bound to it breaks silently.
    const renamed = canonicaliseStages([{ stageId: first[0]!.stageId, name: 'Initial enquiry' }])
    expect(renamed[0]?.stageId).toBe(first[0]?.stageId)
    expect(renamed[0]?.name).toBe('Initial enquiry')
  })

  it('rejects duplicate stage names and duplicate identifiers', () => {
    expect(() => canonicaliseStages([{ name: 'Quoted' }, { name: 'quoted' }])).toThrow(/duplicates an earlier stage name/)
    expect(() => canonicaliseStages([{ stageId: 'abc', name: 'A' }, { stageId: 'abc', name: 'B' }])).toThrow(/duplicate stage identifier/)
  })

  it('rejects a malformed stage identifier', () => {
    // The identifier reaches a query predicate, so it is constrained to a safe
    // character set rather than trusted.
    expect(() => canonicaliseStages([{ stageId: 'a.$ne', name: 'A' }])).toThrow(/malformed/)
    expect(() => canonicaliseStages([{ stageId: 'x'.repeat(40), name: 'A' }])).toThrow(/malformed/)
  })

  it('requires at least one open stage', () => {
    // A pipeline of only won and lost stages has nowhere for a live deal to sit.
    expect(() => canonicaliseStages([{ name: 'Won', outcome: 'won' }, { name: 'Lost', outcome: 'lost' }]))
      .toThrow(/at least one open stage/)
  })

  it('bounds stage count and validates probability', () => {
    expect(() => canonicaliseStages([])).toThrow(/at least one stage/)
    expect(() => canonicaliseStages(Array.from({ length: MAX_STAGES + 1 }, (_, i) => ({ name: `S${i}` }))))
      .toThrow(/more than 20 stages/)
    expect(() => canonicaliseStages([{ name: 'A', probability: 120 }])).toThrow(/between 0 and 100/)
    expect(() => canonicaliseStages([{ name: 'A', outcome: 'archived' as any }])).toThrow(/open, won or lost/)
  })

  it('carries sequence triggers through unchanged', () => {
    const stages = canonicaliseStages([
      { name: 'Quoted', enrolSequenceId: 'seq-chase', exitSequenceId: 'seq-nurture' },
      { name: 'Won', outcome: 'won' },
    ])
    expect(stages[0]?.enrolSequenceId).toBe('seq-chase')
    expect(stages[0]?.exitSequenceId).toBe('seq-nurture')
    expect(stages[1]?.enrolSequenceId).toBeNull()
  })

  it('collects every issue rather than failing on the first', () => {
    try {
      canonicaliseStages([{ name: '' }, { name: 'A', probability: -5 }])
      throw new Error('should have thrown')
    } catch (error: any) {
      expect(error).toBeInstanceOf(PipelineError)
      expect(error.issues.length).toBeGreaterThanOrEqual(2)
    }
  })
})
