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
 */
describe('website content is corporate-only', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/content.ts'), 'utf8')

  it('gates on the platform role, never on a workspace role', () => {
    // A workspace owner or admin is an ordinary customer. Checking req.auth.role
    // here would hand every client owner the keys to the public website.
    expect(source).toContain("req.auth?.platformRole")
    expect(source).not.toMatch(/requireCorporate[\s\S]{0,200}req\.auth\?\.role\b/)
  })

  it('admits only platform owner and admin', () => {
    const guard = /function requireCorporate[\s\S]*?\n}/.exec(source)?.[0] ?? ''
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
    const guards = executable.match(/requireCorporate\(req\)/g) ?? []
    expect(routes.length).toBeGreaterThan(0)
    expect(guards.length).toBe(routes.length)
  })

  it('leaves the public reader unguarded, since it must serve anonymous visitors', () => {
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, '')
    const publicRoutes = executable.match(/^publicContentRouter\.(get|post)\(/gm) ?? []
    expect(publicRoutes.length).toBeGreaterThan(0)
    // Read-only: a public visitor must never be able to write.
    expect(executable).not.toMatch(/^publicContentRouter\.(post|put|patch|delete)\(/m)
  })
})
