import crypto from 'crypto'
import { env } from '../env'
import { activeKeyVersion, keyForVersion } from './keyring'

/**
 * Record-level encryption.
 *
 * Two envelope formats coexist:
 *
 *   v1.<iv>.<tag>.<ciphertext>            legacy, keyed directly on ENCRYPTION_KEY
 *   v2.<keyVersion>.<iv>.<tag>.<ciphertext>  envelope, keyed on a versioned data key
 *
 * v1 remains readable forever. Dropping it would strand every credential
 * written before the upgrade, and a migration that requires downtime to read
 * existing data is not a zero-downtime migration.
 *
 * Writes always use v2 with the currently active key version, so rotation
 * takes effect immediately for new data while old data stays readable under
 * its original version.
 */

const LEGACY_VERSION = 'v1'
const ENVELOPE_VERSION = 'v2'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

function legacyKey(): Buffer {
  return Buffer.from(env.ENCRYPTION_KEY, 'hex')
}

function seal(plainText: string, associatedData: string, key: Buffer, version: number): string {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  // The key version is bound into the AAD so a ciphertext cannot be relabelled
  // as a different version and replayed against another key.
  cipher.setAAD(Buffer.from(`${associatedData}|kv=${version}`, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  return [
    ENVELOPE_VERSION,
    String(version),
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.')
}

function open(key: Buffer, aad: string, iv: string, tag: string, ciphertext: string): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
}

export function encryptString(plainText: string, associatedData = 'logicflower'): string {
  const version = activeKeyVersion()
  return seal(plainText, associatedData, keyForVersion(version), version)
}

export function decryptString(envelope: string, associatedData = 'logicflower'): string {
  const parts = String(envelope).split('.')

  if (parts[0] === ENVELOPE_VERSION) {
    const [, rawVersion, iv, tag, ciphertext] = parts
    const version = Number(rawVersion)
    if (!Number.isInteger(version) || version < 1 || !iv || !tag || !ciphertext) {
      throw new Error('Unsupported or malformed encrypted value')
    }
    return open(keyForVersion(version), `${associatedData}|kv=${version}`, iv, tag, ciphertext)
  }

  if (parts[0] === LEGACY_VERSION) {
    const [, iv, tag, ciphertext] = parts
    if (!iv || !tag || !ciphertext) throw new Error('Unsupported or malformed encrypted value')
    return open(legacyKey(), associatedData, iv, tag, ciphertext)
  }

  throw new Error('Unsupported or malformed encrypted value')
}

/** Key version a stored ciphertext was written under; 0 means the legacy format. */
export function envelopeKeyVersion(envelope: string): number {
  const parts = String(envelope).split('.')
  if (parts[0] === ENVELOPE_VERSION) return Number(parts[1]) || 0
  if (parts[0] === LEGACY_VERSION) return 0
  return -1
}

/** True when a ciphertext is not on the active key version and should be re-wrapped. */
export function needsRewrap(envelope: string): boolean {
  const version = envelopeKeyVersion(envelope)
  return version >= 0 && version !== activeKeyVersion()
}

/**
 * Re-wrap a ciphertext onto the active key version.
 *
 * Decrypt-then-encrypt under the same associated data. The plaintext exists in
 * memory only for the duration of the call and is never persisted or logged.
 */
export function rewrapString(envelope: string, associatedData = 'logicflower'): string {
  return encryptString(decryptString(envelope, associatedData), associatedData)
}

export function encryptJson<T>(value: T, associatedData = 'logicflower'): string {
  return encryptString(JSON.stringify(value), associatedData)
}

export function decryptJson<T>(envelope: string, associatedData = 'logicflower'): T {
  return JSON.parse(decryptString(envelope, associatedData)) as T
}
