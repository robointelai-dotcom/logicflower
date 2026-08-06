import OAuthState from '../models/OAuthState'
import { PlatformProvider } from '../models/PlatformConnection'
import { encryptString, decryptString } from '../security/encryption'
import { hashOpaqueToken, randomToken } from '../security/tokens'

export async function createOAuthState(input: {
  organizationId: string
  userId: string
  provider: PlatformProvider
  connectionId?: string
  codeVerifier?: string
  redirectTo?: string
}): Promise<{ state: string; expiresAt: Date }> {
  if (input.redirectTo && (!input.redirectTo.startsWith('/') || input.redirectTo.startsWith('//') || input.redirectTo.includes('\\'))) {
    throw new Error('OAuth redirectTo must be a same-origin relative path')
  }
  const state = randomToken(32)
  const expiresAt = new Date(Date.now() + 10 * 60_000)
  await OAuthState.create({
    organizationId: input.organizationId,
    userId: input.userId,
    connectionId: input.connectionId,
    provider: input.provider,
    stateHash: hashOpaqueToken(state),
    codeVerifierEncrypted: input.codeVerifier
      ? encryptString(input.codeVerifier, `oauth-state:${input.organizationId}:${input.provider}`)
      : undefined,
    redirectTo: input.redirectTo,
    expiresAt,
  })
  return { state, expiresAt }
}

export async function consumeOAuthState(input: {
  state: string
  provider: PlatformProvider
}): Promise<{
  organizationId: string
  userId: string
  connectionId?: string
  codeVerifier?: string
  redirectTo?: string
}> {
  // tenant-safe: single-use OAuth state token is the identifier; the organisation is bound inside the record and verified on consumption
  const row = await OAuthState.findOneAndUpdate({
    stateHash: hashOpaqueToken(input.state),
    provider: input.provider,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }, {
    $set: { usedAt: new Date() },
  }, { new: true }).select('+codeVerifierEncrypted')
  if (!row) throw new Error('OAuth state is invalid, expired, or already used')
  const organizationId = String(row.organizationId)
  return {
    organizationId,
    userId: String(row.userId),
    connectionId: row.connectionId ? String(row.connectionId) : undefined,
    codeVerifier: row.codeVerifierEncrypted
      ? decryptString(String(row.codeVerifierEncrypted), `oauth-state:${organizationId}:${input.provider}`)
      : undefined,
    redirectTo: row.redirectTo || undefined,
  }
}
