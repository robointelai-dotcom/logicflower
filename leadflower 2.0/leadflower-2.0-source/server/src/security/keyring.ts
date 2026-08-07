import crypto from 'crypto'
import { env } from '../env'
import { AwsKmsProvider, KmsProvider, LocalKmsProvider, WrappedDataKey } from './kms/kmsProvider'

/**
 * The keyring holds unwrapped data keys in memory, indexed by key version.
 *
 * Rotation is additive and therefore zero-downtime: a new version becomes the
 * active key for writes, while every prior version stays in the ring so
 * existing ciphertext keeps decrypting. Nothing needs to be re-encrypted for
 * the system to keep working; re-wrapping is a background convenience, not a
 * cutover.
 */

export interface KeyringEntry {
  version: number
  material: Buffer
  wrapped: WrappedDataKey
  retiredAt?: Date
}

let provider: KmsProvider | null = null
const entries = new Map<number, KeyringEntry>()
let activeVersion = 0
let initialised = false

export function keyIdFor(version: number): string {
  return `logicflower-data-key-v${version}`
}

export function kmsProvider(): KmsProvider {
  if (!provider) {
    provider = env.KMS_PROVIDER === 'aws-kms'
      ? new AwsKmsProvider(env.KMS_MASTER_KEY_ID || '', env.KMS_REGION)
      : new LocalKmsProvider(env.ENCRYPTION_KEY)
  }
  return provider
}

/** Test seam and rotation-script support. Production code does not call this. */
export function resetKeyring(): void {
  provider = null
  entries.clear()
  activeVersion = 0
  initialised = false
}

/**
 * Load every data key version up to the configured active version.
 *
 * Called explicitly during boot. For the AWS provider this is mandatory,
 * because unwrapping is a network operation and there is no safe synchronous
 * fallback. Failing here stops the process, which is the correct outcome: an
 * application that cannot decrypt its own credentials must not accept traffic.
 */
export async function initialiseKeyring(): Promise<{ provider: string; versions: number[]; activeVersion: number }> {
  const current = kmsProvider()
  const target = Math.max(1, env.ENCRYPTION_KEY_VERSION)
  for (let version = 1; version <= target; version += 1) {
    if (entries.has(version)) continue
    const { plaintext, wrapped } = await current.generateDataKey(keyIdFor(version))
    entries.set(version, { version, material: plaintext, wrapped })
  }
  activeVersion = target
  initialised = true
  return { provider: current.name, versions: [...entries.keys()].sort((a, b) => a - b), activeVersion }
}

/**
 * Resolve one key version, deriving it synchronously when the provider allows.
 *
 * The local provider derives deterministically, so tests and development need
 * no boot step. The AWS provider cannot, and a missing version raises an
 * explicit error rather than blocking on I/O inside a synchronous call.
 */
export function keyForVersion(version: number): Buffer {
  const existing = entries.get(version)
  if (existing) return existing.material

  const current = kmsProvider()
  const candidate: WrappedDataKey = {
    keyId: keyIdFor(version),
    wrapped: Buffer.from(`hkdf-sha256:${keyIdFor(version)}`, 'utf8').toString('base64'),
    masterKeyId: 'local-root',
    createdAt: new Date(),
  }
  const derived = current.unwrapDataKeySync(candidate)
  if (!derived) {
    throw new Error(
      `Data key version ${version} is not loaded and the ${current.name} provider cannot unwrap synchronously. `
      + 'Call initialiseKeyring() during startup.',
    )
  }
  entries.set(version, { version, material: derived, wrapped: candidate })
  if (!activeVersion) activeVersion = Math.max(1, env.ENCRYPTION_KEY_VERSION)
  return derived
}

export function activeKeyVersion(): number {
  return activeVersion || Math.max(1, env.ENCRYPTION_KEY_VERSION)
}

export function keyringStatus() {
  return {
    provider: kmsProvider().name,
    initialised,
    activeVersion: activeKeyVersion(),
    loadedVersions: [...entries.keys()].sort((a, b) => a - b),
    details: kmsProvider().describe(),
  }
}

/**
 * Add a new key version and make it active for subsequent writes.
 *
 * Old versions stay loaded, which is what makes the rotation non-breaking:
 * ciphertext written a second before the rotation still decrypts a second
 * after it.
 */
export async function rotateKeyring(): Promise<{ previousVersion: number; activeVersion: number }> {
  const previous = activeKeyVersion()
  const next = previous + 1
  const current = kmsProvider()
  const { plaintext, wrapped } = await current.generateDataKey(keyIdFor(next))
  entries.set(next, { version: next, material: plaintext, wrapped })
  const existing = entries.get(previous)
  if (existing) existing.retiredAt = new Date()
  activeVersion = next
  return { previousVersion: previous, activeVersion: next }
}

/** Constant-time helper shared by the envelope format. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}
