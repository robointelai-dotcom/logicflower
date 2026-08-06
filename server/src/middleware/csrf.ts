import { NextFunction, Request, Response } from 'express'
import { CSRF_COOKIE, readCookie } from '../auth/cookies'
import { timingSafeEqualString } from '../security/tokens'
import { problemType } from '../http/problem'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next()
  // Non-browser API clients authenticate with an Authorization header and are not
  // vulnerable to ambient-cookie CSRF.
  if (req.headers.authorization?.startsWith('Bearer ')) return next()
  const cookieToken = readCookie(req, CSRF_COOKIE)
  const headerToken = String(req.headers['x-csrf-token'] || '')
  if (!cookieToken || !headerToken || !timingSafeEqualString(cookieToken, headerToken)) {
    res.status(403).type('application/problem+json').json({
      type: problemType('csrf'),
      title: 'CSRF verification failed',
      status: 403,
      detail: 'The X-CSRF-Token header must match the CSRF cookie',
      correlationId: req.requestId || 'unknown',
      retryable: false,
    })
    return
  }
  next()
}
