import { defineConfig } from 'vitest/config'

/**
 * Integration project.
 *
 * These tests drive the real mounted Express application against a real
 * MongoDB replica set and a real Redis. A replica set specifically: the usage
 * ledger requires transactions and fails closed without them, so a standalone
 * mongod would exercise a different code path from production and prove less
 * than it appears to.
 *
 * INTEGRATION_REQUIRED=1 (set in CI) turns an unavailable dependency into a
 * failure rather than a skip. Without that, a broken service container reads as
 * a passing build, which is the class of false-green this whole remediation is
 * about.
 */
process.env.NODE_ENV = 'test'
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379/15'
process.env.JWT_ACCESS_SECRET ||= 'test-access-secret-at-least-thirty-two-characters'
process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-at-least-thirty-two-characters'
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
process.env.COOKIE_SECURE = 'false'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.integration.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 120_000,
    hookTimeout: 240_000,
    // A shared MongoMemoryReplSet and a single Express app cannot be safely
    // shared across parallel workers.
    fileParallelism: false,
  },
})
