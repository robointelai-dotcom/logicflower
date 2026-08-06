import { describe, expect, it } from 'vitest'
import { matchPathPattern, validateInternalTarget } from './router'

describe('same-origin router', () => {
  it('matches exact paths and decodes bounded parameters', () => {
    expect(matchPathPattern('/workflows/:id/builder', '/workflows/abc-123/builder')).toEqual({ matched: true, params: { id: 'abc-123' } })
    expect(matchPathPattern('/workflows/:id/builder', '/workflows/abc-123')).toEqual({ matched: false, params: {} })
    expect(matchPathPattern('/workflows/:id/builder', '/workflows/%2Fadmin/builder').matched).toBe(false)
  })

  it('rejects cross-origin and backslash navigation targets', () => {
    const origin = 'https://app.logicflower.example'
    expect(validateInternalTarget('/workflows?status=draft', origin)).toBe('/workflows?status=draft')
    for (const unsafe of ['https://evil.example', '//evil.example/path', '/\\evil.example/path', '/%5cevil.example/path', 'javascript:alert(1)']) {
      expect(() => validateInternalTarget(unsafe, origin)).toThrow()
    }
  })
})
