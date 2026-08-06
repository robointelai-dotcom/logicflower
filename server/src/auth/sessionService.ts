import { Request, Response } from 'express'
import { Types } from 'mongoose'
import { env } from '../env'
import Session from '../models/Session'
import { signAccessToken } from './jwt'
import { setSessionCookies } from './cookies'
import { hashOpaqueToken, randomToken, timingSafeEqualString } from '../security/tokens'

export interface IssuedSession {
  sessionId: string
  expiresAt: Date
}
export type RotationResult = IssuedSession | { stale: true }

function requestDetails(req: Request): { ipAddress?: string; userAgent?: string } {
  return {
    ipAddress: req.ip || req.socket.remoteAddress,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 512) || undefined,
  }
}

function rawRefreshToken(sessionId: string): string {
  return `${sessionId}.${randomToken(48)}`
}

export async function createSession(input: {
  userId: string
  organizationId?: string
  req: Request
  res: Response
}): Promise<IssuedSession> {
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000)
  const session = new Session({
    _id: new Types.ObjectId(),
    userId: input.userId,
    currentOrganizationId: input.organizationId,
    expiresAt,
    ...requestDetails(input.req),
    refreshTokenHash: 'pending',
  })
  const refreshToken = rawRefreshToken(String(session._id))
  session.refreshTokenHash = hashOpaqueToken(refreshToken)
  await session.save()
  const accessToken = signAccessToken({
    userId: input.userId,
    sessionId: String(session._id),
    organizationId: input.organizationId,
  })
  setSessionCookies(input.res, accessToken, refreshToken)
  return { sessionId: String(session._id), expiresAt }
}

export async function rotateSession(input: {
  rawRefreshToken: string
  req: Request
  res: Response
}): Promise<RotationResult | null> {
  const [sessionId] = input.rawRefreshToken.split('.', 1)
  if (!sessionId || !Types.ObjectId.isValid(sessionId)) return null
  const session: any = await Session.findById(sessionId).select('+refreshTokenHash +previousRefreshTokenHash +previousRefreshValidUntil')
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null
  const suppliedHash = hashOpaqueToken(input.rawRefreshToken)
  if (!timingSafeEqualString(suppliedHash, String(session.refreshTokenHash))) {
    if (session.previousRefreshTokenHash && session.previousRefreshValidUntil > new Date() &&
        timingSafeEqualString(suppliedHash, String(session.previousRefreshTokenHash))) {
      return { stale: true }
    }
    await Session.updateOne({ _id: session._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: 'refresh_token_reuse' } })
    return null
  }

  const refreshToken = rawRefreshToken(String(session._id))
  const nextHash = hashOpaqueToken(refreshToken)
  const rotated = await Session.findOneAndUpdate({
    _id: session._id,
    refreshTokenHash: suppliedHash,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }, {
    $set: {
      refreshTokenHash: nextHash,
      previousRefreshTokenHash: suppliedHash,
      previousRefreshValidUntil: new Date(Date.now() + 10_000),
      lastUsedAt: new Date(),
      ...requestDetails(input.req),
    },
  }, { new: true }).select('+refreshTokenHash')
  if (!rotated) {
    const latest: any = await Session.findById(session._id).select('+previousRefreshTokenHash +previousRefreshValidUntil')
    if (latest?.previousRefreshTokenHash && latest.previousRefreshValidUntil > new Date() &&
        timingSafeEqualString(suppliedHash, String(latest.previousRefreshTokenHash))) {
      return { stale: true }
    }
    await Session.updateOne({ _id: session._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: 'refresh_token_reuse' } })
    return null
  }
  const organizationId = rotated.currentOrganizationId ? String(rotated.currentOrganizationId) : undefined
  const accessToken = signAccessToken({
    userId: String(rotated.userId),
    sessionId: String(rotated._id),
    organizationId,
  })
  setSessionCookies(input.res, accessToken, refreshToken)
  return { sessionId: String(rotated._id), expiresAt: rotated.expiresAt }
}

export async function switchSessionOrganization(input: {
  sessionId: string
  userId: string
  organizationId: string
  res: Response
}): Promise<void> {
  const session = await Session.findOneAndUpdate(
    { _id: input.sessionId, userId: input.userId, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { currentOrganizationId: input.organizationId, lastUsedAt: new Date() } },
    { new: true },
  ).select('+refreshTokenHash')
  if (!session) throw new Error('Session is no longer active')
  const accessToken = signAccessToken({
    userId: input.userId,
    sessionId: input.sessionId,
    organizationId: input.organizationId,
  })
  input.res.cookie('lf_access', accessToken, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN,
    path: '/',
    maxAge: env.ACCESS_TOKEN_TTL_SECONDS * 1_000,
  })
}

export async function revokeSession(sessionId: string, reason = 'logout'): Promise<void> {
  await Session.updateOne(
    { _id: sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: reason } },
  )
}

export async function revokeAllUserSessions(userId: string, reason: string): Promise<void> {
  await Session.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: reason } },
  )
}
