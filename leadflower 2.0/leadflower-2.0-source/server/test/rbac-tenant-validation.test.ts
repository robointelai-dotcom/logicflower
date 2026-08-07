import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { requireOrganization, requireRole } from '../src/middleware/rbac'
import { tenantDocument, tenantFilter } from '../src/middleware/tenant'
import { HttpError, parseBody } from '../src/http/problem'

function response() {
  const value: any = { statusCode: 200, body: undefined }
  value.status = vi.fn((status: number) => { value.statusCode = status; return value })
  value.type = vi.fn(() => value)
  value.json = vi.fn((body: unknown) => { value.body = body; return value })
  return value
}

function request(role?: any): any {
  return {
    body: {},
    auth: role ? {
      userId: 'u1', sessionId: 's1', organizationId: 'org-safe', role,
      platformRole: 'user', mfaEnabled: false,
    } : undefined,
  }
}

describe('RBAC', () => {
  it('allows only explicitly permitted roles', () => {
    const next = vi.fn()
    requireRole('owner', 'admin')(request('viewer'), response(), next)
    expect(next).not.toHaveBeenCalled()

    requireRole('owner', 'admin')(request('admin'), response(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('requires an authenticated organization context', () => {
    const next = vi.fn()
    const res = response()
    requireOrganization(request(), res, next)
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('tenant enforcement helpers', () => {
  it('always overwrites caller-supplied organizationId', () => {
    const req = request('owner')
    expect(tenantFilter(req, { organizationId: 'attacker-org', status: 'active' })).toEqual({
      organizationId: 'org-safe', status: 'active',
    })
    expect(tenantDocument(req, { organizationId: 'attacker-org', name: 'record' })).toEqual({
      organizationId: 'org-safe', name: 'record',
    })
  })

  it('fails closed without tenant context', () => {
    expect(() => tenantFilter(request(), {})).toThrow(/organization context/i)
  })
})

describe('request input validation', () => {
  const schema = z.object({ email: z.string().email(), amount: z.number().int().positive() }).strict()

  it('accepts valid typed input', () => {
    const req: any = { body: { email: 'owner@example.com', amount: 2 } }
    expect(parseBody(schema, req)).toEqual(req.body)
  })

  it('rejects unknown fields and incorrect types with a 400 HttpError', () => {
    const req: any = { body: { email: 'not-email', amount: '2', isAdmin: true } }
    try {
      parseBody(schema, req)
      throw new Error('expected validation error')
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).status).toBe(400)
      expect((error as HttpError).detail).toMatch(/email|amount|Unrecognized/)
    }
  })
})
