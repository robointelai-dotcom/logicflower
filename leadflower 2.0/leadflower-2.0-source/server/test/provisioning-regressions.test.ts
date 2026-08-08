import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { slugify } from '../src/services/hierarchy/provisioning'
import { contactWritableFields, creationTags } from '../src/services/crm/contactFields'
import { trypostConfig } from '../src/routes/trypost'

const read = (relative: string) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')
/** Comments describe the bugs at length; they must not satisfy an assertion. */
const executable = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * Regressions for the defects found in the 9713949 audit.
 *
 * Each of these shipped, passed every existing test, and was invisible until
 * somebody tried to use the feature — which is the argument for pinning them
 * here rather than trusting that a fix stays fixed.
 */

describe('organisation slugs', () => {
  it('produces a URL-safe slug for any name', () => {
    // Run enough times to catch an alphabet bug rather than a lucky draw: the
    // previous suffix came from base64url and admitted `_` about one time in
    // eight.
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      for (const name of ['Acme Ltd', 'Ürsula & Co.', '   ', '日本語', 'A'.repeat(300)]) {
        const slug = slugify(name)
        expect(slug).toMatch(/^[a-z0-9-]+$/)
        expect(slug.startsWith('-')).toBe(false)
        expect(slug.endsWith('-')).toBe(false)
      }
    }
  })

  it('never returns an empty slug, since the schema requires one', () => {
    // An unnamed or entirely non-Latin organisation previously reduced to '' and
    // would have failed the required-field check on write.
    expect(slugify('   ').length).toBeGreaterThan(0)
    expect(slugify('日本語').length).toBeGreaterThan(0)
  })

  it('distinguishes two organisations with the same name', () => {
    expect(slugify('Acme Ltd')).not.toBe(slugify('Acme Ltd'))
  })
})

describe('agency and client creation supply every required field', () => {
  const source = executable(read('src/routes/hierarchy.ts'))
  const provisioning = executable(read('src/services/hierarchy/provisioning.ts'))

  it('no longer builds an Organization literal inline', () => {
    // Both inline literals omitted `slug` and `createdBy`, so neither endpoint
    // could ever succeed. Routing through the service is what prevents a third
    // call site repeating it.
    expect(source).not.toMatch(/Organization\.create\(/)
    expect(source).toContain('createAgency(')
    expect(source).toContain('provisionClient(')
  })

  it('sets the fields the schema marks required', () => {
    expect(provisioning).toContain('slug: slugify(name)')
    expect(provisioning).toContain('createdBy')
  })

  it('provisions a client as a complete, signable-into workspace', () => {
    // An Organization alone is not a customer: with no owner, membership or
    // invitation it appears on the agency console and cannot be logged into.
    for (const collaborator of ['Membership.create', 'Subscription.create', 'Invitation.create', 'User.create']) {
      expect(provisioning).toContain(collaborator)
    }
  })

  it('unwinds everything it created when any step fails', () => {
    expect(provisioning).toContain('Organization.deleteOne')
    expect(provisioning).toContain('Membership.deleteMany')
    expect(provisioning).toContain('Subscription.deleteOne')
    expect(provisioning).toContain('Invitation.deleteOne')
  })

  it('does not delete a pre-existing user it merely attached', () => {
    // Rolling back a failed provisioning must not remove somebody's platform
    // account because they happened to be named as the owner.
    expect(provisioning).toContain('if (createdUserId)')
  })
})

describe('switching workspace actually switches', () => {
  const source = executable(read('src/routes/hierarchy.ts'))
  const auth = executable(read('src/middleware/authenticate.ts'))

  it('rebinds the session rather than only reporting access', () => {
    // The endpoint used to resolve access, audit it, return 200 and change
    // nothing, so "Open workspace" reloaded the workspace you were already in.
    expect(source).toContain('switchSessionOrganization(')
  })

  it('resolves authority instead of demanding a direct membership', () => {
    // The real cause: even a correct switch was refused on the next request,
    // because org context required a Membership row that an agency or support
    // user does not have.
    expect(auth).toContain('resolveAccess(')
    expect(auth).not.toMatch(/Membership\.findOne\(/)
  })

  it('still scopes the request to exactly one organisation', () => {
    // Resolution decides whether you may act here. It must never widen the
    // request to span tenants.
    expect(auth).toContain('organizationId: requestedOrganization')
  })

  it('meters a support grant per request', () => {
    expect(auth).toContain('noteSupportGrantUse(')
  })
})

describe('agency access requests', () => {
  const source = executable(read('src/routes/hierarchy.ts'))

  it('creates a request the client can decide on', () => {
    // The button called /switch, which returned 403 under on_request and told
    // the client nothing. Nobody was ever asked.
    expect(source).toContain("'/agency/clients/:clientId/request-access'")
    expect(source).toContain('SupportAccessRequest.create(')
  })

  it('refuses a workspace that is not this agency\u2019s client', () => {
    expect(source).toContain('Not your client')
  })

  it('grants nothing merely by asking', () => {
    const block = /request-access[\s\S]*?^}\)\)/m.exec(source)?.[0] ?? ''
    expect(block).toContain("status: 'pending'")
    expect(block).toContain('dataAccessEnabled: false')
  })
})

