import { Request } from 'express'

export function organizationIdFrom(req: Request): string {
  if (!req.auth?.organizationId) throw new Error('Authenticated organization context is required')
  return req.auth.organizationId
}

export function tenantFilter(req: Request, additional: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...additional, organizationId: organizationIdFrom(req) }
}

export function tenantDocument<T extends Record<string, unknown>>(req: Request, input: T): Omit<T, 'organizationId'> & { organizationId: string } {
  const { organizationId: _ignored, ...safe } = input
  return { ...safe, organizationId: organizationIdFrom(req) }
}
