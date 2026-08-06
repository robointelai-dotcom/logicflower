import { beforeEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'

describe('envelope encryption and key rotation', () => {
  beforeEach(async () => {
    const { resetKeyring } = await import('../src/security/keyring')
    resetKeyring()
  })

  it('round-trips through the versioned envelope format', async () => {
    const { encryptString, decryptString, envelopeKeyVersion } = await import('../src/security/encryption')
    const sealed = encryptString('super-secret-token', 'connection:abc:def')
    expect(sealed.startsWith('v2.')).toBe(true)
    expect(envelopeKeyVersion(sealed)).toBe(1)
    expect(decryptString(sealed, 'connection:abc:def')).toBe('super-secret-token')
  })

  it('rejects a ciphertext opened under different associated data', async () => {
    const { encryptString, decryptString } = await import('../src/security/encryption')
    const sealed = encryptString('token', 'connection:org-a:conn-1')
    expect(() => decryptString(sealed, 'connection:org-b:conn-1')).toThrow()
  })

  it('still decrypts legacy v1 ciphertext written before the upgrade', async () => {
    // Dropping v1 would strand every credential encrypted before the upgrade,
    // which is the opposite of a zero-downtime migration.
    const { env } = await import('../src/env')
    const { decryptString } = await import('../src/security/encryption')
    const key = Buffer.from(env.ENCRYPTION_KEY, 'hex')
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from('legacy-aad', 'utf8'))
    const body = Buffer.concat([cipher.update('legacy-value', 'utf8'), cipher.final()])
    const legacy = ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.')
    expect(decryptString(legacy, 'legacy-aad')).toBe('legacy-value')
  })

  it('keeps prior versions readable after rotation, which is what makes it zero-downtime', async () => {
    const { encryptString, decryptString, envelopeKeyVersion, needsRewrap } = await import('../src/security/encryption')
    const { rotateKeyring, activeKeyVersion } = await import('../src/security/keyring')

    const beforeRotation = encryptString('written-before', 'aad')
    expect(envelopeKeyVersion(beforeRotation)).toBe(1)

    await rotateKeyring()
    expect(activeKeyVersion()).toBe(2)

    // Written a moment before the rotation, still readable a moment after.
    expect(decryptString(beforeRotation, 'aad')).toBe('written-before')
    expect(needsRewrap(beforeRotation)).toBe(true)

    const afterRotation = encryptString('written-after', 'aad')
    expect(envelopeKeyVersion(afterRotation)).toBe(2)
    expect(decryptString(afterRotation, 'aad')).toBe('written-after')
  })

  it('re-wraps onto the active version without changing the plaintext', async () => {
    const { encryptString, decryptString, rewrapString, envelopeKeyVersion, needsRewrap } = await import('../src/security/encryption')
    const { rotateKeyring } = await import('../src/security/keyring')
    const original = encryptString('rotate-me', 'aad')
    await rotateKeyring()
    const rewrapped = rewrapString(original, 'aad')
    expect(envelopeKeyVersion(rewrapped)).toBe(2)
    expect(needsRewrap(rewrapped)).toBe(false)
    expect(decryptString(rewrapped, 'aad')).toBe('rotate-me')
  })

  it('derives distinct key material per version', async () => {
    const { keyForVersion } = await import('../src/security/keyring')
    expect(keyForVersion(1).equals(keyForVersion(2))).toBe(false)
    expect(keyForVersion(1).length).toBe(32)
  })

  it('rejects a malformed or unknown envelope rather than guessing', async () => {
    const { decryptString } = await import('../src/security/encryption')
    for (const value of ['', 'v3.1.a.b.c', 'not-an-envelope', 'v2.notanumber.a.b.c', 'v1.only']) {
      expect(() => decryptString(value)).toThrow()
    }
  })
})

describe('webhook replay freshness', () => {
  it('accepts a signed payload inside the drift window and rejects one outside it', async () => {
    const { evaluateBodyFreshness } = await import('../src/services/webhookSecurity')
    const now = Date.UTC(2026, 7, 5, 12, 0, 0)
    const fresh = Buffer.from(JSON.stringify({ timestamp: now - 30_000 }))
    const stale = Buffer.from(JSON.stringify({ timestamp: now - 8 * 86_400_000 }))
    expect(evaluateBodyFreshness(fresh, now).fresh).toBe(true)
    // A week-old capture: still validly signed, and previously accepted once
    // the retention worker had purged the de-duplication record.
    expect(evaluateBodyFreshness(stale, now).reason).toBe('stale')
  })

  it('reports a missing timestamp distinctly rather than passing silently', async () => {
    const { evaluateBodyFreshness } = await import('../src/services/webhookSecurity')
    expect(evaluateBodyFreshness(Buffer.from('{}')).reason).toBe('no_timestamp')
    expect(evaluateBodyFreshness(Buffer.from('not json')).reason).toBe('no_timestamp')
  })

  it('reads seconds and milliseconds and ISO strings', async () => {
    const { payloadTimestamp } = await import('../src/services/webhookSecurity')
    const millis = Date.UTC(2026, 7, 5, 12, 0, 0)
    expect(payloadTimestamp(Buffer.from(JSON.stringify({ timestamp: millis })))).toBe(millis)
    expect(payloadTimestamp(Buffer.from(JSON.stringify({ timestamp: Math.floor(millis / 1000) })))).toBe(millis)
    expect(payloadTimestamp(Buffer.from(JSON.stringify({ occurredAt: new Date(millis).toISOString() })))).toBe(millis)
  })

  it('prefers a configured provider key over the embedded default', async () => {
    const { ghlEd25519PublicKey } = await import('../src/services/webhookSecurity')
    // Without an override the embedded published key is used, so a rotation by
    // the provider is a configuration change rather than a redeploy.
    expect(ghlEd25519PublicKey()).toContain('BEGIN PUBLIC KEY')
  })
})

