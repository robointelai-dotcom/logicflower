import { describe, expect, it } from 'vitest'
import { policyForPlan } from '../src/services/planPolicy'

describe('published plan policy', () => {
  it('matches the approved connection and retention tiers', () => {
    expect(policyForPlan('starter')).toMatchObject({ maxConnections: 3, maxRetentionDays: 7, workflowVersionLimit: 5 })
    expect(policyForPlan('agency')).toMatchObject({ maxConnections: 15, maxRetentionDays: 30, workflowHistoryDays: 30 })
    expect(policyForPlan('scale')).toMatchObject({ maxConnections: 50, maxRetentionDays: 90, workflowHistoryDays: 365 })
  })

  it('fails an ineligible paid subscription down to free capacity', () => {
    expect(policyForPlan('scale', false)).toMatchObject({ plan: 'free', eligible: false, maxConnections: 1, maxRetentionDays: 7 })
  })
})
