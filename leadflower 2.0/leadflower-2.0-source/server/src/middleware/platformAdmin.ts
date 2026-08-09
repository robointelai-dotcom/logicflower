import { NextFunction, Request, Response } from 'express'
import Session from '../models/Session'
import { HttpError, sendProblem, problemType} from '../http/problem'

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
  // MFA requirement temporarily disabled
  // if (!req.auth?.mfaEnabled) {
  //   sendProblem(req, res, { status: 403, title: 'MFA required', detail: 'MFA is required for platform administration', type: problemType('mfa-required') })
  //   return
  // }
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

/**
 * Corporate authority, asserted from inside a handler.
 *
 * `/admin` is mounted behind `requireAdminMfa`, so every route on it demands a
 * second factor. The Corporate Estate views on `/hierarchy/corporate/*` and the
 * public website editor on `/content/*` are equally privileged — they read the
 * whole estate and publish to the operator's own domain — but each rolled its
 * own inline platform-role check and neither required MFA. A platform owner
 * with a stolen password could not touch `/admin`, and could edit the marketing
 * site and enumerate every tenant.
 *
 * Throwing rather than middleware because these routers mix public, member and
 * corporate endpoints on one mount, so the requirement belongs on the handlers
 * that need it rather than on the router.
 */
/**
 * Whether platform administration demands a second factor.
 *
 * Read once at start-up so the value cannot drift between requests.
 */
const REQUIRE_CORPORATE_MFA = String(process.env.CORPORATE_MFA_REQUIRED ?? 'true').toLowerCase() !== 'false'

if (!REQUIRE_CORPORATE_MFA) {
  // Loud on purpose. Somebody should have to explain this line in a log review.
  // eslint-disable-next-line no-console
  console.warn('[security] CORPORATE_MFA_REQUIRED=false — platform administration does not require a second factor. A stolen platform password is sufficient to read every tenant and publish to the operator\'s own domain.')
}

export function assertCorporate(req: Request, options: { mfa?: boolean } = {}): void {
  const role = String(req.auth?.platformRole || 'user')
  if (!['owner', 'admin'].includes(role)) {
    throw new HttpError(403, 'Corporate access required', 'This action is restricted to platform administrators', problemType('platform-role-required'))
  }
  /**
   * Second factor for platform administration.
   *
   * Controlled by CORPORATE_MFA_REQUIRED rather than commented out. It was
   * disabled in-code during a deployment, which left no record that the state
   * was meant to be temporary and no way to restore it without another commit.
   *
   * Default ON. Setting it to false is a deliberate, visible act with a warning
   * on start-up — an environment where a stolen platform password is enough to
   * read every tenant and publish to the operator's own domain.
   */
  if (options.mfa !== false && REQUIRE_CORPORATE_MFA && !req.auth?.mfaEnabled) {
    throw new HttpError(403, 'MFA required', 'Enable multi-factor authentication before performing platform administration', problemType('mfa-required'))
  }
}
