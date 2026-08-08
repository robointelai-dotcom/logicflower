import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { authenticator } from 'otplib'
import { env } from '../env'
import User from '../models/User'
import Organization from '../models/Organization'
import Membership from '../models/Membership'
import Subscription from '../models/Subscription'
import PasswordReset from '../models/PasswordReset'
import Session from '../models/Session'
import { authenticate } from '../middleware/authenticate'
import { asyncHandler, HttpError, parseBody, problemType} from '../http/problem'
import { hashPassword, validatePasswordStrength, verifyPassword } from '../security/password'
import { decryptString, encryptString } from '../security/encryption'
import { hashOpaqueToken, randomToken } from '../security/tokens'
import { clearSessionCookies, readCookie, REFRESH_COOKIE } from '../auth/cookies'
import { createSession, revokeSession, rotateSession } from '../auth/sessionService'
import { recordAudit } from '../services/audit'
import { slugify } from '../services/hierarchy/provisioning'
import { sendPasswordResetEmail } from '../services/email'
import pino from '../logger'
import { csrfProtection } from '../middleware/csrf'
import { setCsrfCookie } from '../auth/cookies'
import MfaChallenge from '../models/MfaChallenge'
import { timingSafeEqualString } from '../security/tokens'
import { consumeRecoveryCode, consumeTotpCode, recoveryCodeHash } from '../auth/mfa'
import { withMongoTransaction } from '../dbTransaction'
import { requireIdempotency } from '../middleware/idempotency'
import DataLifecycleRequest from '../models/DataLifecycleRequest'
import { serializeLifecycleRequest } from '../services/dataLifecycle'
import { evaluateLockout } from '../auth/lockout'

const router = Router()
router.use((req, res, next) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? next() : requireIdempotency(req, res, next))

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
})
const resetLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
})

function strongPasswordSchema() {
  return z.string().superRefine((value, ctx) => {
    for (const message of validatePasswordStrength(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message })
  })
}

const registerSchema = z.object({
  email: z.string().email().max(254).transform((email) => email.trim().toLowerCase()),
  password: strongPasswordSchema(),
  name: z.string().trim().min(2).max(120).refine((value) => !/[\r\n]/.test(value)).optional(),
  displayName: z.string().trim().min(2).max(120).refine((value) => !/[\r\n]/.test(value)).optional(),
  organizationName: z.string().trim().min(2).max(160).refine((value) => !/[\r\n]/.test(value)),
}).strict().refine((value) => value.name || value.displayName, {
  message: 'name is required', path: ['name'],
}).transform((value) => ({ ...value, displayName: value.displayName || value.name! }))

const loginSchema = z.object({
  email: z.string().email().max(254).transform((email) => email.trim().toLowerCase()),
  password: z.string().min(1).max(128),
}).strict()

const forgotSchema = z.object({ email: z.string().email().max(254).transform((email) => email.trim().toLowerCase()) }).strict()
const resetSchema = z.object({ token: z.string().min(32).max(300), password: strongPasswordSchema() }).strict()

async function userResponse(user: any, organizationId?: string) {
  // tenant-safe: scoped to the authenticated user across their own organisations, not to a single organisation
  const memberships = await Membership.find({ userId: user._id, status: 'active' })
    .populate('organizationId', 'name slug status timezone')
    .sort({ createdAt: 1 })
    .lean()
  return {
    user: {
      id: String(user._id),
      email: user.email,
      name: user.displayName,
      displayName: user.displayName,
      mfaEnabled: Boolean(user.mfaEnabled),
      platformRole: user.platformRole || 'user',
      emailVerifiedAt: user.emailVerifiedAt || null,
    },
    currentOrganizationId: organizationId || null,
    memberships: memberships.map((membership: any) => ({
      id: String(membership._id),
      organization: membership.organizationId,
      role: membership.role,
      status: membership.status,
    })),
  }
}

router.get('/mode', (_req, res) => res.json({ mode: 'JWT', registrationEnabled: env.NODE_ENV !== 'production' || env.ALLOW_REGISTRATION }))
router.get('/csrf', (_req, res) => res.json({ csrfToken: setCsrfCookie(res) }))

