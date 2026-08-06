import { describe, expect, it, vi } from 'vitest'
import { HttpError } from '../src/http/problem'
import { PolicyConnectorTransport, providerRequestLimit } from '../src/services/connectors/policyTransport'

function safetyStore(used = 1, circuitOpen = false) {
  return {
    get: vi.fn(async () => circuitOpen ? '1' : null),
    executeLua: vi.fn(async (script: string) => script.includes('PTTL') ? [used, 30_000] : 1),
    del: vi.fn(async () => 1),
  }
}

describe('provider safety transport', () => {
  it('uses conservative per-connection provider budgets', () => {
    expect(providerRequestLimit('ghl')).toBe(90)
    expect(providerRequestLimit('klaviyo')).toBe(60)
  })

  it('blocks before making a request when the distributed budget is exhausted', async () => {
    const inner = { request: vi.fn() }
    const transport = new PolicyConnectorTransport(inner as any, { organizationId: 'org', connectionId: 'connection', provider: 'ghl' }, safetyStore(91) as any)
    await expect(transport.request({ method: 'POST', url: 'https://example.com' })).rejects.toMatchObject({ status: 429 })
    expect(inner.request).not.toHaveBeenCalled()
  })

  it('fails external writes closed when the safety store is unavailable', async () => {
    const store = safetyStore(); store.get.mockRejectedValueOnce(new Error('redis down'))
    const transport = new PolicyConnectorTransport({ request: vi.fn() } as any, { organizationId: 'org', connectionId: 'connection', provider: 'hubspot' }, store as any)
    await expect(transport.request({ method: 'PATCH', url: 'https://example.com' })).rejects.toBeInstanceOf(HttpError)
  })

  it('opens requests fail-closed while a circuit is active', async () => {
    const transport = new PolicyConnectorTransport({ request: vi.fn() } as any, { organizationId: 'org', connectionId: 'connection', provider: 'google' }, safetyStore(1, true) as any)
    await expect(transport.request({ method: 'GET', url: 'https://example.com' })).rejects.toMatchObject({ status: 503 })
  })
})