describe('agency_owner can reach the console its role exists for', () => {
  it('is admitted to the hierarchy surface', () => {
    const app = executable(read('src/app.ts'))
    const guard = /const hierarchyViewer = requireRole\(([^)]*)\)/.exec(app)?.[1] ?? ''
    expect(guard).toContain("'agency_owner'")
  })
})

describe('contact creation persists what the form collects', () => {
  it('writes every standard CRM field the schema declares', () => {
    // These were collected by the UI, declared on the model, and silently
    // dropped on write — with no error, so the loss was invisible.
    const written = contactWritableFields({
      addressLine1: '1 High Street', addressLine2: 'Unit 4', city: 'Chennai',
      region: 'Tamil Nadu', postalCode: '600001', country: 'IN',
      jobTitle: 'Operations Lead', secondaryPhone: '+441234567890',
      preferredContactMethod: 'sms', referredBy: 'Trade show', leadScore: 72,
    })
    for (const field of [
      'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country',
      'jobTitle', 'secondaryPhone', 'preferredContactMethod', 'referredBy', 'leadScore',
    ]) {
      expect(written).toHaveProperty(field)
    }
    expect(written.leadScore).toBe(72)
    expect(written.city).toBe('Chennai')
  })

  it('omits absent keys, so a patch does not blank untouched fields', () => {
    const written = contactWritableFields({ city: 'Chennai' })
    expect(Object.keys(written)).toEqual(['city'])
  })

  it('rejects a lead score outside the range the schema allows', () => {
    expect(() => contactWritableFields({ leadScore: 101 })).toThrow()
    expect(() => contactWritableFields({ leadScore: -1 })).toThrow()
    expect(() => contactWritableFields({ leadScore: 'high' })).toThrow()
    expect(contactWritableFields({ leadScore: null }).leadScore).toBeNull()
  })

  it('rejects an unknown preferred contact method', () => {
    expect(() => contactWritableFields({ preferredContactMethod: 'pigeon' })).toThrow()
  })

  it('accepts tags at creation and rejects a non-array', () => {
    expect(creationTags({ tags: ['vip', 'inbound'] })).toEqual(['vip', 'inbound'])
    expect(creationTags({})).toEqual([])
    expect(() => creationTags({ tags: 'vip' })).toThrow()
  })

  it('routes creation tags through the rule engine, not straight onto the document', () => {
    // Writing the array directly would mean a contact created with the tag that
    // enrols them in a sequence is silently never enrolled.
    const crm = executable(read('src/routes/crm.ts'))
    const block = /router\.post\('\/contacts'[\s\S]*?^}\)\)/m.exec(crm)?.[0] ?? ''
    expect(block).toContain('applyTagChanges(')
    expect(block).toMatch(/tags:\s*\[\]/)
  })

  it('uses one field definition for both create and update', () => {
    const crm = executable(read('src/routes/crm.ts'))
    expect((crm.match(/contactWritableFields\(/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('trypost integration', () => {
  const source = read('src/routes/trypost.ts')
  const php = read('../trypost_web.php')

  it('has no hardcoded secret or host anywhere', () => {
    for (const literal of ['leadflower-secret-123', '139.99.134.4']) {
      expect(source).not.toContain(literal)
      expect(php).not.toContain(literal)
    }
  })

  it('no longer exposes an endpoint that checks a password', () => {
    // An unauthenticated credential oracle against every account on the
    // platform, gated only by a secret published in this repository.
    expect(executable(source)).not.toContain("'/verify'")
    expect(executable(source)).not.toContain('bcrypt')
  })

  it('fails closed when unconfigured rather than using a default', () => {
    const previous = { url: process.env.TRYPOST_BASE_URL, key: process.env.TRYPOST_ADMIN_API_KEY }
    delete process.env.TRYPOST_BASE_URL
    delete process.env.TRYPOST_ADMIN_API_KEY
    try {
      // Config is read per call, so the deletion above is what it observes.
      expect(() => trypostConfig()).toThrow()
      process.env.TRYPOST_BASE_URL = 'https://social.example.com'
      process.env.TRYPOST_ADMIN_API_KEY = 'short'
      expect(() => trypostConfig()).toThrow()
    } finally {
      if (previous.url) process.env.TRYPOST_BASE_URL = previous.url
      else delete process.env.TRYPOST_BASE_URL
      if (previous.key) process.env.TRYPOST_ADMIN_API_KEY = previous.key
      else delete process.env.TRYPOST_ADMIN_API_KEY
    }
  })

  it('compares the shared secret in constant time upstream', () => {
    // !== returns on the first differing byte and leaks the secret to anyone
    // willing to measure the response.
    expect(php).toContain('hash_equals(')
    expect(php).not.toMatch(/input\('secret'\)\s*!==/)
  })

  it('keys the external account on workspace and email, not email alone', () => {
    // Email alone meant one person in two workspaces shared one Trypost account
    // and therefore one set of connected social pages.
    expect(php).toContain("'workspace_key' => $workspaceKey")
    expect(source).toContain('workspaceKey')
  })
})

describe('member listing does not disclose account security state', () => {
  const source = executable(read('src/routes/organizations.ts'))

  it('is gated on a role at all', () => {
    expect(source).toMatch(/router\.get\('\/current\/members', canView/)
  })

  it('withholds MFA and login state from read-only roles', () => {
    // "Which of these accounts has no second factor" was answerable by any
    // viewer, billing or customer user through the API.
    expect(source).toContain("const fields = privileged ? 'email displayName status mfaEnabled lastLoginAt' : 'displayName'")
  })
})

describe('usage is readable by the role that generates it', () => {
  it('admits operator, who could not load their own Reports panel', () => {
    const source = executable(read('src/routes/usage.ts'))
    const guard = /router\.use\(requireRole\(([^)]*)\)\)/.exec(source)?.[1] ?? ''
    expect(guard).toContain("'operator'")
    // Read-only roles still have no business seeing consumption against quota.
    expect(guard).not.toContain("'viewer'")
    expect(guard).not.toContain("'customer'")
  })
})

describe('the repository is laid out the way CI expects', () => {
  const root = path.join(__dirname, '../..')

  it('has a package.json and lockfile at the root, so npm ci works there', () => {
    // CI ran `npm ci` at the root while the application lived two directories
    // down, so every run failed on its first step.
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'package-lock.json'))).toBe(true)
  })

  it('no longer nests the source under a directory with a space in its name', () => {
    expect(fs.existsSync(path.join(root, 'leadflower 2.0'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'server/src/app.ts'))).toBe(true)
  })

  it('does not ship a committed archive of itself', () => {
    // A zip of the source drifts from the source and eventually gets edited.
    const entries = fs.readdirSync(root)
    expect(entries.filter((entry) => entry.endsWith('.zip'))).toEqual([])
  })
})

describe('secrets are not committed', () => {
  const root = path.join(__dirname, '../..')

  it('keeps trypost.env out of the tree and ignored', () => {
    expect(fs.existsSync(path.join(root, 'trypost.env'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'trypost.env.example'))).toBe(true)
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    expect(ignore).toContain('trypost.env')
  })

  it('ships an example with no filled-in values', () => {
    const example = fs.readFileSync(path.join(root, 'trypost.env.example'), 'utf8')
    expect(example).not.toContain('BEGIN PRIVATE KEY')
    expect(example).toMatch(/LEADFLOWER_SSO_SECRET=\s*$/m)
  })
})