router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  if (env.NODE_ENV === 'production' && !env.ALLOW_REGISTRATION) {
    throw new HttpError(403, 'Registration disabled', 'Open registration is disabled; ask an organization owner for an invitation')
  }
  const body = parseBody(registerSchema, req)
  if (await User.exists({ email: body.email })) throw new HttpError(409, 'Account already exists', 'An account already exists for this email')
  const passwordHash = await hashPassword(body.password)

  let user: any
  let organization: any
  try {
    user = await User.create({ email: body.email, displayName: body.displayName, passwordHash })
    organization = await Organization.create({
      name: body.organizationName,
      slug: slugify(body.organizationName),
      createdBy: user._id,
    })
    await Promise.all([
      Membership.create({ organizationId: organization._id, userId: user._id, role: 'owner', status: 'active' }),
      Subscription.create({ organizationId: organization._id, plan: 'free', status: 'inactive' }),
    ])
  } catch (error) {
    // Compensate safely if a standalone local Mongo deployment cannot provide transactions.
    if (organization?._id) await Organization.deleteOne({ _id: organization._id, createdBy: user?._id }).catch(() => undefined)
    if (user?._id) await User.deleteOne({ _id: user._id }).catch(() => undefined)
    throw error
  }

  const issued = await createSession({ userId: String(user._id), organizationId: String(organization._id), req, res })
  await recordAudit({ action: 'auth.register', req, organizationId: String(organization._id), actorUserId: String(user._id) })
  res.status(201).json({ ...(await userResponse(user, String(organization._id))), sessionExpiresAt: issued.expiresAt })
}))

router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const body = parseBody(loginSchema, req)
  const user: any = await User.findOne({ email: body.email }).select('+passwordHash +failedLoginCount +lockUntil +mfaSecretEncrypted')
  if (!user || user.status !== 'active') {
    // Perform a bcrypt comparison even for unknown users to reduce account-enumeration timing differences.
    await verifyPassword(body.password, '$2b$12$C6UzMDM.H6dfI/f/IKcEe.8GRZJ4xQ9T1kXXwOe9H8FEQltZ1Z0Oa').catch(() => false)
    throw new HttpError(401, 'Invalid credentials', 'Email, password, or verification code is incorrect')
  }
  const lockState = evaluateLockout({ failedCount: Number(user.failedLoginCount || 0), lockedUntil: user.lockUntil || null })
  if (lockState.locked) {
    throw new HttpError(429, 'Account temporarily locked', 'Too many failed attempts. Try again later', problemType('login-lockout'), true)
  }
  if (lockState.shouldResetCounter) {
    // An expired lock is cleared on the next attempt rather than left in place.
    await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0, lockUntil: null } })
  }
  const validPassword = await verifyPassword(body.password, user.passwordHash)
  if (!validPassword) {
    const failed: any = await User.findOneAndUpdate({ _id: user._id, status: 'active' }, {
      $inc: { failedLoginCount: 1 },
    }, { new: true }).select('+failedLoginCount')
    const afterFailure = evaluateLockout({ failedCount: Number(failed?.failedLoginCount || 0), lockedUntil: null })
    if (afterFailure.locked && afterFailure.lockedUntil) {
      await User.updateOne({ _id: user._id, failedLoginCount: { $gte: env.LOGIN_MAX_FAILURES } }, {
        $set: { failedLoginCount: 0, lockUntil: afterFailure.lockedUntil },
      })
    }
    await recordAudit({ action: 'auth.login_failed', req, actorUserId: String(user._id), metadata: { reason: 'password' } })
    throw new HttpError(401, 'Invalid credentials', 'Email, password, or verification code is incorrect')
  }
  await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0, lockUntil: null } })
  if (user.mfaEnabled) {
    const challengeId = randomToken(32)
    await MfaChallenge.create({
      userId: user._id,
      challengeHash: hashOpaqueToken(challengeId),
      ipHash: hashOpaqueToken(req.ip || req.socket.remoteAddress || 'unknown'),
      expiresAt: new Date(Date.now() + 5 * 60_000),
    })
    res.status(202).json({ mfaRequired: true, challengeId, expiresInSeconds: 300 })
    return
  }
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } })
  // tenant-safe: scoped to the authenticated user; membership lookup is how the organisation is established
  const firstMembership: any = await Membership.findOne({ userId: user._id, status: 'active' }).sort({ createdAt: 1 }).lean()
  const organizationId = firstMembership ? String(firstMembership.organizationId) : undefined
  const issued = await createSession({ userId: String(user._id), organizationId, req, res })
  await recordAudit({ action: 'auth.login', req, organizationId, actorUserId: String(user._id), entityType: 'Session', entityId: issued.sessionId })
  res.json({ ...(await userResponse(user, organizationId)), sessionExpiresAt: issued.expiresAt })
}))

