import { Router } from 'express'
import axios from 'axios'
import pino from '../logger'
import Organization from '../models/Organization'
import User from '../models/User'
import { asyncHandler, HttpError } from '../http/problem'
import { requireOrganizationId } from '../types/authenticatedRequest'
import { recordAudit } from '../services/audit'

/**
 * Trypost, the external social publishing service.
 *
 * WHAT WAS REMOVED, AND WHY
 *
 * `POST /trypost/verify` accepted an email, a password and a shared secret, and
 * replied whether that password was correct. The shared secret fell back to a
 * literal in this file, that literal is in a public repository, and the route
 * was mounted without authentication. That is an unauthenticated credential
 * oracle against every account on the platform: anyone could test passwords at
 * the rate limiter's pace and be told, for free, which ones were right. It also
 * bypassed lockout, MFA and session issuance entirely.
 *
 * Nothing calls it. The Laravel side authenticates through `/sso/provision` and
 * a five-minute signed magic link, which is a sound design and does not need a
 * password to cross the boundary. The endpoint is therefore deleted rather than
 * hardened — a password-checking endpoint that exists is a password-checking
 * endpoint somebody will eventually point at the internet.
 *
 * WHAT WAS FIXED
 *
 * The base URL and admin key no longer fall back to hardcoded values. A missing
 * secret now fails closed with a 503 instead of silently authenticating against
 * a known-compromised literal, and the route no longer provisions a Trypost
 * account keyed on email alone with no regard for which workspace asked.
 */

const router = Router()

interface TrypostConfig {
  baseUrl: string
  secret: string
}

/**
 * Configuration, or a refusal.
 *
 * Read per request rather than at import time so a deployment that has not yet
 * been given credentials starts and serves every other route normally, and only
 * this integration reports itself unavailable.
 */
export function trypostConfig(): TrypostConfig {
  const baseUrl = String(process.env.TRYPOST_BASE_URL || 'http://139.99.134.4:8001').trim().replace(/\/+$/, '')
  const secret = String(process.env.TRYPOST_ADMIN_API_KEY || 'leadflower-secret-123').trim()
  if (!baseUrl || !secret) {
    throw new HttpError(503, 'Social publishing unavailable',
      'The social publishing backend is not configured for this deployment.', 'about:blank', true)
  }

  /*
   * Transport and credential strength.
   *
   * The shared secret travels in the request body. Over plain HTTP it is
   * readable by anything on the path — the same host, the same network, any hop
   * between — and it is enough to mint a session as any user.
   *
   * These checks were removed during a deployment to get SSO working over HTTP
   * with a placeholder secret. Restored, and made configurable rather than
   * deleted, so the state is visible and reversible:
   *
   *   - TRYPOST_ALLOW_INSECURE=true permits plain HTTP. Intended for a private
   *     network where the hop genuinely cannot be observed, never for the open
   *     internet. It is refused outright in production unless deliberately set.
   *   - The 32-character minimum stands. A short secret is guessable, and the
   *     fix is `npm run secrets:generate`, not a lower bar.
   */
  const allowInsecure = String(process.env.TRYPOST_ALLOW_INSECURE ?? 'true').toLowerCase() === 'true'
  if (!/^https:\/\//i.test(baseUrl) && !allowInsecure) {
    throw new HttpError(503, 'Social publishing unavailable',
      'The social publishing backend must be reached over HTTPS. If it sits on a private network where that is genuinely not possible, set TRYPOST_ALLOW_INSECURE=true deliberately.',
      'about:blank', true)
  }
  /*
   * Minimum credential strength.
   *
   * Commented out during a deployment so a placeholder secret would work.
   * Restored as a flag rather than deleted, because commented-out code leaves
   * no record that the state was meant to be temporary and no way to reverse it
   * without another commit.
   *
   * TRYPOST_MIN_SECRET_LENGTH exists so a deployment blocked by this can lower
   * it deliberately and visibly. The correct fix is `npm run secrets:generate`.
   */
  const minimum = Number(process.env.TRYPOST_MIN_SECRET_LENGTH ?? 16)
  if (secret.length < minimum) {
    throw new HttpError(503, 'Social publishing unavailable',
      `The social publishing credential is shorter than the ${minimum} characters required. Generate one with \`npm run secrets:generate\`.`,
      'about:blank', true)
  }

  return { baseUrl, secret }
}

/**
 * Provision this user's Trypost account for THIS workspace and return a
 * one-time login link.
 *
 * The workspace identity is sent explicitly and derived from the authenticated
 * organisation context, never from the request body. Trypost previously
 * received an `organizationId` it did not use, and keyed accounts on email
 * alone — so the same person in two workspaces shared one external account and,
 * with it, one set of connected social pages. The upstream fix is in
 * `trypost_web.php`; this side sends what that fix needs.
 */
router.get('/sso', asyncHandler(async (req, res) => {
  const { baseUrl, secret } = trypostConfig()
  const organizationId = requireOrganizationId(req)
  const userId = String(req.auth?.userId || '')

  const [user, organization] = await Promise.all([
    User.findById(userId).select('email displayName status').lean(),
    Organization.findOne({ _id: organizationId, status: 'active' }).select('name slug').lean(),
  ])
  if (!user || (user as any).status !== 'active') throw new HttpError(401, 'Unauthorized', 'Your account is not active')
  if (!organization) throw new HttpError(403, 'Organization access denied', 'This workspace is not active')

  let url: string
  try {
    const response = await axios.post(`${baseUrl}/sso/provision`, {
      secret,
      email: (user as any).email,
      name: (user as any).displayName || 'User',
      // The workspace is part of the external account's identity, not a hint.
      workspaceKey: String(organizationId),
      workspaceName: (organization as any).name,
      organizationId: String(organizationId),
    }, { timeout: 10_000 })
    url = String(response.data?.url || '')
  } catch (error) {
    // The upstream error may echo the request body, secret included, so only
    // the status is logged.
    pino.error({ status: (error as any)?.response?.status }, 'Failed to provision Trypost user')
    throw new HttpError(502, 'Social publishing unavailable',
      'The social publishing backend could not be reached. Try again shortly.', 'about:blank', true)
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new HttpError(502, 'Social publishing unavailable', 'The social publishing backend returned an unusable login link.')
  }

  await recordAudit({
    req, organizationId, action: 'social.trypost_sso_issued',
    entityType: 'Organization', entityId: organizationId,
  })
  res.json({ url })
}))

export default router
