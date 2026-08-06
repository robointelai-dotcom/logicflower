import { bootstrapRuntime } from '../src/bootstrapRuntime'

/**
 * Re-wrap stored ciphertext onto the active data-key version.
 *
 * Rotation itself is already complete once ENCRYPTION_KEY_VERSION is raised and
 * the process restarts: new writes use the new key and old ciphertext keeps
 * decrypting under the version recorded in its own envelope. This job only
 * shortens the tail of data still protected by an older key, so it is safe to
 * interrupt, resume, or run twice.
 */
async function main(): Promise<void> {
  const runtime = await bootstrapRuntime()
  const { connectDB } = await import('../src/db')
  const { runKeyRotationRewrap, rotationBacklog } = await import('../src/services/keyRotation')
  const pino = (await import('../src/logger')).default

  await connectDB()
  pino.info({ provider: runtime.keyring.provider, activeVersion: runtime.keyring.activeVersion }, 'key re-wrap starting')

  const before = await rotationBacklog()
  const report = await runKeyRotationRewrap(Number(process.env.REWRAP_BATCH_SIZE || 500))
  const after = await rotationBacklog()

  pino.info({ report, before, after }, 'key re-wrap pass complete')
  if (!report.complete) {
    pino.info('records remain on an older key version; run this command again to continue')
  }
  process.exit(report.totals.failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('key re-wrap failed', error)
  process.exit(1)
})
