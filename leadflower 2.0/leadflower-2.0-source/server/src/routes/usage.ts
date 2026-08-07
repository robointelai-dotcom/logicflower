import { Router } from 'express'
import UsageRecord from '../models/UsageRecord'
import { asyncHandler, HttpError } from '../http/problem'
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor'
import { requireRole } from '../middleware/rbac'
import { currentUsageEntitlement } from '../services/entitlements'

const router = Router()
router.use(requireRole('owner', 'admin', 'billing'))

router.get('/', asyncHandler(async (req, res) => {
  const organizationId = req.auth!.organizationId!
  const entitlement = await currentUsageEntitlement(organizationId)
  const end = req.query.end ? new Date(String(req.query.end)) : new Date()
  const start = req.query.start ? new Date(String(req.query.start)) : new Date(end.getTime() - 30 * 86_400_000)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new HttpError(400, 'Invalid date range', 'start and end must define a valid ascending date range')
  }
  if (end.getTime() - start.getTime() > 366 * 86_400_000) throw new HttpError(400, 'Date range too large', 'Usage queries are limited to 366 days')
  const summary = await UsageRecord.aggregate([
    { $match: { organizationId: new (require('mongoose').Types.ObjectId)(organizationId), occurredAt: { $gte: start, $lt: end } } },
    { $group: { _id: '$metric', quantity: { $sum: '$quantity' } } },
    { $sort: { _id: 1 } },
  ])
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  const query: Record<string, unknown> = { organizationId, occurredAt: { $gte: start, $lt: end } }
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await UsageRecord.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    period: { start, end },
    entitlement,
    summary: Object.fromEntries(summary.map((row: any) => [row._id, row.quantity])),
    items: rows.slice(0, limit),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

export default router
