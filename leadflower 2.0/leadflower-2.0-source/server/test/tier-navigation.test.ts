import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const CLIENT = path.join(__dirname, '../../client/src')
const SERVER = path.join(__dirname, '../src')

/**
 * Structural checks on the navigation and the corporate gates.
 *
 * Read the source rather than exercise it, because the failure worth catching
 * is a NEW item added without a gate — which a behavioural test covering
 * today's items would not see.
 */
describe('navigation matches what each role can actually do', () => {
  const shell = fs.readFileSync(path.join(CLIENT, 'components/Shell.tsx'), 'utf8')

  it('does not offer a viewer the screens they cannot act on', () => {
    // The navigation used to grant nearly everything to the same broad set, so
    // a viewer saw Sequences, Booking, Social and Calling and was stopped only
    // at the API. The server was right; the door was wrong.
    for (const label of ['Sequences', 'Booking', 'Social', 'Auto Post', 'Calling', 'Workflows']) {
      const line = shell.split('\n').find((entry) => entry.includes(`label: '${label}'`) && entry.includes('roles:'))
      expect(line, `${label} has no role gate`).toBeDefined()
      expect(line, `${label} is still offered to viewers`).not.toContain("'viewer'")
    }
  })

  it('keeps read-only screens open to everyone in the workspace', () => {
    for (const label of ['Today', 'Inbox', 'Contacts', 'Pipeline', 'Audit log']) {
      const line = shell.split('\n').find((entry) => entry.includes(`label: '${label}'`) && entry.includes('roles:'))
      expect(line, `${label} should reach EVERYONE`).toContain('EVERYONE')
    }
  })

  it('restricts configuration to owners and admins', () => {
    for (const label of ['Connections', 'Vault']) {
      const line = shell.split('\n').find((entry) => entry.includes(`label: '${label}'`) && entry.includes('roles:'))
      expect(line, `${label} should be MANAGERS only`).toContain('MANAGERS')
    }
  })

  it('builds the corporate and agency sections rather than filtering them', () => {
    // Built, not hidden: a client's sidebar must not contain items that a stray
    // style could reveal.
    expect(shell).toContain("if (tier?.corporate)")
    expect(shell).toContain("if (tier?.tier === 'agency')")
  })

  it('names the tier in the workspace badge', () => {
    // Somebody working across three tiers in an afternoon needs to know which
    // one they are acting in.
    expect(shell).toMatch(/tier\?\.corporate \? 'Corporate'/)
  })
})

describe('the public website is corporate-only', () => {
  const content = fs.readFileSync(path.join(SERVER, 'routes/content.ts'), 'utf8')

  it('gates every authenticated route on the platform role', () => {
    const executable = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const routes = executable.match(/^router\.(get|post|put|patch|delete)\(/gm) ?? []
    const guards = executable.match(/requireCorporate(Write)?\(req\)/g) ?? []
    expect(routes.length).toBeGreaterThan(0)
    expect(guards.length).toBe(routes.length)
  })

  it('demands a second factor for writes, not merely a role', () => {
    // A stolen platform password must not be enough to publish to the
    // operator's own domain.
    expect(content).toContain('requireCorporateWrite')
  })
})

describe('platform MFA is configurable, not commented out', () => {
  const guard = fs.readFileSync(path.join(SERVER, 'middleware/platformAdmin.ts'), 'utf8')

  it('reads a flag rather than living behind commented-out code', () => {
    // It was disabled in-code during a deployment, which left no record that
    // the state was temporary and no way to restore it without another commit.
    expect(guard).toContain('REQUIRE_CORPORATE_MFA')
    expect(guard).not.toMatch(/^\s*\/\/\s*if \(options\.mfa/m)
  })

  it('defaults to on', () => {
    expect(guard).toMatch(/CORPORATE_MFA_REQUIRED \?\? 'true'/)
  })

  it('warns loudly when switched off', () => {
    expect(guard).toContain('console.warn')
  })
})

describe('trypost SSO transport', () => {
  const trypost = fs.readFileSync(path.join(SERVER, 'routes/trypost.ts'), 'utf8')

  it('requires HTTPS unless insecure transport is deliberately permitted', () => {
    // The shared secret travels in the request body; over plain HTTP it is
    // readable by anything on the path and is enough to mint a session.
    expect(trypost).toContain('TRYPOST_ALLOW_INSECURE')
    expect(trypost).toMatch(/\^https/)
  })

  it('keeps a minimum secret length, defaulting to 32', () => {
    // Asserts the behaviour, not the spelling. The bound is configurable via
    // TRYPOST_MIN_SECRET_LENGTH so a blocked deployment can lower it visibly
    // rather than somebody commenting the check out again — which has now
    // happened twice.
    expect(trypost).toContain('secret.length < minimum')
    expect(trypost).toMatch(/TRYPOST_MIN_SECRET_LENGTH \?\? 32/)
  })
})
