import './loadEnv'
import http from 'http'
import mongoose from 'mongoose'
import { createApp } from './app'
import { connectDB } from './db'
import { env } from './env'
import pino from './logger'
import { closeQueues } from './queue'
import { redis } from './services/redisClient'
import { restorePublishedSchedules } from './services/scheduleReconciler'

async function main(): Promise<void> {
  // Secrets are hydrated and data keys unwrapped before anything serves
  // traffic. A process that cannot decrypt its own credentials must fail at
  // startup rather than accept requests and error per record.
  const { bootstrapRuntime } = await import('./bootstrapRuntime')
  const runtime = await bootstrapRuntime()
  pino.info({
    secretStore: runtime.secrets.store,
    secretsApplied: runtime.secrets.applied.length,
    kmsProvider: runtime.keyring.provider,
    activeKeyVersion: runtime.keyring.activeVersion,
  }, 'runtime bootstrap complete')

  await connectDB()
  const scheduleResult = await restorePublishedSchedules()
  pino.info(scheduleResult, 'schedule reconciliation complete')

  const server = http.createServer(createApp())
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000
  server.requestTimeout = 30_000

  await new Promise<void>((resolve) => server.listen(env.PORT, resolve))
  pino.info({ port: env.PORT }, 'LogicFlower API listening')

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    pino.info({ signal }, 'API shutdown started')
    const forced = setTimeout(() => {
      pino.fatal('API graceful shutdown timed out')
      process.exit(1)
    }, 30_000)
    forced.unref()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await Promise.allSettled([closeQueues(), redis.quit(), mongoose.disconnect()])
    clearTimeout(forced)
    pino.info('API shutdown complete')
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error) => {
  pino.fatal({ err: error }, 'API startup failed')
  process.exit(1)
})