router.post('/refresh', authLimiter, csrfProtection, asyncHandler(async (req, res) => {
  const refreshToken = readCookie(req, REFRESH_COOKIE)
  if (!refreshToken) throw new HttpError(401, 'Refresh required', 'Refresh session is missing or expired')
  const issued = await rotateSession({ rawRefreshToken: refreshToken, req, res })
  if (issued && 'stale' in issued) {
    throw new HttpError(409, 'Refresh already rotated', 'Another request already refreshed this session; retry using the current cookie', problemType('stale-refresh'), true)
  }
  if (!issued) {
    clearSessionCookies(res)
    throw new HttpError(401, 'Refresh failed', 'Refresh session is invalid or expired')
  }
  res.json({ ok: true, sessionExpiresAt: issued.expiresAt })
}))

router.post('/logout', authenticate, csrfProtection, asyncHandler(async (req, res) => {
  await revokeSession(req.auth!.sessionId)
  clearSessionCookies(res)
  await recordAudit({ action: 'auth.logout', req, entityType: 'Session', entityId: req.auth!.sessionId })
  res.status(204).end()
}))

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.auth!.userId, status: 'active' })
  if (!user) throw new HttpError(401, 'Account unavailable', 'The account is no longer active')
  res.json(await userResponse(user, req.auth!.organizationId))
}))

router.get('/session', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.auth!.userId, status: 'active' })
  if (!user) throw new HttpError(401, 'Account unavailable', 'The account is no longer active')
  res.json(await userResponse(user, req.auth!.organizationId))
}))

router.get('/data-requests', authenticate, asyncHandler(async (req, res) => {
  // tenant-safe: scoped to the authenticated user’s own data-subject requests
  const rows: any[] = await DataLifecycleRequest.find({ requestedBy: req.auth!.userId }).sort({ createdAt: -1 }).limit(100).lean()
  res.json({ items: rows.map(serializeLifecycleRequest) })
}))

router.get('/data-requests/:id', authenticate, asyncHandler(async (req, res) => {
  // tenant-safe: scoped to the authenticated user’s own data-subject request
  const row: any = await DataLifecycleRequest.findOne({ _id: req.params.id, requestedBy: req.auth!.userId }).lean()
  if (!row) throw new HttpError(404, 'Data request not found', 'Data lifecycle request not found')
  res.json({ request: serializeLifecycleRequest(row) })
}))

router.patch('/profile', authenticate, csrfProtection, asyncHandler(async (req, res) => {
  const { name } = parseBody(z.object({
    name: z.string().trim().min(2).max(120).refine((value) => !/[\r\n]/.test(value)),
  }).strict(), req)
  const user = await User.findOneAndUpdate({ _id: req.auth!.userId, status: 'active' }, {
    $set: { displayName: name },
  }, { new: true })
  if (!user) throw new HttpError(404, 'Account not found', 'Account not found')
  await recordAudit({ action: 'auth.profile_updated', req })
  res.json((await userResponse(user, req.auth!.organizationId)).user)
}))

