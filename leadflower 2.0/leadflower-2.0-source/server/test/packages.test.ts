import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { resolveLimits, normaliseQuotas, UNLIMITED } from '../src/services/packages'
import { PLAN_LIMITS } from '../src/services/planLimits'
import { entitlementFromSubscription } from '../src/services/entitlements'

const read = (relative: string) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')
const executable = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * Package management resolves what a customer actually gets.
 *
 * The property that matters most is the boring one: a customer with no package
 * assigned must receive EXACTLY what they receive today. Every existing
 * subscription has `packageId: null`, so a resolution path that returned zero
 * or threw for them would take the product off the air for the whole estate the
 * moment this shipped.
 */

describe('limit resolution falls back safely', () => {
  it('gives an unmigrated customer their tier defaults, unchanged', () => {
    for (const plan of ['free', 'starter', 'agency', 'scale'] as const) {
      const resolved = resolveLimits({ plan, subscription: { plan }, packageDocument: null })
      expect(resolved.limits).toEqual({ ...PLAN_LIMITS[plan] })
      expect(resolved.sources.workflow_execution).toBe('tier_default')
      expect(resolved.packageCode).toBeNull()
    }
  })

  it('does not change the entitlement of a subscription with no package', () => {
    const at = new Date('2026-03-15T00:00:00Z')
    const subscription = { plan: 'free', status: 'inactive' }
    const entitlement = entitlementFromSubscription('org1', subscription, at)
    expect(entitlement.limits).toEqual({ ...PLAN_LIMITS.free })
    expect(entitlement.eligible).toBe(true)
  })

  it('applies a package quota over the tier default', () => {
    const resolved = resolveLimits({
      plan: 'starter',
      subscription: { plan: 'starter' },
      packageDocument: { code: 'starter-2026', version: 2, quotas: [{ metric: 'workflow_execution', included: 50_000 }] },
    })
    expect(resolved.limits.workflow_execution).toBe(50_000)
    expect(resolved.sources.workflow_execution).toBe('package')
    // A metric the package is silent about still falls through to the tier.
    expect(resolved.limits.contact_processed).toBe(PLAN_LIMITS.starter.contact_processed)
    expect(resolved.sources.contact_processed).toBe('tier_default')
  })

  it('lets a per-customer override beat the package', () => {
    const resolved = resolveLimits({
      plan: 'starter',
      subscription: { plan: 'starter', quotaOverrides: [{ metric: 'workflow_execution', included: 999 }] },
      packageDocument: { code: 'starter', version: 1, quotas: [{ metric: 'workflow_execution', included: 50_000 }] },
    })
    expect(resolved.limits.workflow_execution).toBe(999)
    expect(resolved.sources.workflow_execution).toBe('override')
  })

  it('ignores an override that has expired', () => {
    const at = new Date('2026-06-01T00:00:00Z')
    const resolved = resolveLimits({
      plan: 'starter',
      subscription: { plan: 'starter', quotaOverrides: [{ metric: 'workflow_execution', included: 999, expiresAt: new Date('2026-05-01T00:00:00Z') }] },
      packageDocument: null,
      at,
    })
    expect(resolved.limits.workflow_execution).toBe(PLAN_LIMITS.starter.workflow_execution)
  })

  it('treats unlimited as a large finite number, not zero', () => {
    // A limit of 0 meaning "infinite" is how quota bugs become free compute.
    const resolved = resolveLimits({
      plan: 'free',
      subscription: { plan: 'free' },
      packageDocument: { code: 'internal', version: 1, quotas: [{ metric: 'workflow_execution', included: 0, unlimited: true }] },
    })
    expect(resolved.limits.workflow_execution).toBe(UNLIMITED)
    expect(Number.isFinite(resolved.limits.workflow_execution)).toBe(true)
  })

  it('falls back rather than propagating a malformed limit', () => {
    // NaN or a negative compares falsely against usage and hands out free work.
    for (const broken of [Number.NaN, -5, 'lots' as unknown as number, undefined as unknown as number]) {
      const resolved = resolveLimits({
        plan: 'free',
        subscription: { plan: 'free' },
        packageDocument: { code: 'broken', version: 1, quotas: [{ metric: 'workflow_execution', included: broken }] },
      })
      expect(resolved.limits.workflow_execution).toBe(PLAN_LIMITS.free.workflow_execution)
      expect(resolved.sources.workflow_execution).toBe('tier_default')
    }
  })

  it('takes the last override for a metric, not the first', () => {
    const resolved = resolveLimits({
      plan: 'free',
      subscription: { plan: 'free', quotaOverrides: [
        { metric: 'workflow_execution', included: 100 },
        { metric: 'workflow_execution', included: 500 },
      ] },
      packageDocument: null,
    })
    expect(resolved.limits.workflow_execution).toBe(500)
  })
})

