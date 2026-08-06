import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ recoveryHashes: new Set<string>(), ownerCount: 2, usedCodes: [] as Array<{ hash: string; usedAt: Date }> }))

const UserMock = vi.hoisted(() => ({
  updateOne: vi.fn(async (query: any, update: any) => {
    if (query.mfaUsedCodes) {
      // Models the $not/$elemMatch filter: the write only matches when no
      // unexpired ring entry already carries this hash.
      const candidate = update.$push.mfaUsedCodes.$each[0]
      const cutoff = query.mfaUsedCodes.$not.$elemMatch.usedAt.$gt
      const alreadyUsed = state.usedCodes.some((entry) => entry.hash === candidate.hash && entry.usedAt > cutoff)
      if (alreadyUsed) return { modifiedCount: 0 }
      state.usedCodes.push(candidate)
      state.usedCodes = state.usedCodes.slice(-12)
      return { modifiedCount: 1 }
    }
    const hash = query.mfaRecoveryCodeHashes
    if (!state.recoveryHashes.has(hash)) return { modifiedCount: 0 }
    state.recoveryHashes.delete(update.$pull.mfaRecoveryCodeHashes)
    return { modifiedCount: 1 }
  }),
}))
const OrganizationMock = vi.hoisted(() => ({
  updateOne: vi.fn(async (query: any, update: any) => {
    if (query.ownerCount?.$gt != null && !(state.ownerCount > query.ownerCount.$gt)) return { modifiedCount: 0 }
    state.ownerCount += Number(update.$inc?.ownerCount || 0)
    return { modifiedCount: 1 }
  }),
}))

vi.mock('../src/models/User', () => ({ default: UserMock }))
vi.mock('../src/models/Organization', () => ({ default: OrganizationMock }))

describe('security-sensitive atomic invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.recoveryHashes.clear()
    state.ownerCount = 2
    state.usedCodes = []
  })

  it('allows a recovery code to be consumed only once across concurrent attempts', async () => {
    const { consumeRecoveryCode, recoveryCodeHash } = await import('../src/auth/mfa')
    state.recoveryHashes.add(recoveryCodeHash('RECOVERY-ONE'))
    const results = await Promise.all([
      consumeRecoveryCode('507f1f77bcf86cd799439011', 'RECOVERY-ONE'),
      consumeRecoveryCode('507f1f77bcf86cd799439011', 'RECOVERY-ONE'),
    ])
    expect(results.sort()).toEqual([false, true])
    expect(state.recoveryHashes.size).toBe(0)
  })

  it('rejects replay of the same authenticator code across parallel challenges', async () => {
    const { consumeTotpCode } = await import('../src/auth/mfa')
    const results = await Promise.all([
      consumeTotpCode('507f1f77bcf86cd799439011', '123456'),
      consumeTotpCode('507f1f77bcf86cd799439011', '123456'),
    ])
    expect(results.sort()).toEqual([false, true])
  })

  it('rejects an earlier code after a later one has been used', async () => {
    // The gap the single-slot design left open: authenticate with code A, then
    // code B, and A becomes replayable because it is no longer the value being
    // compared against. A rolling ring keeps A rejected for its whole window.
    const { consumeTotpCode } = await import('../src/auth/mfa')
    expect(await consumeTotpCode('507f1f77bcf86cd799439011', '111111')).toBe(true)
    expect(await consumeTotpCode('507f1f77bcf86cd799439011', '222222')).toBe(true)
    expect(await consumeTotpCode('507f1f77bcf86cd799439011', '111111')).toBe(false)
  })

  it('allows a code to be reused once it has aged beyond the replay window', async () => {
    const { consumeTotpCode, TOTP_REPLAY_WINDOW_MS } = await import('../src/auth/mfa')
    const start = Date.now()
    expect(await consumeTotpCode('507f1f77bcf86cd799439011', '333333', start)).toBe(true)
    expect(await consumeTotpCode('507f1f77bcf86cd799439011', '333333', start + 1_000)).toBe(false)
    expect(await consumeTotpCode('507f1f77bcf86cd799439011', '333333', start + TOTP_REPLAY_WINDOW_MS + 1_000)).toBe(true)
  })

  it('never reserves removal of the final organization owner', async () => {
    const { reserveOwnerRemoval } = await import('../src/services/organizationOwnership')
    const results = await Promise.all([
      reserveOwnerRemoval('507f1f77bcf86cd799439012'),
      reserveOwnerRemoval('507f1f77bcf86cd799439012'),
    ])
    expect(results.sort()).toEqual([false, true])
    expect(state.ownerCount).toBe(1)
  })
})
