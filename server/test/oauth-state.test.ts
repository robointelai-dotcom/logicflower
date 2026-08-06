import { beforeEach, describe, expect, it, vi } from 'vitest'

const oauthStateModel = vi.hoisted(() => ({
  create: vi.fn(),
  findOneAndUpdate: vi.fn(),
}))

vi.mock('../src/models/OAuthState', () => ({ default: oauthStateModel }))
vi.mock('../src/security/tokens', async () => {
  const crypto = await import('crypto')
  return {
    randomToken: () => 'oauth-state-token-with-sufficient-length',
    hashOpaqueToken: (value: string) => crypto.createHash('sha256').update(value).digest('hex'),
  }
})

import { createOAuthState, consumeOAuthState } from '../src/services/oauthState'

describe('OAuth state connection binding', () => {
  beforeEach(() => vi.clearAllMocks())

  it('binds a reconnect target and returns it only from the consumed one-time state', async () => {
    const organizationId = '507f1f77bcf86cd799439011'
    const userId = '507f1f77bcf86cd799439012'
    const connectionId = '507f1f77bcf86cd799439013'
    oauthStateModel.create.mockResolvedValue({})

    const created = await createOAuthState({
      organizationId,
      userId,
      connectionId,
      provider: 'hubspot',
      codeVerifier: 'pkce-verifier-value',
      redirectTo: '/connections?connected=true',
    })
    expect(created.state).toBe('oauth-state-token-with-sufficient-length')
    expect(oauthStateModel.create).toHaveBeenCalledWith(expect.objectContaining({
      organizationId,
      userId,
      connectionId,
      provider: 'hubspot',
    }))

    const persisted = oauthStateModel.create.mock.calls[0]![0]
    oauthStateModel.findOneAndUpdate.mockReturnValue({
      select: vi.fn().mockResolvedValue({
        organizationId,
        userId,
        connectionId,
        redirectTo: '/connections?connected=true',
        codeVerifierEncrypted: persisted.codeVerifierEncrypted,
      }),
    })
    const consumed = await consumeOAuthState({ state: created.state, provider: 'hubspot' })
    expect(consumed).toEqual({
      organizationId,
      userId,
      connectionId,
      codeVerifier: 'pkce-verifier-value',
      redirectTo: '/connections?connected=true',
    })
    expect(oauthStateModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'hubspot', usedAt: null }),
      { $set: { usedAt: expect.any(Date) } },
      { new: true },
    )
  })

  it('rejects cross-origin and protocol-relative post-OAuth redirects', async () => {
    for (const redirectTo of ['https://evil.example/callback', '//evil.example/callback', '/\\evil.example']) {
      await expect(createOAuthState({
        organizationId: '507f1f77bcf86cd799439011',
        userId: '507f1f77bcf86cd799439012',
        provider: 'google',
        redirectTo,
      })).rejects.toThrow(/same-origin/)
    }
    expect(oauthStateModel.create).not.toHaveBeenCalled()
  })
})
