import { HttpError, problemType} from '../../http/problem'
import { redis } from '../redisClient'
import type { ConnectorProvider, ConnectorRequest, ConnectorResponse, ConnectorTransport } from './types'

const RATE_LIMITS: Readonly<Record<ConnectorProvider, number>> = Object.freeze({
  ghl: 90,
  hubspot: 90,
  klaviyo: 60,
  activecampaign: 60,
  google: 60,
  generic: 30,
})

const RATE_SCRIPT = `
local value = redis.call('INCR', KEYS[1])
if value == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return { value, ttl }
`

const FAILURE_SCRIPT = `
local failures = redis.call('INCR', KEYS[1])
if failures == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if failures >= tonumber(ARGV[2]) then redis.call('SET', KEYS[2], '1', 'EX', ARGV[3]) end
return failures
`

export interface ConnectorSafetyStore {
  executeLua(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
  get(key: string): Promise<string | null>
  del(...keys: string[]): Promise<unknown>
}

const redisSafetyStore: ConnectorSafetyStore = {
  executeLua: (script, numberOfKeys, ...args) => redis.eval(script, numberOfKeys, ...args),
  get: (key) => redis.get(key),
  del: (...keys) => redis.del(...keys),
}

function safeKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
}

export function providerRequestLimit(provider: ConnectorProvider): number {
  return RATE_LIMITS[provider]
}

export class PolicyConnectorTransport implements ConnectorTransport {
  private readonly scope: string

  constructor(
    private readonly inner: ConnectorTransport,
    input: { organizationId: string; connectionId: string; provider: ConnectorProvider },
    private readonly store: ConnectorSafetyStore = redisSafetyStore,
  ) {
    this.scope = `${safeKeyPart(input.organizationId)}:${safeKeyPart(input.connectionId)}:${safeKeyPart(input.provider)}`
    this.provider = input.provider
  }

  private readonly provider: ConnectorProvider

  async request<T = any>(request: ConnectorRequest): Promise<ConnectorResponse<T>> {
    const rateKey = `lf:provider-rate:${this.scope}`
    const failureKey = `lf:provider-failures:${this.scope}`
    const openKey = `lf:provider-circuit:${this.scope}`
    try {
      if (await this.store.get(openKey)) {
        throw new HttpError(503, 'Provider circuit open', 'This provider connection is temporarily paused after repeated failures', problemType('provider-circuit-open'), true)
      }
      const [used, ttl] = await this.store.executeLua(RATE_SCRIPT, 1, rateKey, 60_000) as [number, number]
      const limit = providerRequestLimit(this.provider)
      if (Number(used) > limit) {
        throw new HttpError(429, 'Provider rate limit reached', `This connection reached its safe provider request budget; retry in ${Math.max(1, Math.ceil(Number(ttl) / 1_000))} seconds`, problemType('provider-rate-limit'), true)
      }
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (request.method !== 'GET') {
        throw new HttpError(503, 'Provider safety unavailable', 'External writes are paused because distributed provider rate enforcement is unavailable', problemType('provider-safety-unavailable'), true)
      }
    }

    try {
      const response = await this.inner.request<T>(request)
      await this.store.del(failureKey, openKey).catch(() => undefined)
      return response
    } catch (error: any) {
      if (!(error instanceof HttpError)) {
        const status = Number(error?.response?.status || error?.status || 0)
        if (!status || status === 408 || status === 429 || status >= 500) {
          await this.store.executeLua(FAILURE_SCRIPT, 2, failureKey, openKey, 120, 5, 60).catch(() => undefined)
        }
      }
      throw error
    }
  }
}
