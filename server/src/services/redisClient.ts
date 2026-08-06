import Redis from 'ioredis'
import { env } from '../env'

export const redis = new Redis(env.REDIS_URL)
// Consumers expose dependency failures through readiness and fail closed for
// mutations. Registering a listener also prevents Node from treating a routine
// Redis outage as an unhandled EventEmitter error.
redis.on('error', () => undefined)
