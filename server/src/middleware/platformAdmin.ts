import { NextFunction, Request, Response } from 'express'
import Session from '../models/Session'
import { sendProblem, problemType} from '../http/problem'

export function requirePlatformRole(...roles: Array<'support' | 'admin' | 'owner'>) {
  const allowed = new Set(roles)
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth || !allowed.has(req.auth.platformRole as any)) {
      sendProblem(req, res, { status: 403, title: 'Platform role required', detail: 'Platform administrator access is required', type: problemType('platform-role-required') })
      return
    }
    next()
  }
}

export function requireAdminMfa(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth?.mfaEnabled) {
    sendProblem(req, res, { status: 403, title: 'MFA required', detail: 'MFA is required for platform administration', type: problemType('mfa-required') })
    return
  }
  next()
}

export async function requireRecentAuthentication(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await Session.findOne({ _id: req.auth?.sessionId, userId: req.auth?.userId, revokedAt: null })
      .select('authenticatedAt').lean()
    if (!session?.authenticatedAt || Date.now() - new Date(session.authenticatedAt).getTime() > 15 * 60_000) {
      sendProblem(req, res, { status: 403, title: 'Recent authentication required', detail: 'Sign in again before performing this administrative action', type: problemType('recent-auth-required') })
      return
    }
    next()
  } catch (error) { next(error) }
}
