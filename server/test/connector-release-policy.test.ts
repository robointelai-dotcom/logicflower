import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadReleaseState(overrides: string) {
  vi.resetModules()
  process.env.CONNECTOR_RELEASE_STATES = overrides
  const module = await import('../src/services/connectors/releaseState')
  module.resetConnectorReleaseStateCache()
  return module
}

afterEach(() => {
  delete process.env.CONNECTOR_RELEASE_STATES
  vi.resetModules()
})

describe('connector release policy', () => {
  it('quarantines ActiveCampaign by default pending the [V14] licence review', async () => {
    const { connectorReleaseState, canCreateConnection, canWrite, canRead } = await loadReleaseState('')
    expect(connectorReleaseState('activecampaign')).toBe('quarantined')
    expect(canCreateConnection('activecampaign')).toBe(false)
    expect(canWrite('activecampaign')).toBe(false)
    // Quarantine is not deletion: existing connections stay readable so a
    // customer can export and disconnect cleanly.
    expect(canRead('activecampaign')).toBe(true)
  })

  it('leaves reviewed connectors generally available', async () => {
    const { canWrite, canCreateConnection } = await loadReleaseState('')
    for (const provider of ['ghl', 'hubspot', 'klaviyo', 'google']) {
      expect(canWrite(provider)).toBe(true)
      expect(canCreateConnection(provider)).toBe(true)
    }
  })

  it('defaults an unknown provider to quarantined rather than open', async () => {
    const { connectorReleaseState } = await loadReleaseState('')
    expect(connectorReleaseState('some-new-crm')).toBe('quarantined')
  })

  it('allows sign-off through configuration without a code change', async () => {
    const { canWrite } = await loadReleaseState('activecampaign:general')
    expect(canWrite('activecampaign')).toBe(true)
  })

  it('ignores a malformed override instead of failing open', async () => {
    const { connectorReleaseState } = await loadReleaseState('activecampaign:totally-enabled,ghl')
    expect(connectorReleaseState('activecampaign')).toBe('quarantined')
    expect(connectorReleaseState('ghl')).toBe('general')
  })

  it('supports a full shutdown of a connector', async () => {
    const { canRead, canWrite } = await loadReleaseState('klaviyo:disabled')
    expect(canRead('klaviyo')).toBe(false)
    expect(canWrite('klaviyo')).toBe(false)
  })
})

describe('provider data retention policy', () => {
  it('purges provider-derived data on disconnection unless counsel confirmed retention', async () => {
    const { retentionDaysAfterDisconnect, providerDataPolicy } = await import('../src/services/retention/providerDataPolicy')
    for (const provider of ['ghl', 'hubspot', 'klaviyo', 'activecampaign', 'google', 'unknown-provider']) {
      expect(retentionDaysAfterDisconnect(provider)).toBe(0)
      expect(providerDataPolicy(provider).legalBasis).toBe('unreviewed')
    }
  })

  it('ignores a retention window that is not backed by a confirmed legal basis', async () => {
    const { retentionDaysAfterDisconnect } = await import('../src/services/retention/providerDataPolicy')
    // Even if a day count were set by mistake, an unreviewed basis purges.
    expect(retentionDaysAfterDisconnect('hubspot')).toBe(0)
  })
})
