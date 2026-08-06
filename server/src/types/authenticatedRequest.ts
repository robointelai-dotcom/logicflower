/// <reference path="./express.d.ts" />
import { Request } from 'express';
export type AuthenticatedRequest = Request;

export function requireOrganizationId(req: AuthenticatedRequest): string {
  const organizationId = String(req.auth?.organizationId || '').trim();
  if (!organizationId) {
    const err: any = new Error('Authenticated organization context is required');
    err.statusCode = 401;
    err.code = 'ORGANIZATION_REQUIRED';
    throw err;
  }
  return organizationId;
}

export function requestCorrelationId(req: AuthenticatedRequest): string {
  return String(req.requestId || '').slice(0, 128);
}
