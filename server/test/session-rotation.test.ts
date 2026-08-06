import { beforeEach, describe, expect, it, vi } from 'vitest'

const sessionId = '507f191e810c19729de860ea'
const userId = '507f1f77bcf86cd799439011'
let state: any

const SessionMock: any = {
  findById: vi.fn((id: string) => ({
    select: vi.fn(async () => id === sessionId ? { ...state } : null),
  })),
  findOneAndUpdate: vi.fn((query: any, update: any) => ({
    select: vi.fn(async () => {
      if (query._id !== sessionId || query.refreshTokenHash !== state.refreshTokenHash || state.revokedAt) return null
      state = { ...state, ...update.$set }
      return { ...state }
    }),
  })),
  updateOne: vi.fn(async (_query: any, update: any) => {
    state = { ...state, ...update.$set }
    return { modifiedCount: 1 }
  }),
}

vi.mock('../src/models/Session', () => ({ default: SessionMock }))

describe('refresh-token rotation', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { hashOpaqueToken } = await import('../src/security/tokens')
    state = {
      _id: sessionId,
      userId,
      refreshTokenHash: hashOpaqueToken(`${sessionId}.old-refresh-secret`),
      currentOrganizationId: '507f1f77bcf86cd799439012',
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
    }
  })

  it('rotates with compare-and-swap and treats an immediate loser as stale without revocation', async () => {
    const { rotateSession } = await import('../src/auth/sessionService')
    const request: any = { ip: '203.0.113.9', socket: {}, headers: { 'user-agent': 'test' } }
    const firstResponse: any = { cookie: vi.fn() }
    const secondResponse: any = { cookie: vi.fn() }
    const oldToken = `${sessionId}.old-refresh-secret`

    const first = await rotateSession({ rawRefreshToken: oldToken, req: request, res: firstResponse })
    const second = await rotateSession({ rawRefreshToken: oldToken, req: request, res: secondResponse })

    expect(first && 'sessionId' in first).toBe(true)
    expect(second).toEqual({ stale: true })
    expect(state.revokedAt).toBeNull()
    expect(firstResponse.cookie).toHaveBeenCalled()
    expect(secondResponse.cookie).not.toHaveBeenCalled()
  })
})