router.post('/change-password', authenticate, csrfProtection, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = parseBody(z.object({
    currentPassword: z.string().min(1).max(128),
    newPassword: strongPasswordSchema(),
  }).strict(), req)
  const user: any = await User.findOne({ _id: req.auth!.userId, status: 'active' }).select('+passwordHash')
  if (!user || !await verifyPassword(currentPassword, user.passwordHash)) {
    throw new HttpError(401, 'Reauthentication failed', 'Current password is incorrect')
  }
  user.passwordHash = await hashPassword(newPassword)
  user.passwordChangedAt = new Date()
  await user.save()
  await Session.updateMany({ userId: user._id, _id: { $ne: req.auth!.sessionId }, revokedAt: null }, {
    $set: { revokedAt: new Date(), revokeReason: 'password_changed' },
  })
  await recordAudit({ action: 'auth.password_changed', req })
  res.json({ ok: true })
}))

router.post('/forgot-password', resetLimiter, asyncHandler(async (req, res) => {
  const body = parseBody(forgotSchema, req)
  const user = await User.findOne({ email: body.email, status: 'active' }).select('_id email')
  if (user) {
    await PasswordReset.updateMany({ userId: user._id, usedAt: null }, { $set: { usedAt: new Date() } })
    const token = randomToken(48)
    await PasswordReset.create({
      userId: user._id,
      tokenHash: hashOpaqueToken(token),
      expiresAt: new Date(Date.now() + 30 * 60_000),
      requestedIp: req.ip,
    })
    try {
      await sendPasswordResetEmail(user.email, token)
    } catch (error) {
      pino.error({ error, requestId: req.requestId }, 'password reset email delivery failed')
    }
    await recordAudit({ action: 'auth.password_reset_requested', req, actorUserId: String(user._id) })
  }
  res.status(202).json({ message: 'If the account exists, a password reset message will be sent' })
}))

router.post('/reset-password', resetLimiter, asyncHandler(async (req, res) => {
  const body = parseBody(resetSchema, req)
  const passwordHash = await hashPassword(body.password)
  const reset: any = await withMongoTransaction(async (session) => {
    let claimed: any
    try {
      const resetQuery = PasswordReset.findOneAndUpdate({
        tokenHash: hashOpaqueToken(body.token),
        usedAt: null,
        expiresAt: { $gt: new Date() },
      }, { $set: { usedAt: new Date() } }, { new: true })
      if (session) resetQuery.session(session)
      claimed = await resetQuery
      if (!claimed) throw new HttpError(400, 'Invalid reset token', 'The reset token is invalid, expired, or already used')
      const userQuery = User.updateOne({ _id: claimed.userId, status: 'active' }, {
        $set: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockUntil: null },
      })
      if (session) userQuery.session(session)
      const changed = await userQuery
      if (!changed.matchedCount) throw new HttpError(404, 'Account unavailable', 'The account is no longer active')
      const sessionsQuery = Session.updateMany({ userId: claimed.userId, revokedAt: null }, {
        $set: { revokedAt: new Date(), revokeReason: 'password_reset' },
      })
      if (session) sessionsQuery.session(session)
      await sessionsQuery
      return claimed
    } catch (error) {
      if (!session && claimed) await PasswordReset.updateOne({ _id: claimed._id }, { $set: { usedAt: null } }).catch(() => undefined)
      throw error
    }
  })
  clearSessionCookies(res)
  await recordAudit({ action: 'auth.password_reset_completed', req, actorUserId: String(reset.userId) })
  res.json({ ok: true })
}))

