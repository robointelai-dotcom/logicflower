import crypto from 'crypto'

/**
 * Key-management provider abstraction.
 *
 * The provider wraps and unwraps *data keys*. It is never asked to encrypt
 * application payloads directly, for two reasons: a KMS call per record would
 * make every encryption site asynchronous and network-dependent, and KMS
 * payload limits are far below the size of the objects being protected.
 *
 * Data keys are unwrapped once and cached in the keyring, so record-level
 * encryption stays synchronous and local.
 */
export interface WrappedDataKey {
  keyId: string
  /** The data key encrypted under the provider's master key, base64. */
  wrapped: string
  /** Identifier of the master key that wrapped it, for audit and rotation. */
  masterKeyId: string
  createdAt: Date
}

export interface KmsProvider {
  readonly name: string
  /** Generate a fresh 256-bit data key and return both plaintext and wrapped forms. */
  generateDataKey(keyId: string): Promise<{ plaintext: Buffer; wrapped: WrappedDataKey }>
  unwrapDataKey(wrapped: WrappedDataKey): Promise<Buffer>
  /**
   * Synchronous unwrap where the provider supports it without I/O. Returns null
   * when the provider requires a network call, which forces explicit
   * initialisation at boot instead of a hidden blocking call at request time.
   */
  unwrapDataKeySync(wrapped: WrappedDataKey): Buffer | null
  describe(): Record<string, unknown>
}

/**
 * Local provider.
 *
 * Derives data keys deterministically from a root secret using HKDF, so no
 * external service is required in development, in tests, or in a self-hosted
 * deployment that has no KMS. Deterministic derivation means a wrapped key is
 * reproducible from the root secret and the key identifier, which is what
 * allows synchronous unwrap.
 *
 * This is a real cryptographic boundary, not a stub: the root secret never
 * encrypts a record directly, and compromising one data key does not reveal
 * the others. It is weaker than a hardware-backed KMS in exactly one respect —
 * the root secret is present in application memory — and that trade-off is why
 * `describe()` reports `hardwareBacked: false` and the readiness endpoint
 * surfaces the active provider.
 */
export class LocalKmsProvider implements KmsProvider {
  readonly name = 'local'
  private root: Buffer

  constructor(rootHex: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(rootHex)) throw new Error('Local KMS root key must be 64 hexadecimal characters')
    this.root = Buffer.from(rootHex, 'hex')
  }

  private derive(keyId: string): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256', this.root, Buffer.from('logicflower-datakey'), Buffer.from(keyId, 'utf8'), 32))
  }

  async generateDataKey(keyId: string) {
    const plaintext = this.derive(keyId)
    return {
      plaintext,
      wrapped: {
        keyId,
        // The wrapped form records the derivation contract rather than
        // ciphertext, because the key is reproducible from the root.
        wrapped: Buffer.from(`hkdf-sha256:${keyId}`, 'utf8').toString('base64'),
        masterKeyId: 'local-root',
        createdAt: new Date(),
      },
    }
  }

  async unwrapDataKey(wrapped: WrappedDataKey): Promise<Buffer> {
    const result = this.unwrapDataKeySync(wrapped)
    if (!result) throw new Error('Local KMS could not unwrap the data key')
    return result
  }

  unwrapDataKeySync(wrapped: WrappedDataKey): Buffer {
    return this.derive(wrapped.keyId)
  }

  describe() {
    return { provider: 'local', hardwareBacked: false, masterKeyId: 'local-root' }
  }
}

/**
 * AWS KMS provider.
 *
 * Uses GenerateDataKey / Decrypt. Unwrap is network-bound, so
 * `unwrapDataKeySync` returns null and the keyring must be initialised
 * explicitly during boot. That is deliberate: a synchronous call site silently
 * blocking on a network round trip is worse than a startup failure.
 */
export class AwsKmsProvider implements KmsProvider {
  readonly name = 'aws-kms'

  constructor(private masterKeyId: string, private region: string) {
    if (!masterKeyId) throw new Error('KMS_MASTER_KEY_ID is required for the aws-kms provider')
  }

  private async client() {
    const { KMSClient } = await import('@aws-sdk/client-kms')
    return new KMSClient({ region: this.region })
  }

  async generateDataKey(keyId: string) {
    const { GenerateDataKeyCommand } = await import('@aws-sdk/client-kms')
    const client = await this.client()
    const response = await client.send(new GenerateDataKeyCommand({
      KeyId: this.masterKeyId,
      KeySpec: 'AES_256',
      // Bound to the key identifier so a ciphertext blob cannot be replayed
      // under a different key slot.
      EncryptionContext: { application: 'logicflower', keyId },
    }))
    if (!response.Plaintext || !response.CiphertextBlob) throw new Error('AWS KMS returned an incomplete data key')
    return {
      plaintext: Buffer.from(response.Plaintext),
      wrapped: {
        keyId,
        wrapped: Buffer.from(response.CiphertextBlob).toString('base64'),
        masterKeyId: this.masterKeyId,
        createdAt: new Date(),
      },
    }
  }

  async unwrapDataKey(wrapped: WrappedDataKey): Promise<Buffer> {
    const { DecryptCommand } = await import('@aws-sdk/client-kms')
    const client = await this.client()
    const response = await client.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(wrapped.wrapped, 'base64'),
      EncryptionContext: { application: 'logicflower', keyId: wrapped.keyId },
    }))
    if (!response.Plaintext) throw new Error('AWS KMS returned an empty plaintext data key')
    return Buffer.from(response.Plaintext)
  }

  unwrapDataKeySync(): null {
    return null
  }

  describe() {
    return { provider: 'aws-kms', hardwareBacked: true, masterKeyId: this.masterKeyId, region: this.region }
  }
}
