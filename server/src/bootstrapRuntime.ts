import './loadEnv'
import { hydrateSecrets } from './config/secretStore'

/**
 * Runtime bootstrap that must complete before typed configuration is read.
 *
 * `env.ts` parses and freezes configuration at import time, so secrets have to
 * be in `process.env` before anything imports it. Entry points therefore call
 * this first and then dynamically import the rest of the application.
 *
 * Returns the resolved report so the caller can log which names were applied.
 * Values are never returned or logged.
 */
export async function bootstrapRuntime(): Promise<{
  secrets: { store: string; reference: string | null; applied: string[]; skipped: string[] }
  keyring: { provider: string; versions: number[]; activeVersion: number }
}> {
  const secrets = await hydrateSecrets()

  // Imported only after secrets are present, so KMS settings resolved from the
  // store are visible to the typed configuration.
  const { initialiseKeyring } = await import('./security/keyring')
  const keyring = await initialiseKeyring()

  return { secrets, keyring }
}
