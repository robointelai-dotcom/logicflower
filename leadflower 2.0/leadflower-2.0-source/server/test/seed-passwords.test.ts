import { describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { validatePasswordStrength } from '../src/security/password'

/**
 * The seed script derives one password per account. These check the derivation
 * before anybody runs it against a database — a seed that produces a password
 * the application refuses leaves ten accounts nobody can sign in to.
 */
function passwordFor(base: string, email: string): string {
  const digest = crypto.createHmac('sha256', base).update(`logicflower-seed:${email}`).digest('base64url')
  return `Lf!${digest.slice(0, 16)}9`
}

const EMAILS = [
  'corporate@seed.local', 'support@seed.local',
  'agency-alpha@seed.local', 'agency-beta@seed.local',
  'ridgeway-owner@seed.local', 'ridgeway-team@seed.local', 'ridgeway-viewer@seed.local',
  'calder-owner@seed.local', 'harlow-owner@seed.local', 'direct-owner@seed.local',
]

describe('seeded account passwords', () => {
  const base = 'ChooseSomethingLong123'

  it('satisfies the application\u2019s own strength rules for every account', () => {
    // Guaranteed by the fixed prefix and suffix rather than by luck in the
    // digest: "Lf!" supplies upper, lower and symbol; "9" supplies the digit.
    for (const email of EMAILS) {
      expect(validatePasswordStrength(passwordFor(base, email)), email).toEqual([])
    }
  })

  it('gives every account a different password', () => {
    // One shared password means a single leaked credential opens every tier,
    // including corporate, which reaches the whole estate.
    const passwords = EMAILS.map((email) => passwordFor(base, email))
    expect(new Set(passwords).size).toBe(EMAILS.length)
  })

  it('reproduces the same set from the same base', () => {
    // A tester who loses the printout re-runs the script rather than resetting
    // ten accounts.
    for (const email of EMAILS) {
      expect(passwordFor(base, email)).toBe(passwordFor(base, email))
    }
  })

  it('produces a completely different set from a different base', () => {
    for (const email of EMAILS) {
      expect(passwordFor(base, email)).not.toBe(passwordFor('AnotherBaseSecret456', email))
    }
  })

  it('never leaks the base secret into a password', () => {
    // Holding one account's credential must not yield the base, and therefore
    // must not yield any other account.
    for (const email of EMAILS) {
      expect(passwordFor(base, email)).not.toContain(base)
      expect(passwordFor(base, email)).not.toContain(base.slice(0, 8))
    }
  })
})
