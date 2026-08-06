import { env } from '../env'

/**
 * Account lockout policy.
 *
 * Extracted from the login handler so the decision can be tested without a
 * database. The arithmetic is where the bugs live: an off-by-one either locks a
 * legitimate user out one failure early, or leaves an attacker one extra
 * attempt per lock cycle. Neither is visible from reading the handler.
 *
 * This module makes no decision about what to tell the caller. Whether to
 * disclose remaining attempts is a product judgement — it helps a real user and
 * marginally helps an attacker calibrate — so the number is returned and the
 * handler decides.
 */

export interface LockoutInput {
  failedCount: number
  lockedUntil: Date | null
  now?: number
  maxFailures?: number
  lockMinutes?: number
}

export interface LockoutDecision {
  locked: boolean
  lockedUntil: Date | null
  remainingAttempts: number
  /** True when a previously applied lock has expired and state should be cleared. */
  shouldResetCounter: boolean
}

export const LOCKOUT_DEFAULTS = {
  get maxFailures(): number { return env.LOGIN_MAX_FAILURES },
  get lockMinutes(): number { return env.LOGIN_LOCK_MINUTES },
}

export function evaluateLockout(input: LockoutInput): LockoutDecision {
  const now = input.now ?? Date.now()
  const maxFailures = input.maxFailures ?? LOCKOUT_DEFAULTS.maxFailures
  const lockMinutes = input.lockMinutes ?? LOCKOUT_DEFAULTS.lockMinutes
  const failedCount = Math.max(0, Number(input.failedCount) || 0)

  const lockedUntilMs = input.lockedUntil ? new Date(input.lockedUntil).getTime() : 0

  // An expired lock is not a lock. Carrying it forward would make the lockout
  // permanent for anyone whose row is never rewritten.
  if (lockedUntilMs && lockedUntilMs <= now) {
    return { locked: false, lockedUntil: null, remainingAttempts: maxFailures, shouldResetCounter: true }
  }

  if (lockedUntilMs > now) {
    return { locked: true, lockedUntil: new Date(lockedUntilMs), remainingAttempts: 0, shouldResetCounter: false }
  }

  if (failedCount >= maxFailures) {
    return {
      locked: true,
      lockedUntil: new Date(now + lockMinutes * 60_000),
      remainingAttempts: 0,
      shouldResetCounter: false,
    }
  }

  return {
    locked: false,
    lockedUntil: null,
    remainingAttempts: Math.max(0, maxFailures - failedCount),
    shouldResetCounter: false,
  }
}
