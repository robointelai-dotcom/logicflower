import { Router } from 'express'
import { z } from 'zod'
import Organization from '../models/Organization'
import User from '../models/User'
import Membership from '../models/Membership'
import SupportAccessRequest from '../models/SupportAccessRequest'
import { asyncHandler, HttpError, parseBody } from '../http/problem'
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor'
import { requireAdminMfa, requirePlatformRole, requireRecentAuthentication } from '../middleware/platformAdmin'
import { requireIdempotency } from '../middleware/idempotency'
import { recordAudit } from '../services/audit'

const router = Router()
router.use(requirePlatformRole('admin', 'owner'))
router.use(requireAdminMfa)

router.get('/overview', asyncHandler(async (_req, res) => {
  const [organizations, users, memberships] = await Promise.all([
    Organization.countDocuments({ status: 'active' }),
    User.countDocuments({ status: 'active' }),
    // tenant-safe: platform-admin surface; deliberately spans all organisations and is MFA + platform-role gated
    Membership.countDocuments({ status: 'active' }),
  ])
  res.json({ organizations, users, memberships, supportImpersonationEnabled: false })
}))

router.get('/organizations', asyncHandler(async (req, res) => {
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  const query: Record<string, unknown> = {}
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await Organization.find(query).sort({ _id: -1 }).limit(limit + 1)
    .select('name slug status timezone createdAt onboardingCompletedAt').lean()
  const hasMore = rows.length > limit
  res.json({ items: rows.slice(0, limit), nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null })
}))

router.post('/organizations/:organizationId/support-access', requireRecentAuthentication, requireIdempotency, asyncHandler(async (req, res) => {
  const { reason } = parseBody(z.object({ reason: z.string().trim().min(10).max(1_000) }).strict(), req)
  const organization = await Organization.findOne({ _id: req.params.organizationId, status: 'active' }).select('_id name').lean()
  if (!organization) throw new HttpError(404, 'Organization not found', 'Active organization not found')
  const request = await SupportAccessRequest.create({
    organizationId: organization._id,
    requestedBy: req.auth!.userId,
    reason,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60 * 60_000),
    dataAccessEnabled: false,
  })
  await recordAudit({
    action: 'platform.support_access_requested', req, organizationId: String(organization._id),
    entityType: 'SupportAccessRequest', entityId: String(request._id), metadata: { reason },
  })
  res.status(202).json({
    request: { id: String(request._id), status: request.status, expiresAt: request.expiresAt, dataAccessEnabled: false },
    message: 'Organization-owner consent is required. This request does not grant data access or impersonation.',
  })
}))

export default router
