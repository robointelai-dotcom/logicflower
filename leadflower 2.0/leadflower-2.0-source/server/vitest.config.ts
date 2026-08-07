import { defineConfig } from 'vitest/config'

process.env.NODE_ENV = 'test'
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/logicflower_test'
process.env.REDIS_URL = 'redis://127.0.0.1:6379/15'
process.env.JWT_ACCESS_SECRET = 'test-access-secret-at-least-thirty-two-characters'
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-thirty-two-characters'
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests need MongoDB and Redis and are run by the separate
    // `test:integration` project. Including them here would let a developer
    // without those dependencies see a green unit run that silently skipped
    // the isolation suite.
    exclude: ['test/integration/**'],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 10_000,
  },
})