router.post('/mfa/verify', authLimiter, asyncHandler(async (req, res) => {
  const body = parseBody(z.object({
    challengeId: z.string().min(32).max(200),
    code: z.string().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().min(8).max(100).optional(),
  }).strict().refine((value) => Boolean(value.code || value.recoveryCode), { message: 'code or recoveryCode is required' }), req)
  const challenge: any = await MfaChallenge.findOne({
    challengeHash: hashOpaqueToken(body.challengeId),
    consumedAt: null,
    expiresAt: { $gt: new Date() },
    attempts: { $lt: 5 },
  })
  if (!challenge || !timingSafeEqualString(challenge.ipHash, hashOpaqueToken(req.ip || req.socket.remoteAddress || 'unknown'))) {
    throw new HttpError(401, 'MFA challenge invalid', 'The MFA challenge is invalid or expired')
  }
  const user: any = await User.findOne({ _id: challenge.userId, status: 'active', mfaEnabled: true })
    .select('+mfaSecretEncrypted +mfaRecoveryCodeHashes')
  if (!user?.mfaSecretEncrypted) throw new HttpError(401, 'MFA challenge invalid', 'The MFA challenge is invalid or expired')
  let valid = false
  let recoveryHash: string | undefined
  if (body.code) {
    const secret = decryptString(user.mfaSecretEncrypted, `user-mfa:${String(user._id)}`)
    valid = authenticator.check(body.code, secret)
  } else if (body.recoveryCode) {
    recoveryHash = recoveryCodeHash(body.recoveryCode)
    valid = (user.mfaRecoveryCodeHashes || []).some((stored: string) => timingSafeEqualString(stored, recoveryHash!))
  }
  if (!valid) {
    await MfaChallenge.updateOne({ _id: challenge._id, consumedAt: null }, { $inc: { attempts: 1 } })
    await recordAudit({ action: 'auth.login_failed', req, actorUserId: String(user._id), metadata: { reason: 'mfa' } })
    throw new HttpError(401, 'MFA verification failed', 'The verification or recovery code is incorrect')
  }
  const claimed = await MfaChallenge.findOneAndUpdate({ _id: challenge._id, consumedAt: null, attempts: { $lt: 5 } }, {
    $set: { consumedAt: new Date() },
  }, { new: true })
  if (!claimed) throw new HttpError(409, 'MFA challenge already used', 'The MFA challenge was already completed')
  if (body.code && !await consumeTotpCode(String(user._id), body.code)) {
    throw new HttpError(409, 'Verification code already used', 'Wait for the next authenticator code and try again')
  }
  if (recoveryHash) {
    if (!await consumeRecoveryCode(String(user._id), body.recoveryCode!)) {
      throw new HttpError(409, 'Recovery code already used', 'This recovery code has already been consumed')
    }
  }
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } })
  // tenant-safe: scoped to the authenticated user; membership lookup is how the organisation is established
  const firstMembership: any = await Membership.findOne({ userId: user._id, status: 'active' }).sort({ createdAt: 1 }).lean()
  const organizationId = firstMembership ? String(firstMembership.organizationId) : undefined
  const issued = await createSession({ userId: String(user._id), organizationId, req, res })
  await recordAudit({ action: 'auth.login_mfa', req, organizationId, actorUserId: String(user._id), entityType: 'Session', entityId: issued.sessionId })
  res.json({ ...(await userResponse(user, organizationId)), sessionExpiresAt: issued.expiresAt })
}))

router.post('/mfa/setup', authenticate, csrfProtection, asyncHandler(async (req, res) => {
  const { password } = parseBody(z.object({ password: z.string().min(1).max(128) }).strict(), req)
  const user: any = await User.findById(req.auth!.userId).select('+passwordHash +mfaPendingSecretEncrypted')
  if (!user) throw new HttpError(404, 'Account not found', 'Account not found')
  if (!await verifyPassword(password, user.passwordHash)) throw new HttpError(401, 'Reauthentication failed', 'Password is incorrect')
  const secret = authenticator.generateSecret()
  user.mfaPendingSecretEncrypted = encryptString(secret, `user-mfa:${String(user._id)}`)
  await user.save()
  const otpauthUrl = authenticator.keyuri(user.email, 'LogicFlower', secret)
  await recordAudit({ action: 'auth.mfa_setup_started', req })
  res.json({ secret, otpauthUrl })
}))

