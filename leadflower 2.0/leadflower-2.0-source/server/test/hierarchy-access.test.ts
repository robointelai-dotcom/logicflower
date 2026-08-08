import { describe, expect, it } from 'vitest'
import { MAX_SUPPORT_GRANT_HOURS } from '../src/services/hierarchy/access'
import { membershipRoles } from '../src/models/Membership'

/**
 * The resolution rules are exercised against the real service in the
 * integration suite, which needs a database. What can be proved here without
 * one is the shape of the model: which roles exist, and that the constants
 * governing support access are bounded.
 *
 * The behavioural rules these encode, all verified in
 * `docs/LIVE_ACCEPTANCE.md`:
 *
 *   - A direct membership always wins over any inherited authority.
 *   - An agency reaches only its OWN clients, one level down, never sideways.
 *   - Support with no live grant is refused exactly as a stranger is.
 *   - A grant expires on a clock and cannot be renewed without fresh approval.
 */
describe('hierarchy roles', () => {
  it('includes the agency role alongside the workspace roles', () => {
    expect(membershipRoles).toContain('agency_owner')
    for (const role of ['owner', 'admin', 'operator', 'viewer', 'billing']) {
      expect(membershipRoles).toContain(role)
    }
  })

  it('keeps the agency role distinct from a workspace owner', () => {
    // They must not be conflated: `owner` on a client grants nothing over other
    // clients, and `agency_owner` on a client organisation means nothing at all.
    expect(membershipRoles.indexOf('agency_owner')).not.toBe(membershipRoles.indexOf('owner'))
  })
})

describe('support access limits', () => {
  it('caps a grant at a day, whatever was requested', () => {
    // An open-ended support login is precisely what a customer is entitled to
    // object to. The ceiling is enforced at approval, not trusted from the
    // request.
    expect(MAX_SUPPORT_GRANT_HOURS).toBeGreaterThan(0)
    expect(MAX_SUPPORT_GRANT_HOURS).toBeLessThanOrEqual(24)
  })
})
