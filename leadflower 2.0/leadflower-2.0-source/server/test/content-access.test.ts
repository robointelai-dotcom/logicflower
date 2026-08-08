import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * The public website is platform property, not workspace property.
 *
 * These assertions are structural rather than behavioural — they read the route
 * file — because the failure they guard against is somebody adding a thirteenth
 * route and forgetting the gate. A behavioural test only covers the routes it
 * knows about; this covers the ones nobody has written yet.
 *
 * The guard now delegates to `assertCorporate`, so the role check is asserted
 * where it lives and the delegation is asserted here. The MFA requirement on
 * writes is new and is covered below: publishing to the operator's own domain
 * is at least as privileged as anything on `/admin`, which has always demanded
 * a second factor.
 */
describe('website content is corporate-only', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/content.ts'), 'utf8')
  const guardSource = fs.readFileSync(path.join(__dirname, '../src/middleware/platformAdmin.ts'), 'utf8')

  it('gates on the platform role, never on a workspace role', () => {
    // A workspace owner or admin is an ordinary customer. Checking req.auth.role
    // here would hand every client owner the keys to the public website.
    expect(guardSource).toContain('req.auth?.platformRole')
    expect(source).toContain('assertCorporate(req')
    expect(source).not.toMatch(/requireCorporate[\s\S]{0,200}req\.auth\?\.role\b/)
  })

  it('admits only platform owner and admin', () => {
    const guard = /export function assertCorporate[\s\S]*?\n}/.exec(guardSource)?.[0] ?? ''
    expect(guard).toContain("'owner'")
    expect(guard).toContain("'admin'")
    // Support has no standing access to anything, including this.
    expect(guard).not.toContain("'support'")
    expect(guard).not.toContain("'operator'")
  })

  it('calls the guard on every authenticated route', () => {
    // Strip comments so a mention in prose cannot satisfy the count.
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const routes = executable.match(/^router\.(get|post|put|patch|delete)\(/gm) ?? []
    const guards = executable.match(/requireCorporate(Write)?\(req\)/g) ?? []
    expect(routes.length).toBeGreaterThan(0)
    expect(guards.length).toBe(routes.length)
  })

  it('requires a second factor on every route that changes what the public sees', () => {
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // Split the file at each route declaration and check the mutating ones.
    const blocks = executable.split(/^router\./gm).slice(1)
    const mutations = blocks.filter((block) => /^(post|put|patch|delete)\(/.test(block))
    expect(mutations.length).toBeGreaterThan(0)
    for (const block of mutations) {
      expect(block).toContain('requireCorporateWrite(req)')
    }
    // And the MFA demand is real, not merely named.
    const writeGuard = /function requireCorporateWrite[\s\S]*?\n}/.exec(source)?.[0] ?? ''
    expect(writeGuard).toContain('mfa: true')
  })

  it('leaves the public reader unguarded, since it must serve anonymous visitors', () => {
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, '')
    const publicRoutes = executable.match(/^publicContentRouter\.(get|post)\(/gm) ?? []
    expect(publicRoutes.length).toBeGreaterThan(0)
    // Read-only: a public visitor must never be able to write.
    expect(executable).not.toMatch(/^publicContentRouter\.(post|put|patch|delete)\(/m)
  })
})
