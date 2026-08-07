import { Types } from 'mongoose'
import PlatformConnection, { PlatformProvider } from '../models/PlatformConnection'
import { decryptJson, encryptJson } from '../security/encryption'
import { claimConnectionCapacity, releaseUnpersistedConnectionClaim } from './planPolicy'

export interface ConnectionCredential {
  accessToken?: string
  refreshToken?: string
  apiKey?: string
  baseUrl?: string
  locationId?: string
  expiresAt?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface ResolvedConnectionCredential extends ConnectionCredential {
  connectionId: string
  organizationId: string
  provider: PlatformProvider
  credentialVersion: number
}

function aad(organizationId: string, provider: PlatformProvider, connectionId: string): string {
  return `platform-connection:${organizationId}:${provider}:${connectionId}`
}

function assertIdentifiers(organizationId: string, connectionId?: string): void {
  if (!Types.ObjectId.isValid(organizationId)) throw new Error('Invalid organizationId')
  if (connectionId && !Types.ObjectId.isValid(connectionId)) throw new Error('Invalid connectionId')
}

export async function getConnectionCredential(input: {
  organizationId: string
  provider: PlatformProvider
  connectionId?: string
  allowDisconnecting?: boolean
}): Promise<ResolvedConnectionCredential> {
  assertIdentifiers(input.organizationId, input.connectionId)
  const query: Record<string, unknown> = {
    organizationId: input.organizationId,
    provider: input.provider,
    status: input.allowDisconnecting ? { $ne: 'revoked' } : { $in: ['active', 'degraded', 'error'] },
  }
  if (input.connectionId) query._id = input.connectionId
  const row = await PlatformConnection.findOne(query).select('+encryptedCredentials +credentialVersion')
  if (!row) throw new Error('Platform connection not found')
  const connectionId = String(row._id)
  const credential = decryptJson<ConnectionCredential>(
    String(row.encryptedCredentials),
    aad(input.organizationId, input.provider, connectionId),
  )
  return {
    ...credential,
    connectionId,
    organizationId: input.organizationId,
    provider: input.provider,
    credentialVersion: Number(row.credentialVersion || 1),
  }
}

export async function updateConnectionCredential(input: {
  organizationId: string
  connectionId: string
  provider: PlatformProvider
  credentials: ConnectionCredential
  merge?: boolean
  tokenExpiresAt?: Date
  status?: 'pending' | 'active' | 'degraded' | 'error'
  expectedVersion?: number
}): Promise<number> {
  assertIdentifiers(input.organizationId, input.connectionId)
  for (let attempt = 0; attempt < 3; attempt++) {
    const row: any = await PlatformConnection.findOne({
      _id: input.connectionId,
      organizationId: input.organizationId,
      provider: input.provider,
      status: { $ne: 'revoked' },
    }).select('+encryptedCredentials +credentialVersion')
    if (!row) throw new Error('Platform connection not found')
    const currentVersion = Number(row.credentialVersion || 1)
    if (input.expectedVersion != null && input.expectedVersion !== currentVersion) {
      throw new Error('Platform credential version conflict')
    }
    let credentials = input.credentials
    if (input.merge !== false) {
      const current = decryptJson<ConnectionCredential>(
        String(row.encryptedCredentials),
        aad(input.organizationId, input.provider, input.connectionId),
      )
      credentials = { ...current, ...input.credentials }
    }
    const update: Record<string, unknown> = {
      encryptedCredentials: encryptJson(credentials, aad(input.organizationId, input.provider, input.connectionId)),
    }
    if (input.tokenExpiresAt) update.tokenExpiresAt = input.tokenExpiresAt
    if (input.status) update.status = input.status
    const changed: any = await PlatformConnection.findOneAndUpdate({
      _id: input.connectionId,
      organizationId: input.organizationId,
      provider: input.provider,
      credentialVersion: currentVersion,
      status: { $ne: 'revoked' },
    }, { $set: update, $inc: { credentialVersion: 1 } }, { new: true }).select('+credentialVersion')
    if (changed) return Number(changed.credentialVersion)
  }
  throw new Error('Platform credential update conflicted repeatedly')
}

export async function acquireCredentialRefreshLease(input: {
  organizationId: string
  connectionId: string
  provider: PlatformProvider
  owner: string
  leaseMs?: number
}): Promise<boolean> {
  const now = new Date()
  const leaseUntil = new Date(Date.now() + Math.max(5_000, Math.min(input.leaseMs || 30_000, 300_000)))
  const row = await PlatformConnection.findOneAndUpdate({
    _id: input.connectionId,
    organizationId: input.organizationId,
    provider: input.provider,
    status: { $ne: 'revoked' },
    $or: [{ refreshLeaseUntil: { $lte: now } }, { refreshLeaseUntil: null }, { refreshLeaseOwner: input.owner }],
  }, { $set: { refreshLeaseOwner: input.owner, refreshLeaseUntil: leaseUntil } }, { new: true })
  return Boolean(row)
}

export async function releaseCredentialRefreshLease(input: {
  organizationId: string
  connectionId: string
  provider: PlatformProvider
  owner: string
}): Promise<void> {
  await PlatformConnection.updateOne({
    _id: input.connectionId,
    organizationId: input.organizationId,
    provider: input.provider,
    refreshLeaseOwner: input.owner,
  }, { $unset: { refreshLeaseOwner: 1, refreshLeaseUntil: 1 } })
}

export async function createPlatformConnection(input: {
  organizationId: string
  provider: PlatformProvider
  name: string
  credentials: ConnectionCredential
  createdBy: string
  externalAccountId?: string
  scopes?: string[]
  grantedScopes?: string[]
  requestedScopes?: string[]
  scopeSource?: 'provider_token_response' | 'live_probe' | 'operator_claimed' | 'requested_not_confirmed'
  scopeObservedAt?: Date
  tokenExpiresAt?: Date
  status?: 'pending' | 'active' | 'degraded' | 'error'
}) {
  assertIdentifiers(input.organizationId)
  await claimConnectionCapacity(input.organizationId)
  const id = new Types.ObjectId()
  try {
    const row = await PlatformConnection.create({
      _id: id,
      organizationId: input.organizationId,
      provider: input.provider,
      name: input.name,
      externalAccountId: input.externalAccountId,
      scopes: input.scopes || [],
      grantedScopes: input.grantedScopes || [],
      requestedScopes: input.requestedScopes || input.scopes || [],
      scopeSource: input.scopeSource || 'requested_not_confirmed',
      scopeObservedAt: input.scopeObservedAt,
      tokenExpiresAt: input.tokenExpiresAt,
      status: input.status || 'active',
      createdBy: input.createdBy,
      encryptedCredentials: encryptJson(
        input.credentials,
        aad(input.organizationId, input.provider, String(id)),
      ),
    })
    return row
  } catch (error) {
    await releaseUnpersistedConnectionClaim(input.organizationId).catch(() => undefined)
    throw error
  }
}

export async function revokePlatformConnection(input: {
  organizationId: string
  connectionId: string
  provider: PlatformProvider
}): Promise<void> {
  assertIdentifiers(input.organizationId, input.connectionId)
  const emptyCredentials = encryptJson(
    {},
    aad(input.organizationId, input.provider, input.connectionId),
  )
  const result = await PlatformConnection.updateOne({
    _id: input.connectionId,
    organizationId: input.organizationId,
    provider: input.provider,
  }, {
    $set: {
      encryptedCredentials: emptyCredentials,
      status: 'revoked',
      tokenExpiresAt: null,
      scopes: [],
    },
  })
  if (!result.matchedCount) throw new Error('Platform connection not found')
}
