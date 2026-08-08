import { NextFunction, Request, Response } from 'express'
import { MembershipRole } from '../models/Membership'
import { sendProblem, problemType} from '../http/problem'

export function requireOrganization(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth?.organizationId || !req.auth.role) {
    sendProblem(req, res, { status: 403, title: 'Organization required', detail: 'Select an organization first', type: problemType('organization-required') })
    return
  }
  next()
}

export function requireRole(...allowedRoles: MembershipRole[]) {
  const allowed = new Set<MembershipRole>(allowedRoles)
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth?.organizationId || !req.auth.role) {
      sendProblem(req, res, { status: 403, title: 'Organization required', detail: 'Select an organization first', type: problemType('organization-required') })
      return
    }
    if (!allowed.has(req.auth.role)) {
      sendProblem(req, res, { status: 403, title: 'Insufficient role', detail: 'Your role cannot perform this action', type: problemType('insufficient-role') })
      return
    }
    next()
  }
}

export const canManageOrganization = requireRole('owner', 'admin')
export const canOperate = requireRole('owner', 'admin', 'operator')
export const canView = requireRole('owner', 'admin', 'operator', 'viewer', 'billing', 'customer')
export const canManageBilling = requireRole('owner', 'billing')
