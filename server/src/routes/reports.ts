import { Router } from 'express';
import Execution from '../models/Execution';
import BatchJob from '../models/BatchJob';
import Incident from '../models/Incident';
import WorkflowSnapshot from '../models/WorkflowSnapshot';
import GeneratedReport from '../models/GeneratedReport';
import { requireOrganizationId } from '../types/authenticatedRequest';
import { HttpError } from '../http/problem';
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor';
const router = Router(); const asyncRoute = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
async function dashboard(organizationId: string, periodStart = new Date(Date.now() - 30 * 86400_000), periodEnd = new Date()) {
  const [executions, failedExecutions, batches, processedRecords, failedRecords, openIncidents, snapshots] = await Promise.all([
    Execution.countDocuments({ organizationId, createdAt: { $gte: periodStart, $lte: periodEnd } }),
    Execution.countDocuments({ organizationId, status: 'failed', createdAt: { $gte: periodStart, $lte: periodEnd } }),
    BatchJob.countDocuments({ organizationId, createdAt: { $gte: periodStart, $lte: periodEnd } }),
    BatchJob.aggregate([{ $match: { organizationId, createdAt: { $gte: periodStart, $lte: periodEnd } } }, { $group: { _id: null, count: { $sum: '$stats.succeeded' } } }]),
    BatchJob.aggregate([{ $match: { organizationId, createdAt: { $gte: periodStart, $lte: periodEnd } } }, { $group: { _id: null, count: { $sum: '$stats.failed' } } }]),
    Incident.countDocuments({ organizationId, status: { $ne: 'resolved' } }), WorkflowSnapshot.countDocuments({ organizationId, capturedAt: { $gte: periodStart, $lte: periodEnd } }),
  ]);
  return { periodStart, periodEnd, executions, successfulExecutions: executions - failedExecutions, failedExecutions, successRate: executions ? (executions - failedExecutions) / executions : 1, batches, processedRecords: processedRecords[0]?.count || 0, failedRecords: failedRecords[0]?.count || 0, openIncidents, snapshots };
}
router.get('/dashboard', asyncRoute(async (req: any, res: any) => res.json(await dashboard(requireOrganizationId(req), req.query.from ? new Date(String(req.query.from)) : undefined, req.query.to ? new Date(String(req.query.to)) : undefined))));
router.get('/', asyncRoute(async (req: any, res: any) => { const limit = pageLimit(req.query.limit); const cursor = decodeCursor(req.query.cursor); const query: any = { organizationId: requireOrganizationId(req) }; if (cursor) query._id = { $lt: cursor }; const rows: any[] = await GeneratedReport.find(query).sort({ _id: -1 }).limit(limit + 1).lean(); const hasMore = rows.length > limit; res.json({ items: rows.slice(0, limit), nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null }); }));
router.post('/', asyncRoute(async (req: any, res: any) => { const organizationId = requireOrganizationId(req); const periodStart = req.body?.periodStart ? new Date(req.body.periodStart) : new Date(Date.now() - 30 * 86400_000); const periodEnd = req.body?.periodEnd ? new Date(req.body.periodEnd) : new Date(); const data = await dashboard(organizationId, periodStart, periodEnd); const report = await GeneratedReport.create({ organizationId, type: req.body?.type || 'health', periodStart, periodEnd, status: 'ready', data, generatedAt: new Date() }); res.status(201).json(report); }));
router.get('/:id', asyncRoute(async (req: any, res: any) => { const report = await GeneratedReport.findOne({ _id: req.params.id, organizationId: requireOrganizationId(req) }).lean(); if (!report) throw new HttpError(404, 'Report not found', 'Report not found'); res.json(report); }));
export default router;
