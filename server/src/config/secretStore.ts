/**
 * Runtime secret loading.
 *
 * Chapter 21.2 requires a managed secret store and no secrets in environment
 * files. This module resolves secrets before the typed configuration is parsed,
 * so the rest of the application keeps reading `env.*` and nothing downstream
 * needs to know where a value came from.
 *
 * The adapter contract is deliberately narrow: fetch a named bundle, return a
 * flat map. Anything richer would tempt call sites into fetching secrets
 * lazily at request time, which turns a credential-store outage into a
 * partial, confusing failure instead of a clean startup failure.
 *
 * Ordering rule: a value already present in the real process environment wins
 * over the store. That keeps container-level overrides and local development
 * working, and it means a broken store cannot silently replace a known-good
 * credential.
 */

export interface SecretStore {
  readonly name: string
  load(reference: string): Promise<Record<string, string>>
}

/** Default. Reads nothing; the process environment is already populated. */
export class EnvironmentSecretStore implements SecretStore {
  readonly name = 'environment'
  async load(): Promise<Record<string, string>> {
    return {}
  }
}

/** AWS Secrets Manager. The reference is a secret id or ARN holding flat JSON. */
export class AwsSecretsManagerStore implements SecretStore {
  readonly name = 'aws-secrets-manager'
  constructor(private region: string) {}

  async load(reference: string): Promise<Record<string, string>> {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager')
    const client = new SecretsManagerClient({ region: this.region })
    const response = await client.send(new GetSecretValueCommand({ SecretId: reference }))
    const payload = response.SecretString
      || (response.SecretBinary ? Buffer.from(response.SecretBinary).toString('utf8') : '')
    if (!payload) throw new Error(`Secret ${reference} is empty`)
    return flatten(JSON.parse(payload), reference)
  }
}

/**
 * HashiCorp Vault KV v2 over HTTP.
 *
 * Implemented with fetch rather than a Vault SDK to avoid adding a dependency
 * for one request shape. The token comes from the environment because
 * something has to bootstrap trust; that is the one credential a secret store
 * cannot supply for itself.
 */
export class VaultSecretStore implements SecretStore {
  readonly name = 'vault'
  constructor(private address: string, private token: string, private mount = 'secret') {
    if (!address) throw new Error('VAULT_ADDR is required for the vault secret store')
    if (!token) throw new Error('VAULT_TOKEN is required for the vault secret store')
  }

  async load(reference: string): Promise<Record<string, string>> {
    const url = new URL(`/v1/${this.mount}/data/${reference.replace(/^\/+/, '')}`, this.address)
    const response = await fetch(url.toString(), {
      headers: { 'X-Vault-Token': this.token, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Vault returned HTTP ${response.status} for ${reference}`)
    const body: any = await response.json()
    const data = body?.data?.data
    if (!data || typeof data !== 'object') throw new Error(`Vault secret ${reference} did not contain a data object`)
    return flatten(data, reference)
  }
}

function flatten(value: unknown, reference: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Secret ${reference} must be a flat JSON object of string values`)
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || entry === undefined) continue
    if (typeof entry === 'object') {
      throw new Error(`Secret ${reference} key ${key} is nested; only flat string values are supported`)
    }
    result[key] = String(entry)
  }
  return result
}

export function secretStoreFromEnvironment(): SecretStore {
  const driver = String(process.env.SECRET_STORE_DRIVER || 'environment').toLowerCase()
  if (driver === 'aws-secrets-manager') return new AwsSecretsManagerStore(process.env.AWS_REGION || process.env.KMS_REGION || 'us-east-1')
  if (driver === 'vault') return new VaultSecretStore(process.env.VAULT_ADDR || '', process.env.VAULT_TOKEN || '', process.env.VAULT_MOUNT || 'secret')
  return new EnvironmentSecretStore()
}

/**
 * Populate process.env from the configured store.
 *
 * Must run before `env.ts` is imported, because that module parses and freezes
 * configuration at import time. Callers therefore use a dynamic import of the
 * application after awaiting this.
 */
export async function hydrateSecrets(options: { reference?: string; store?: SecretStore } = {}): Promise<{
  store: string
  reference: string | null
  applied: string[]
  skipped: string[]
}> {
  const store = options.store || secretStoreFromEnvironment()
  const reference = options.reference || process.env.SECRET_STORE_REFERENCE || null

  if (store.name === 'environment' || !reference) {
    return { store: store.name, reference, applied: [], skipped: [] }
  }

  const secrets = await store.load(reference)
  const applied: string[] = []
  const skipped: string[] = []
  for (const [key, value] of Object.entries(secrets)) {
    if (process.env[key] !== undefined && process.env[key] !== '') {
      // An explicit environment value outranks the store, so a container-level
      // override is never silently replaced by a stale stored secret.
      skipped.push(key)
      continue
    }
    process.env[key] = value
    applied.push(key)
  }
  // Names only. Values are never logged or returned.
  return { store: store.name, reference, applied: applied.sort(), skipped: skipped.sort() }
}
