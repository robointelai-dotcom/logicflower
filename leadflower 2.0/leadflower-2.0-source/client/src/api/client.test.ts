import { describe, expect, it } from 'vitest'
import { ApiError, errorMessage, normalizeList, unwrap } from './client'

describe('API response normalization', () => {
  it('unwraps nested data and normalizes MongoDB identifiers', () => {
    const result = normalizeList<{ _id: string; name: string }>({ data: { items: [{ _id: 'wf_123', name: 'Welcome' }], total: 1 } })
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({ id: 'wf_123', name: 'Welcome' })
  })

  it('accepts direct arrays and alternate collection keys', () => {
    expect(normalizeList({ rows: [{ id: 'one' }] }).items).toHaveLength(1)
    expect(normalizeList([{ uuid: 'two' }]).items[0]?.id).toBe('two')
  })

  it('unwraps result envelopes recursively', () => {
    expect(unwrap<{ ok: boolean }>({ result: { data: { ok: true } } })).toEqual({ ok: true })
  })

  it('includes the correlation reference in user-facing errors', () => {
    expect(errorMessage(new ApiError('Request failed', 500, 'INTERNAL', undefined, 'corr-42'))).toBe('Request failed Reference: corr-42')
  })
})
