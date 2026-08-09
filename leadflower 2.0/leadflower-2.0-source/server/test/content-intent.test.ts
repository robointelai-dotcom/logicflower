import { describe, expect, it } from 'vitest'
import { guidanceForIntent } from '../src/services/content/entityGraph'

/**
 * The intent field used to be a label nobody acted on. These check it now
 * changes what the editor is told — and that it never blocks anything.
 */
describe('search intent guidance', () => {
  const base = { capsuleCount: 0, hasInformationGain: false, wordCount: 300, bodyText: '' }

  it('says nothing when no intent is declared', () => {
    expect(guidanceForIntent({ ...base, intent: null })).toBeNull()
    expect(guidanceForIntent({ ...base, intent: undefined })).toBeNull()
  })

  it('asks an informational article for an answer up front', () => {
    const guidance = guidanceForIntent({ ...base, intent: 'informational' })!
    const capsule = guidance.checks.find((check) => check.label.includes('capsule'))!
    expect(capsule.met).toBe(false)

    const withCapsule = guidanceForIntent({ ...base, intent: 'informational', capsuleCount: 2 })!
    expect(withCapsule.checks.find((check) => check.label.includes('capsule'))!.met).toBe(true)
  })

  it('asks a commercial article to name a drawback', () => {
    // A comparison with no downsides reads as marketing and is trusted as such.
    const marketing = guidanceForIntent({ ...base, intent: 'commercial', bodyText: 'It is the best at everything.' })!
    expect(marketing.checks.find((check) => check.label.includes('limitation'))!.met).toBe(false)

    const honest = guidanceForIntent({
      ...base, intent: 'commercial',
      bodyText: 'It compares well against the alternative, however it does not suit multi-site operators.',
    })!
    expect(honest.checks.find((check) => check.label.includes('limitation'))!.met).toBe(true)
    expect(honest.checks.find((check) => check.label.includes('Compares'))!.met).toBe(true)
  })

  it('asks a transactional article for a price and a next step', () => {
    const vague = guidanceForIntent({ ...base, intent: 'transactional', bodyText: 'It is very good.' })!
    expect(vague.checks.every((check) => !check.met)).toBe(true)

    const complete = guidanceForIntent({
      ...base, intent: 'transactional',
      bodyText: 'Pricing starts free. Sign up in a minute.',
    })!
    expect(complete.checks.every((check) => check.met)).toBe(true)
  })

  it('asks a navigational page to stay short', () => {
    expect(guidanceForIntent({ ...base, intent: 'navigational', wordCount: 400 })!.checks[0]!.met).toBe(true)
    expect(guidanceForIntent({ ...base, intent: 'navigational', wordCount: 2_000 })!.checks[0]!.met).toBe(false)
  })

  it('gives advice on every unmet check, so a prompt is actionable', () => {
    for (const intent of ['informational', 'commercial', 'transactional', 'navigational'] as const) {
      const guidance = guidanceForIntent({ ...base, intent })!
      expect(guidance.goal.length).toBeGreaterThan(20)
      for (const check of guidance.checks) {
        expect(check.advice.length, `${intent}/${check.label} has no advice`).toBeGreaterThan(30)
      }
    }
  })
})
