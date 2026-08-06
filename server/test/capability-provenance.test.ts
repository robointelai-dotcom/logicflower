import { describe, expect, it } from 'vitest'
import { resolveCapability } from '../src/services/capability/capabilityModel'

describe('capability provenance', () => {
  it('refuses to treat requested scopes as granted scopes', () => {
    // This is the [V3] defect in its exact original shape: the provider did not
    // echo a scope grant, the code substituted what it asked for, and a feature
    // that depends on the entitlement reported itself as working.
    const resolution = resolveCapability('ghl', 'workflow.inventory', {
      grantedScopes: ['workflows.readonly'],
      scopeSource: 'requested_not_confirmed',
    })
    expect(resolution.state).toBe('unverified')
    expect(resolution.state).not.toBe('available')
    expect(resolution.remediation).toBeTruthy()
  })

  it('refuses to treat an operator-typed scope list as evidence', () => {
    const resolution = resolveCapability('hubspot', 'workflow.inventory', {
      grantedScopes: ['automation'],
      scopeSource: 'operator_claimed',
    })
    expect(resolution.state).toBe('unverified')
  })

  it('accepts a scope the provider itself returned', () => {
    const resolution = resolveCapability('ghl', 'workflow.inventory', {
      grantedScopes: ['workflows.readonly'],
      scopeSource: 'provider_token_response',
    })
    expect(resolution.state).toBe('available')
    expect(resolution.evidence.scopeGranted).toBe(true)
  })

  it('reports unavailable when the provider granted other scopes but not the required one', () => {
    const resolution = resolveCapability('ghl', 'workflow.inventory', {
      grantedScopes: ['contacts.readonly'],
      scopeSource: 'provider_token_response',
    })
    expect(resolution.state).toBe('unavailable')
    expect(resolution.reason).toContain('workflows.readonly')
  })

  it('lets a live probe override an absent scope grant', () => {
    const observedAt = new Date('2026-08-05T10:00:00.000Z')
    const resolution = resolveCapability('ghl', 'workflow.inventory', {
      grantedScopes: [],
      scopeSource: 'requested_not_confirmed',
      probe: { state: 'available', statusCode: 200, observedAt },
    })
    expect(resolution.state).toBe('available')
    expect(resolution.evidence.probedAt).toEqual(observedAt)
  })

  it('lets a live refusal override a scope the provider claimed to grant', () => {
    // A provider can return a scope string and still refuse the call. Observed
    // behaviour outranks declared entitlement.
    const resolution = resolveCapability('ghl', 'workflow.inventory', {
      grantedScopes: ['workflows.readonly'],
      scopeSource: 'provider_token_response',
      probe: { state: 'unavailable', statusCode: 403, observedAt: new Date() },
    })
    expect(resolution.state).toBe('unavailable')
  })

  it('never resolves merge or delete to available from scopes alone', () => {
    for (const provider of ['ghl', 'hubspot', 'klaviyo', 'activecampaign']) {
      for (const capability of ['contact.merge', 'contact.delete'] as const) {
        const resolution = resolveCapability(provider, capability, {
          grantedScopes: ['contacts.write', 'crm.objects.contacts.write', 'profiles:write'],
          scopeSource: 'provider_token_response',
        })
        expect(resolution.state).toBe('unverified')
      }
    }
  })

  it('treats an inconclusive probe as unverified rather than a confirmation', () => {
    const resolution = resolveCapability('klaviyo', 'workflow.inventory', {
      grantedScopes: [],
      scopeSource: 'requested_not_confirmed',
      probe: { state: 'unverified', statusCode: 503, observedAt: new Date() },
    })
    expect(resolution.state).toBe('unverified')
  })
})
