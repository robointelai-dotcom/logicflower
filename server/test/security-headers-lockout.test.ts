import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app'

/**
 * Response header policy.
 *
 * Exercised against the real mounted application rather than by reading the
 * helmet configuration back, because the configuration is not the contract —
 * what leaves the process is. These run against `/healthz`, which needs no
 * database, so the assertions hold in the unit run.
 */
describe('security response headers', () => {
  const app = createApp()

  it('denies every content source by default', async () => {
    const response = await request(app).get('/healthz')
    const csp = response.headers['content-security-policy'] || ''
    expect(csp).toContain("default-src 'none'")
    // The API renders no HTML, so nothing should ever execute or frame it.
    expect(csp).toContain("script-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
  })

  it('sets the isolation and referrer headers', async () => {
    const response = await request(app).get('/healthz')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(response.headers['cross-origin-resource-policy']).toBe('same-site')
    expect(response.headers['permissions-policy']).toContain('camera=()')
  })

  it('never caches an API response into shared storage', async () => {
    const response = await request(app).get('/healthz')
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('does not advertise the server implementation', async () => {
    const response = await request(app).get('/healthz')
    expect(response.headers['x-powered-by']).toBeUndefined()
  })

  it('omits HSTS when not serving over TLS', async () => {
    // Asserting HSTS from a plaintext development server pins a developer's
    // browser to https://localhost and is a self-inflicted outage.
    const response = await request(app).get('/healthz')
    expect(response.headers['strict-transport-security']).toBeUndefined()
  })

  it('returns a problem+json envelope with a correlation id on an unknown route', async () => {
    const response = await request(app).get('/api/v1/does-not-exist')
    expect(response.status).toBe(404)
    expect(response.headers['content-type']).toContain('application/problem+json')
    expect(response.body.correlationId).toBeTruthy()
    expect(response.body).toHaveProperty('retryable')
  })
})

/**
 * Account lockout arithmetic.
 *
 * The policy decision — how many failures, how long the lock, whether a
 * successful login resets the counter — is separable from the database write,
 * and testing it directly is what catches an off-by-one that would either lock
 * a legitimate user out a failure early or leave one extra attempt available to
 * an attacker.
 */
import { evaluateLockout, LOCKOUT_DEFAULTS } from '../src/auth/lockout'

describe('account lockout policy', () => {
  const now = Date.UTC(2026, 7, 5, 12, 0, 0)

  it('locks exactly at the configured failure count, not before', async () => {
    const max = LOCKOUT_DEFAULTS.maxFailures
    expect(evaluateLockout({ failedCount: max - 1, lockedUntil: null, now }).locked).toBe(false)
    const atLimit = evaluateLockout({ failedCount: max, lockedUntil: null, now })
    expect(atLimit.locked).toBe(true)
    expect(atLimit.lockedUntil).toBeInstanceOf(Date)
  })

  it('keeps the account locked until the window elapses', async () => {
    const lockedUntil = new Date(now + 60_000)
    expect(evaluateLockout({ failedCount: 9, lockedUntil, now }).locked).toBe(true)
    expect(evaluateLockout({ failedCount: 9, lockedUntil, now: now + 61_000 }).locked).toBe(false)
  })

  it('reports the remaining attempts so the response can be honest without being useful to an attacker', async () => {
    const result = evaluateLockout({ failedCount: 2, lockedUntil: null, now })
    expect(result.remainingAttempts).toBe(LOCKOUT_DEFAULTS.maxFailures - 2)
  })

  it('treats a cleared counter as a clean slate', async () => {
    const result = evaluateLockout({ failedCount: 0, lockedUntil: null, now })
    expect(result.locked).toBe(false)
    expect(result.remainingAttempts).toBe(LOCKOUT_DEFAULTS.maxFailures)
  })

  it('never reports negative remaining attempts', async () => {
    const result = evaluateLockout({ failedCount: 99, lockedUntil: null, now })
    expect(result.remainingAttempts).toBe(0)
  })

  it('expires a stale lock rather than carrying it forward indefinitely', async () => {
    const lockedUntil = new Date(now - 86_400_000)
    const result = evaluateLockout({ failedCount: 20, lockedUntil, now })
    expect(result.locked).toBe(false)
    expect(result.shouldResetCounter).toBe(true)
  })
})
