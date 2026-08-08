import { NextFunction, Request, Response } from 'express'
import { Types } from 'mongoose'
import { ACCESS_COOKIE, readCookie } from '../auth/cookies'
import { verifyAccessToken } from '../auth/jwt'
import Organization from '../models/Organization'
import Session from '../models/Session'
import User from '../models/User'
import { sendProblem, problemType} from '../http/problem'
import { noteSupportGrantUse, resolveAccess } from '../services/hierarchy/access'

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
    let accessVia: 'membership' | 'agency' | 'support_grant' | 'corporate' | undefined
    let accessExpiresAt: Date | null = null
    if (requestedOrganization) {
      if (!Types.ObjectId.isValid(requestedOrganization)) {
        sendProblem(req, res, { status: 400, title: 'Invalid organization', detail: 'Organization identifier is invalid', type: problemType('invalid-organization') })
        return
      }
      const organization = await Organization.findOne({ _id: requestedOrganization, status: 'active' }).select('_id').lean()
      if (!organization) {
        sendProblem(req, res, { status: 403, title: 'Organization access denied', detail: 'No access to this organization', type: problemType('organization-access-denied') })
        return
      }
      /**
       * Authority is RESOLVED, not assumed from a membership row.
       *
       * This used to require a direct Membership, which is why switching into
       * an agency's client or a support grant never worked: `/hierarchy/switch`
       * would confirm access and then every following request would be refused
       * here. `resolveAccess` checks membership FIRST and only then considers
       * agency, corporate and support authority, so a direct member's role is
       * unchanged and nothing is widened for them.
       *
       * What is not relaxed: the request still carries exactly ONE
       * organizationId, and every downstream query is scoped to it identically
       * to a member's. Resolution decides whether you may act here, never how
       * many tenants you may read.
       */
      const access = await resolveAccess({ userId: claims.sub, organizationId: requestedOrganization })
      if (!access.granted) {
        sendProblem(req, res, { status: 403, title: 'Organization access denied', detail: 'No access to this organization', type: problemType('organization-access-denied') })
        return
      }
      role = access.role as typeof role
      accessVia = access.via
      accessExpiresAt = access.expiresAt ?? null

      // A grant is metered per request, not per sign-in, so the customer's
      // "what did support actually do" is a count they can weigh against the
      // reason they were given.
      if (access.via === 'support_grant') {
        await noteSupportGrantUse({ userId: claims.sub, organizationId: requestedOrganization }).catch(() => undefined)
      }
    }
    req.auth = {
      userId: claims.sub,
      sessionId: claims.sid,
      organizationId: requestedOrganization,
      role,
      platformRole: (user.platformRole || 'user') as 'user' | 'support' | 'admin' | 'owner',
      mfaEnabled: Boolean(user.mfaEnabled),
      accessVia,
      accessExpiresAt,
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