describe('quota validation on the admin surface', () => {
  it('accepts a well-formed quota list', () => {
    expect(normaliseQuotas([{ metric: 'workflow_execution', included: 100 }])).toEqual([
      { metric: 'workflow_execution', included: 100, unlimited: false, overageMinorUnits: null },
    ])
  })

  it('rejects an unknown metric, a duplicate, and a negative', () => {
    expect(() => normaliseQuotas([{ metric: 'bandwidth', included: 1 }])).toThrow(/Unknown quota metric/)
    expect(() => normaliseQuotas([
      { metric: 'workflow_execution', included: 1 },
      { metric: 'workflow_execution', included: 2 },
    ])).toThrow(/Duplicate/)
    expect(() => normaliseQuotas([{ metric: 'workflow_execution', included: -1 }])).toThrow()
    expect(() => normaliseQuotas([{ metric: 'workflow_execution', overageMinorUnits: -1, included: 1 }])).toThrow()
  })

  it('treats an absent list as empty rather than throwing', () => {
    expect(normaliseQuotas(undefined)).toEqual([])
    expect(normaliseQuotas(null)).toEqual([])
  })
})

describe('package administration protects existing customers', () => {
  const source = executable(read('src/routes/adminPackages.ts'))

  it('refuses to edit a published package', () => {
    // Editing in place would silently reprice everyone already on it, with no
    // approval and no record of a price change.
    expect(source).toContain("existing.status !== 'draft'")
    expect(source).toContain('package-not-draft')
  })

  it('versions rather than mutates, and pins the supersede chain', () => {
    expect(source).toContain('nextPackageVersion(')
    expect(source).toContain('supersedesVersion')
  })

  it('archiving withdraws from sale without cancelling subscribers', () => {
    const block = /archive[\s\S]*?^}\)\)/m.exec(source)?.[0] ?? ''
    expect(block).toContain('subscriberCount')
    // No cancellation, no entitlement change.
    expect(block).not.toContain('Subscription.updateOne')
    expect(block).not.toContain('deleteOne')
  })

  it('will not publish a paid public package with no way to charge for it', () => {
    expect(source).toContain('package-missing-stripe-price')
  })

  it('never carries a Stripe price across a duplicate', () => {
    const block = /duplicate[\s\S]*?^}\)\)/m.exec(source)?.[0] ?? ''
    expect(block).toContain('stripePriceId: null')
  })

  it('requires whole minor units for money', () => {
    // 19.99 as a float becomes 19.989999999999998 and the invoice is a penny out.
    expect(source).toContain('Number.isInteger(priceMinorUnits)')
  })
})

describe('customer administration', () => {
  const source = executable(read('src/routes/adminCustomers.ts'))

  it('creates customers through the one provisioning path', () => {
    // A second, admin-only creation routine is how the agency path came to
    // create an Organization and nothing else.
    expect(source).toContain('provisionClient(')
    expect(source).not.toContain('Organization.create(')
  })

  it('soft-deletes rather than destroying a tenant', () => {
    expect(source).not.toMatch(/Organization\.deleteOne|Organization\.deleteMany/)
    expect(source).toContain("['active', 'suspended', 'deleted'].includes(status)")
  })

  it('revokes sessions when suspending, so it takes effect immediately', () => {
    expect(source).toContain("revokedReason: 'organization_suspended'")
  })

  it('demands a recorded reason for suspension and for a quota override', () => {
    // Both get asked about months later by somebody who was not there.
    expect(source).toContain('Reason required')
    expect((source.match(/Reason required/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('requires recent authentication for destructive actions', () => {
    for (const route of ['/status', '/sessions/revoke', '/unlock']) {
      const index = source.indexOf(route)
      expect(index).toBeGreaterThan(-1)
      expect(source.slice(index, index + 200)).toContain('requireRecentAuthentication')
    }
  })

  it('scopes a user action through membership rather than trusting the id', () => {
    // Otherwise an admin acting on one customer could reach any account.
    expect(source).toContain('Membership.exists({ organizationId, userId')
  })

  it('does not grant a new agency standing access on a move', () => {
    // The customer agreed to be managed by a particular agency; handing that
    // to another company without asking is a disclosure, not a move.
    const block = /router\.post\('\/:organizationId\/agency'[\s\S]*?^}\)\)/m.exec(source)?.[0] ?? ''
    expect(block).toContain("agencyAccessMode: 'on_request'")
  })

  it('escapes a search term before putting it in a regex', () => {
    expect(source).toContain('replace(/[.*+?^${}()|[\\]\\\\]/g')
  })

  it('refuses to assign a draft package to a customer', () => {
    expect(source).toContain('package-not-published')
  })
})

describe('admin SaaS routes inherit the platform guards', () => {
  it('mounts packages and customers under /admin, not at the top level', () => {
    const admin = executable(read('src/routes/admin.ts'))
    expect(admin).toContain("router.use('/packages', adminPackageRoutes)")
    expect(admin).toContain("router.use('/customers', adminCustomerRoutes)")
    // The guards must be applied before the mounts.
    expect(admin.indexOf('requireAdminMfa')).toBeLessThan(admin.indexOf("router.use('/packages'"))
    expect(admin.indexOf("requirePlatformRole('admin', 'owner')")).toBeLessThan(admin.indexOf("router.use('/customers'"))
  })

  it('does not re-declare the guards, which would let the copies drift', () => {
    const packages = executable(read('src/routes/adminPackages.ts'))
    const customers = executable(read('src/routes/adminCustomers.ts'))
    expect(packages).not.toContain('requirePlatformRole(')
    expect(customers).not.toContain('requirePlatformRole(')
  })
})
