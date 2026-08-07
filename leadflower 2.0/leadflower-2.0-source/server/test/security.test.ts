import { describe, expect, it } from 'vitest'
import { decryptJson, decryptString, encryptJson, encryptString } from '../src/security/encryption'
import { hashPassword, validatePasswordStrength, verifyPassword } from '../src/security/password'
import { parseEnv } from '../src/env'
import { signAccessToken, verifyAccessToken } from '../src/auth/jwt'

describe('environment validation', () => {
  const valid = {
    NODE_ENV: 'production',
    MONGO_URI: 'mongodb://database:27017/logicflower',
    REDIS_URL: 'redis://redis:6379',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    ENCRYPTION_KEY: 'ab'.repeat(32),
    COOKIE_SECURE: 'true',
    CORS_ORIGINS: 'https://app.logicflower.com',
    SMTP_HOST: 'smtp.example.com',
  }

  it('accepts a production-safe environment', () => {
    expect(parseEnv(valid as NodeJS.ProcessEnv).NODE_ENV).toBe('production')
  })

  it('rejects weak secrets, insecure cookies, wildcard CORS, and absent SMTP', () => {
    expect(() => parseEnv({ ...valid, JWT_ACCESS_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/JWT_ACCESS_SECRET/)
    expect(() => parseEnv({ ...valid, COOKIE_SECURE: 'false' } as NodeJS.ProcessEnv)).toThrow(/COOKIE_SECURE/)
    expect(() => parseEnv({ ...valid, CORS_ORIGINS: '*' } as NodeJS.ProcessEnv)).toThrow(/Wildcard CORS/)
    const { SMTP_HOST: _removed, ...withoutSmtp } = valid
    expect(() => parseEnv(withoutSmtp as NodeJS.ProcessEnv)).toThrow(/SMTP_HOST/)
  })
})

describe('authenticated encryption', () => {
  it('round-trips JSON, uses random nonces, and binds associated data', () => {
    const first = encryptJson({ accessToken: 'secret', count: 2 }, 'tenant:a')
    const second = encryptJson({ accessToken: 'secret', count: 2 }, 'tenant:a')
    expect(first).not.toBe(second)
    expect(decryptJson(first, 'tenant:a')).toEqual({ accessToken: 'secret', count: 2 })
    expect(() => decryptString(first, 'tenant:b')).toThrow()
  })

  it('detects ciphertext tampering', () => {
    const encrypted = encryptString('sensitive', 'record:1')
    const replacement = encrypted.endsWith('A') ? 'B' : 'A'
    expect(() => decryptString(encrypted.slice(0, -1) + replacement, 'record:1')).toThrow()
  })
})

describe('password and access-token security', () => {
  it('enforces password complexity and verifies only the correct password', async () => {
    expect(validatePasswordStrength('weak')).not.toHaveLength(0)
    const hash = await hashPassword('Correct-Horse-42!')
    expect(hash).not.toContain('Correct-Horse-42!')
    await expect(verifyPassword('Correct-Horse-42!', hash)).resolves.toBe(true)
    await expect(verifyPassword('Wrong-Horse-42!', hash)).resolves.toBe(false)
  })

  it('signs bounded access tokens with the expected identity and session', () => {
    const token = signAccessToken({
      userId: '507f1f77bcf86cd799439011',
      sessionId: '507f191e810c19729de860ea',
      organizationId: '507f1f77bcf86cd799439012',
    })
    const claims = verifyAccessToken(token)
    expect(claims.sub).toBe('507f1f77bcf86cd799439011')
    expect(claims.sid).toBe('507f191e810c19729de860ea')
    expect(claims.org).toBe('507f1f77bcf86cd799439012')
    expect(claims.type).toBe('access')
  })
})
