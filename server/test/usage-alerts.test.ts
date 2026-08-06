import { describe, expect, it } from 'vitest'
import { OVERAGE_CENTS_PER_10K, overageCents, overageUnits, thresholdsCrossed } from '../src/services/usageAlerts'

describe('usage thresholds', () => {
  it('raises the 80% notice on the crossing reservation only', () => {
    expect(thresholdsCrossed(15_900, 16_000, 20_000)).toEqual([80])
    expect(thresholdsCrossed(16_000, 16_100, 20_000)).toEqual([])
  })

  it('raises both notices when one large job jumps past both boundaries', () => {
    // A 50,000-record batch on a 20,000 allowance must not silently skip the
    // 80% warning just because it also crossed 100%.
    expect(thresholdsCrossed(0, 50_000, 20_000)).toEqual([80, 100])
  })

  it('raises nothing when usage stays below the first boundary', () => {
    expect(thresholdsCrossed(0, 15_999, 20_000)).toEqual([])
  })

  it('raises nothing for an unlimited or unset limit', () => {
    expect(thresholdsCrossed(0, 1_000_000, 0)).toEqual([])
    expect(thresholdsCrossed(0, 1_000_000, Number.POSITIVE_INFINITY)).toEqual([])
  })
})

describe('overage accounting', () => {
  it('accrues nothing at or below the allowance', () => {
    expect(overageUnits(20_000, 20_000)).toBe(0)
    expect(overageCents('starter', 20_000, 20_000)).toBe(0)
  })

  it('bills a partial block as a whole block', () => {
    expect(overageUnits(20_001, 20_000)).toBe(1)
    expect(overageUnits(30_000, 20_000)).toBe(1)
    expect(overageUnits(30_001, 20_000)).toBe(2)
  })

  it('prices each plan at the rate in the report pricing table', () => {
    // Report section 24.4: $6 / $5 / $4 per 10,000 records.
    expect(OVERAGE_CENTS_PER_10K.starter).toBe(600)
    expect(OVERAGE_CENTS_PER_10K.agency).toBe(500)
    expect(OVERAGE_CENTS_PER_10K.scale).toBe(400)
    expect(overageCents('agency', 130_000, 100_000)).toBe(1_500)
  })

  it('accrues nothing on a plan with no published overage rate', () => {
    // An unpriced plan must never generate a charge nobody agreed to.
    expect(overageCents('free', 999_999, 1_000)).toBe(0)
    expect(overageCents('enterprise', 999_999, 1_000)).toBe(0)
  })
})