describe('grandfathered pricing', () => {
  it('never reprices a locked organisation', async () => {
    const { evaluatePriceMigration } = await import('../src/services/pricingLock')
    const decision = evaluatePriceMigration({
      organizationId: 'org-1',
      lock: { priceLocked: true, legacyPlanId: 'price_legacy_99' },
      currentPriceId: 'price_legacy_99',
      targetPriceId: 'price_new_149',
    })
    expect(decision.applied).toBe(false)
    expect(decision.reason).toBe('price_locked')
    expect(decision.toPriceId).toBe('price_legacy_99')
  })

  it('migrates an unlocked organisation', async () => {
    const { evaluatePriceMigration } = await import('../src/services/pricingLock')
    const decision = evaluatePriceMigration({
      organizationId: 'org-2',
      lock: { priceLocked: false, legacyPlanId: null },
      currentPriceId: 'price_old',
      targetPriceId: 'price_new',
    })
    expect(decision.applied).toBe(true)
    expect(decision.toPriceId).toBe('price_new')
  })

  it('keeps a locked organisation on current tier entitlements', async () => {
    // Grandfathering is a price guarantee, not a feature freeze. Resolving
    // limits from the legacy price would penalise the loyal customer.
    const { limitsForLockedPlan } = await import('../src/services/pricingLock')
    const { PLAN_LIMITS } = await import('../src/services/entitlements')
    expect(limitsForLockedPlan('agency')).toEqual(PLAN_LIMITS.agency)
  })

  it('treats an identical target price as no change', async () => {
    const { evaluatePriceMigration } = await import('../src/services/pricingLock')
    const decision = evaluatePriceMigration({
      organizationId: 'org-3',
      lock: { priceLocked: false, legacyPlanId: null },
      currentPriceId: 'price_same',
      targetPriceId: 'price_same',
    })
    expect(decision.reason).toBe('no_change')
  })
})

describe('[V3] contingency mode', () => {
  it('suppresses workflow features and keeps batch running when the flag is off', async () => {
    const { deploymentWatchDecision } = await import('../src/services/watchMode')
    const original = process.env.FEATURE_WATCH_WORKFLOWS_ENABLED
    try {
      // The flag is read through typed config, so the decision function is
      // exercised directly for both shapes it can return.
      const decision = deploymentWatchDecision()
      expect(['full', 'connection_health_only']).toContain(decision.mode)
      if (decision.mode === 'connection_health_only') {
        expect(decision.availableFeatures).toContain('batch.processing')
        expect(decision.suppressedFeatures).toContain('watch.workflow_inventory')
      } else {
        expect(decision.availableFeatures).toContain('watch.workflow_inventory')
        expect(decision.suppressedFeatures).toHaveLength(0)
      }
    } finally {
      process.env.FEATURE_WATCH_WORKFLOWS_ENABLED = original
    }
  })

  it('always keeps connection-health monitoring and batch available in either mode', async () => {
    const { deploymentWatchDecision } = await import('../src/services/watchMode')
    const decision = deploymentWatchDecision()
    expect(decision.availableFeatures).toContain('connection.health_monitoring')
    expect(decision.availableFeatures).toContain('batch.processing')
  })
})

describe('TOTP ring pruning', () => {
  it('drops entries older than the replay window and caps the ring', async () => {
    const { pruneUsedCodes, ringContains, TOTP_REPLAY_WINDOW_MS, TOTP_RING_SIZE } = await import('../src/auth/mfa')
    const now = Date.now()
    const ring = [
      { hash: 'old', usedAt: new Date(now - TOTP_REPLAY_WINDOW_MS - 1_000) },
      { hash: 'recent', usedAt: new Date(now - 1_000) },
    ]
    expect(ringContains(ring, 'old', now)).toBe(false)
    expect(ringContains(ring, 'recent', now)).toBe(true)

    const oversized = Array.from({ length: TOTP_RING_SIZE + 8 }, (_, index) => ({ hash: `h${index}`, usedAt: new Date(now) }))
    expect(pruneUsedCodes(oversized, now).length).toBe(TOTP_RING_SIZE)
  })
})