router.post(['/mfa/setup/confirm', '/mfa/confirm'], authenticate, csrfProtection, asyncHandler(async (req, res) => {
  const { code } = parseBody(z.object({ code: z.string().regex(/^\d{6}$/) }).strict(), req)
  const user: any = await User.findById(req.auth!.userId).select('+mfaPendingSecretEncrypted')
  if (!user?.mfaPendingSecretEncrypted) throw new HttpError(400, 'MFA setup required', 'Start MFA setup before verification')
  const secret = decryptString(user.mfaPendingSecretEncrypted, `user-mfa:${String(user._id)}`)
  if (!authenticator.check(code, secret)) throw new HttpError(400, 'Invalid verification code', 'The verification code is incorrect')
  const recoveryCodes = Array.from({ length: 10 }, () => randomToken(9).toUpperCase())
  const activated = await User.updateOne({ _id: user._id, mfaPendingSecretEncrypted: user.mfaPendingSecretEncrypted }, {
    $set: {
      mfaEnabled: true,
      mfaSecretEncrypted: user.mfaPendingSecretEncrypted,
      mfaRecoveryCodeHashes: recoveryCodes.map(hashOpaqueToken),
    },
    $unset: { mfaPendingSecretEncrypted: 1 },
  })
  if (!activated.modifiedCount) throw new HttpError(409, 'MFA setup already completed', 'Start a new MFA setup if you need to replace the authenticator')
  await recordAudit({ action: 'auth.mfa_enabled', req })
  res.json({ enabled: true, recoveryCodes })
}))

router.delete('/mfa', authenticate, csrfProtection, asyncHandler(async (req, res) => {
  const { password, code, recoveryCode } = parseBody(z.object({
    password: z.string().min(1).max(128),
    code: z.string().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().min(8).max(100).optional(),
  }).strict().refine((value) => Boolean(value.code || value.recoveryCode), { message: 'code or recoveryCode is required' }), req)
  const user: any = await User.findById(req.auth!.userId).select('+passwordHash +mfaSecretEncrypted +mfaPendingSecretEncrypted +mfaRecoveryCodeHashes')
  if (!user || !await verifyPassword(password, user.passwordHash)) throw new HttpError(401, 'Verification failed', 'Password or verification code is incorrect')
  const secret = user.mfaSecretEncrypted ? decryptString(user.mfaSecretEncrypted, `user-mfa:${String(user._id)}`) : ''
  const recoveryHash = recoveryCode ? recoveryCodeHash(recoveryCode) : undefined
  const validCode = Boolean(code && secret && authenticator.check(code, secret))
  const validRecovery = Boolean(recoveryHash && (user.mfaRecoveryCodeHashes || []).some((stored: string) => timingSafeEqualString(stored, recoveryHash)))
  if (!validCode && !validRecovery) throw new HttpError(401, 'Verification failed', 'Password or verification code is incorrect')
  user.mfaEnabled = false
  user.mfaSecretEncrypted = undefined
  user.mfaPendingSecretEncrypted = undefined
  user.mfaRecoveryCodeHashes = []
  await user.save()
  await recordAudit({ action: 'auth.mfa_disabled', req })
  res.json({ enabled: false })
}))

router.get('/sessions', authenticate, asyncHandler(async (req, res) => {
  const sessions = await Session.find({ userId: req.auth!.userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastUsedAt: -1 })
    .select('_id currentOrganizationId userAgent ipAddress lastUsedAt createdAt expiresAt')
    .lean()
  res.json({ items: sessions.map((session: any) => ({ ...session, current: String(session._id) === req.auth!.sessionId })) })
}))

router.delete('/sessions/:sessionId', authenticate, csrfProtection, asyncHandler(async (req, res) => {
  const result = await Session.updateOne({ _id: req.params.sessionId, userId: req.auth!.userId, revokedAt: null }, {
    $set: { revokedAt: new Date(), revokeReason: 'user_revoked' },
  })
  if (!result.matchedCount) throw new HttpError(404, 'Session not found', 'Active session not found')
  if (req.params.sessionId === req.auth!.sessionId) clearSessionCookies(res)
  await recordAudit({ action: 'auth.session_revoked', req, entityType: 'Session', entityId: req.params.sessionId })
  res.status(204).end()
}))

export default router
