import axios, { AxiosError, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios'
import type { Identifier, PageResult, UnknownRecord } from '../types'

export class ApiError extends Error {
  status: number
  code?: string
  details?: unknown
  correlationId?: string

  constructor(message: string, status = 0, code?: string, details?: unknown, correlationId?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.correlationId = correlationId
  }
}

function cookie(name: string): string | undefined {
  const prefix = `${encodeURIComponent(name)}=`
  return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length)
}

const apiBaseUrl = import.meta.env.VITE_API_BASE || '/api/v1'

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
export const api = axios.create({
  baseURL: apiBaseUrl,
  timeout: 30_000,
  withCredentials: true,
  headers: { Accept: 'application/json' },
})

api.interceptors.request.use((config) => {
  const method = (config.method ?? 'get').toLowerCase()
  if (!['get', 'head', 'options'].includes(method)) {
    const token = cookie('lf_csrf')
    if (token) config.headers.set('X-CSRF-Token', decodeURIComponent(token))
    if (!config.headers.has('Idempotency-Key')) config.headers.set('Idempotency-Key', generateIdempotencyKey())
  }
  return config
})

interface RetriableRequest extends InternalAxiosRequestConfig { _logicFlowerRetried?: boolean }
let refreshRequest: Promise<void> | null = null

function refreshSession(): Promise<void> {
  if (!refreshRequest) {
    // A stale-rotation retry is still the same logical mutation. Reuse the key
    // so the server can safely deduplicate it just as it does the original API
    // request after refresh.
    const idempotencyKey = generateIdempotencyKey()
    const attempt = () => {
      const csrf = cookie('lf_csrf')
      return axios.post(`${apiBaseUrl}/auth/refresh`, undefined, {
        withCredentials: true,
        headers: csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf), 'Idempotency-Key': idempotencyKey } : { 'Idempotency-Key': idempotencyKey },
      })
    }
    refreshRequest = attempt().catch(async (error: AxiosError<UnknownRecord>) => {
      const problemType = typeof error.response?.data?.type === 'string' ? error.response.data.type : ''
      if (error.response?.status !== 409 || !problemType.endsWith('/stale-refresh')) throw error
      await new Promise<void>((resolve) => window.setTimeout(resolve, 40 + Math.floor(Math.random() * 80)))
      await attempt()
    }).then(() => undefined).finally(() => { refreshRequest = null })
  }
  return refreshRequest
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<UnknownRecord>) => {
    const request = error.config as RetriableRequest | undefined
    const requestPath = request?.url ?? ''
    const canRefresh = error.response?.status === 401 && request && !request._logicFlowerRetried && !requestPath.includes('/auth/login') && !requestPath.includes('/auth/refresh')
    if (canRefresh) {
      request._logicFlowerRetried = true
      try { await refreshSession(); return api.request(request) }
      catch { window.dispatchEvent(new CustomEvent('logicflower:unauthorized')) }
    }
    const payload = error.response?.data
    const nestedError = payload?.error && typeof payload.error === 'object' && !Array.isArray(payload.error) ? payload.error as UnknownRecord : undefined
    const message =
      (typeof payload?.detail === 'string' && payload.detail) ||
      (typeof nestedError?.message === 'string' && nestedError.message) ||
      (typeof payload?.message === 'string' && payload.message) ||
      (typeof payload?.error === 'string' && payload.error) ||
      (error.code === 'ECONNABORTED' ? 'The request timed out. Please try again.' : error.message) ||
      'Something went wrong.'
    const code = typeof payload?.code === 'string' ? payload.code : typeof nestedError?.code === 'string' ? nestedError.code : undefined
    const correlationId = typeof payload?.correlationId === 'string' ? payload.correlationId : typeof payload?.traceId === 'string' ? payload.traceId : undefined
    const apiError = new ApiError(message, error.response?.status ?? 0, code, payload, correlationId)
    if (apiError.status === 401 && !canRefresh) window.dispatchEvent(new CustomEvent('logicflower:unauthorized'))
    return Promise.reject(apiError)
  },
)

export function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === 'object') {
    const record = payload as UnknownRecord
    if ('data' in record) return unwrap<T>(record.data)
    if ('result' in record) return unwrap<T>(record.result)
  }
  return payload as T
}

export function normalizeId<T extends UnknownRecord>(value: T): T & { id: Identifier } {
  const id = String(value.id ?? value._id ?? value.uuid ?? '')
  return { ...value, id }
}

export function normalizeList<T extends UnknownRecord>(payload: unknown, keys: string[] = []): PageResult<T & { id: Identifier }> {
  const root = unwrap<unknown>(payload)
  const record = root && typeof root === 'object' && !Array.isArray(root) ? root as UnknownRecord : undefined
  let raw: unknown = root
  for (const key of [...keys, 'items', 'records', 'rows', 'results']) {
    if (record && Array.isArray(record[key])) {
      raw = record[key]
      break
    }
  }
  const items = Array.isArray(raw) ? raw.filter((item): item is T => Boolean(item && typeof item === 'object')).map(normalizeId) : []
  const totalValue = record?.total ?? record?.count ?? items.length
  return {
    items,
    total: typeof totalValue === 'number' ? totalValue : Number(totalValue) || items.length,
    nextCursor: typeof record?.nextCursor === 'string' ? record.nextCursor : undefined,
  }
}

export async function getOne<T>(path: string, config?: AxiosRequestConfig): Promise<T> {
  const response = await api.get(path, config)
  const value = unwrap<T>(response.data)
  if (value && typeof value === 'object' && !Array.isArray(value)) return normalizeId(value as UnknownRecord) as T
  return value
}

export async function getList<T extends UnknownRecord>(path: string, keys: string[] = [], config?: AxiosRequestConfig): Promise<PageResult<T & { id: Identifier }>> {
  const response = await api.get(path, config)
  return normalizeList<T>(response.data, keys)
}

export async function send<T = UnknownRecord>(method: 'post' | 'put' | 'patch' | 'delete', path: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const response = await api.request({ ...config, method, url: path, data: body })
  if (response.status === 204 || response.data === undefined || response.data === '') return undefined as T
  const value = unwrap<T>(response.data)
  if (value && typeof value === 'object' && !Array.isArray(value)) return normalizeId(value as UnknownRecord) as T
  return value
}

export async function download(path: string, suggestedName: string): Promise<void> {
  const response = await api.get<Blob>(path, { responseType: 'blob' })
  const url = URL.createObjectURL(response.data)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = suggestedName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.correlationId) return `${error.message} Reference: ${error.correlationId}`
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}
