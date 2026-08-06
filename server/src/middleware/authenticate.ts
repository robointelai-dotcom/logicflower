import { NextFunction, Request, Response } from 'express'
import { Types } from 'mongoose'
import { ACCESS_COOKIE, readCookie } from '../auth/cookies'
import { verifyAccessToken } from '../auth/jwt'
import Membership from '../models/Membership'
import Organization from '../models/Organization'
import Session from '../models/Session'
import User from '../models/User'
import { sendProblem, problemType} from '../http/problem'

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return undefined
  return header.slice(7).trim()
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req) || readCookie(req, ACCESS_COOKIE)
  if (!token) {
    sendProblem(req, res, { status: 401, title: 'Authentication required', detail: 'Authentication required', type: problemType('auth-required') })
    return
  }
  let claims: ReturnType<typeof verifyAccessToken>
  try {
    claims = verifyAccessToken(token)
    if (!Types.ObjectId.isValid(claims.sub) || !Types.ObjectId.isValid(claims.sid)) throw new Error('Invalid token identifiers')
  } catch {
    sendProblem(req, res, { status: 401, title: 'Invalid session', detail: 'Session is invalid or expired', type: problemType('invalid-session') })
    return
  }
  try {
    const [session, user] = await Promise.all([
      Session.findOne({
        _id: claims.sid,
        userId: claims.sub,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      }).lean(),
      User.findOne({ _id: claims.sub, status: 'active' }).select('_id platformRole mfaEnabled').lean(),
    ])
    if (!session || !user) {
      sendProblem(req, res, { status: 401, title: 'Invalid session', detail: 'Session is invalid or expired', type: problemType('invalid-session') })
      return
    }

    const requestedOrganization = String(req.headers['x-organization-id'] || claims.org || '').trim() || undefined
    let role: import('../models/Membership').MembershipRole | undefined
    if (requestedOrganization) {
      if (!Types.ObjectId.isValid(requestedOrganization)) {
        sendProblem(req, res, { status: 400, title: 'Invalid organization', detail: 'Organization identifier is invalid', type: problemType('invalid-organization') })
        return
      }
      const [membership, organization] = await Promise.all([
        Membership.findOne({ organizationId: requestedOrganization, userId: claims.sub, status: 'active' }).lean(),
        Organization.findOne({ _id: requestedOrganization, status: 'active' }).select('_id').lean(),
      ])
      if (!membership || !organization) {
        sendProblem(req, res, { status: 403, title: 'Organization access denied', detail: 'No active membership for this organization', type: problemType('organization-access-denied') })
        return
      }
      role = membership.role as typeof role
    }
    req.auth = {
      userId: claims.sub,
      sessionId: claims.sid,
      organizationId: requestedOrganization,
      role,
      platformRole: (user.platformRole || 'user') as 'user' | 'support' | 'admin' | 'owner',
      mfaEnabled: Boolean(user.mfaEnabled),
    }
    next()
  } catch (error) {
    next(error)
  }
}

export async function optionalAuthentication(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req) || readCookie(req, ACCESS_COOKIE)
  if (!token) return next()
  return authenticate(req, _res, next)
}
