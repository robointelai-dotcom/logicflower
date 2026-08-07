import crypto from 'crypto';
import { Router } from 'express';
import Workflow from '../models/Workflow';
import WorkflowVersion from '../models/WorkflowVersion';
import Execution from '../models/Execution';
import Schedule from '../models/Schedule';
import { workflowQueue } from '../queue';
import { assertSafeWorkflowDraft, assertValidWorkflowGraph, canonicalizeWorkflowDefinition, validateWorkflowGraph } from '../services/workflowValidation';
import { AuthenticatedRequest, requireOrganizationId, requestCorrelationId } from '../types/authenticatedRequest';
import { canonicalJson, definitionHash } from '../services/canonicalJson';
import { recordAudit } from '../services/audit';
import { assertUsageAvailable } from '../services/entitlements';
import { dryRunWorkflow } from '../services/workflowDryRun';
import { encryptJson } from '../security/encryption';
import WorkflowDryRunApproval from '../models/WorkflowDryRunApproval';
import { HttpError } from '../http/problem';
import { assertWorkflowResources } from '../services/workflowResources';
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor';

const router = Router();
const asyncRoute = (handler: any) => (req: any, res: any, next: any) => Promise.resolve(handler(req, res, next)).catch(next);

async function removeSchedules(organizationId: string, workflowId: string) {
  const rows: any[] = await Schedule.find({ organizationId, workflowId });
  for (const row of rows) if (row.jobName) {
    try { await workflowQueue.removeRepeatable('run', { pattern: String(row.cron), jobId: String(row.jobName) }); } catch { /* already absent */ }
  }
  await Schedule.deleteMany({ organizationId, workflowId });
}

function scheduleJobId(organizationId: string, workflowId: string, nodeId: string) {
  const nodeHash = crypto.createHash('sha256').update(nodeId).digest('hex').slice(0, 16);
  return `schedule-${organizationId}-${workflowId}-${nodeHash}`;
}

async function syncSchedules(workflow: any) {
  const organizationId = String(workflow.organizationId);
  await removeSchedules(organizationId, String(workflow._id));
  if (workflow.status !== 'published') return;
  for (const node of workflow.nodes || []) {
    if (node?.data?.kind !== 'trigger.schedule') continue;
    const cron = String(node?.data?.config?.cron || '').trim();
    const timezone = String(node?.data?.config?.timezone || 'UTC');
    // Same shape and same reasoning as workflowValidation: the field class and
    // `\s` are disjoint, so matching is linear (verified at 200k characters).
    // The length bound is defence in depth.
    // eslint-disable-next-line security/detect-unsafe-regex -- disjoint classes; bounded above
    if (!cron || cron.length > 200 || !/^([\d*/?,\-]+\s+){4,5}[\d*/?,\-]+$/.test(cron)) throw new Error(`Schedule trigger ${node.id} requires a valid 5- or 6-field cron expression`);
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { throw new Error(`Schedule trigger ${node.id} has an invalid timezone`); }
    const jobName = scheduleJobId(organizationId, String(workflow._id), String(node.id));
    await workflowQueue.add('run', {
      organizationId, workflowId: String(workflow._id), startNodeId: String(node.id), triggerKind: 'trigger.schedule',
      correlationId: crypto.randomUUID(), payload: {},
    }, { jobId: jobName, repeat: { pattern: cron, tz: timezone }, attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 });
    await Schedule.create({ organizationId, workflowId: workflow._id, nodeId: String(node.id), cron, timezone, enabled: true, jobName });
  }
}

router.get('/', asyncRoute(async (req: AuthenticatedRequest, res: any) => {
  const organizationId = requireOrganizationId(req);
  const limit = pageLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const query: any = { organizationId };
  if (req.query.status) query.status = String(req.query.status);
  if (cursor) query._id = { $lt: cursor };
  const [rows, total] = await Promise.all([
    Workflow.find(query).sort({ _id: -1 }).limit(limit + 1).lean(), Workflow.countDocuments({ organizationId, ...(req.query.status ? { status: String(req.query.status) } : {}) }),
  ]);
  const hasMore = rows.length > limit;
  res.json({ items: rows.slice(0, limit), limit, total, nextCursor: hasMore ? encodeCursor(rows[limit - 1]!._id) : null });
}));

router.post('/validate', asyncRoute(async (req: AuthenticatedRequest, res: any) => {
  requireOrganizationId(req);
  const definition = canonicalizeWorkflowDefinition(req.body || {}, { allowLegacy: req.body?.migrationMode === 'legacy-v1' });
  res.json(validateWorkflowGraph(definition));
}));

router.post('/', asyncRoute(async (req: AuthenticatedRequest, res: any) => {
  const organizationId = requireOrganizationId(req);
  const definition: any = canonicalizeWorkflowDefinition(req.body || {}, { allowLegacy: req.body?.migrationMode === 'legacy-v1' });
  assertSafeWorkflowDraft(definition);
  await assertWorkflowResources({ organizationId, workflow: definition });
  const workflow: any = await Workflow.create({ organizationId, name: String(req.body?.name || 'Untitled Workflow').slice(0, 160), description: String(req.body?.description || '').trim().slice(0, 2_000), status: 'draft', nodes: definition.nodes, edges: definition.edges, createdBy: req.auth?.userId });
  await WorkflowVersion.create({ organizationId, workflowId: workflow._id, version: 1, snapshot: workflow.toObject(), comment: 'Initial canonical version' });
  res.status(201).json(workflow);
}));

router.get('/:id', asyncRoute(async (req: AuthenticatedRequest, res: any) => {
  const workflow = await Workflow.findOne({ _id: req.params.id, organizationId: requireOrganizationId(req) });
  if (!workflow) throw new HttpError(404, 'Workflow not found', 'Workflow not found');
  res.json(workflow);
}));

router.get('/:id/versions', asyncRoute(async (req: AuthenticatedRequest, res: any) => {
  const organizationId = requireOrganizationId(req);
  if (!await Workflow.exists({ _id: req.params.id, organizationId })) throw new HttpError(404, 'Workflow not found', 'Workflow not found');
  const limit = pageLimit(req.query.limit); const cursor = decodeCursor(req.query.cursor);
  const query: any = { organizationId, workflowId: req.params.id }; if (cursor) query._id = { $lt: cursor };
  const rows: any[] = await WorkflowVersion.find(query).sort({ _id: -1 }).limit(limit + 1).lean(); const hasMore = rows.length > limit;
  res.json({ items: rows.slice(0, limit), nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null });
}));

router.put('/:id', asyncRoute(async (req: AuthenticatedRequest, res: any) => {
  const organizationId = requireOrganizationId(req);
  const workflow: any = await Workflow.findOne({ _id: req.params.id, organizationId });
  if (!workflow) throw new HttpError(404, 'Workflow not found', 'Workflow not found');
  const definition: any = canonicalizeWorkflowDefinition(req.body || {}, { allowLegacy: req.body?.migrationMode === 'legacy-v1' });
  assertSafeWorkflowDraft(definition);
  await assertWorkflowResources({ organizationId, workflow: definition, requireOperational: req.body?.status === 'published' });
  const previous = await WorkflowVersion.findOne({ organizationId, workflowId: workflow._id }).sort({ version: -1 });
  workflow.name = String(req.body?.name || workflow.name).slice(0, 160);
  if (req.body?.description !== undefined) workflow.description = String(req.body.description).trim().slice(0, 2_000);
  workflow.nodes = definition.nodes; workflow.edges = definition.edges;
  if (req.body?.status && ['draft', 'published'].includes(req.body.status)) workflow.status = req.body.status;
  await workflow.save();
  const version: any = await WorkflowVersion.create({ organizationId, workflowId: workflow._id, version: Number(previous?.version || 0) + 1, snapshot: workflow.toObject(), comment: String(req.body?.comment || 'Canonical update') });
  if (workflow.status === 'published') { workflow.publishedVersion = version._id; workflow.definitionHash = definitionHash(workflow.toObject()); await workflow.save(); }
  await recordAudit({ req, organizationId, action: 'workflow.update', entityType: 'Workflow', entityId: String(workflow._id) });
  await syncSchedules(workflow); res.json(workflow);
}));

router.post('/:id/migrate-legacy', asyncRoute(async (req: AuthenticatedRequest, res: any) => {
  const organizationId = requireOrganizationId(req);
  const workflow: any = await Workflow.findOne({ _id: req.params.id, organizationId });
  if (!workflow) throw new HttpError(404, 'Workflow not found', 'Workflow not found');
  const canonical: any = canonicalizeWorkflowDefinition(workflow.toObject(), { allowLegacy: true }); assertValidWorkflowGraph(canonical);
  workflow.nodes = canonical.nodes; workflow.edges = canonical.edges; workflow.status = 'draft'; await workflow.save();
  const previous = await WorkflowVersion.findOne({ organizationId, workflowId: workflow._id }).sort({ version: -1 });
  await WorkflowVersion.create({ organizationId, workflowId: workflow._id, version: Number(previous?.version || 0) + 1, snapshot: workflow.toObject(), comment: 'Explicit legacy-v1 migration' });
  res.json(workflow);
}));

router.post('/:id/duplicate', asyncRoute(async (req: AuthenticatedRequest, res: any) => {
  const organizationId = requireOrganizationId(req);
  const original: any = await Workflow.findOne({ _id: req.params.id, organizationId });
  if (!original) throw new HttpError(404, 'Workflow not found', 'Workflow not found');
  const copy: any = await Workflow.create({ organizationId, name: `${original.name} (copy)`, description: original.description, status: 'draft', nodes: original.nodes, edges: original.edges, createdBy: req.auth?.userId });
  await WorkflowVersion.create({ organizationId, workflowId: copy._id, version: 1, snapshot: copy.toObject(), comment: 'Duplicated workflow' });
  res.status(201).json(copy);
}));

router.patch('/:id/status', asyncRoute(async (req: AuthenticatedRequest, res: any) => {
  const organizationId = requireOrganizationId(req); const status = String(req.body?.status || '');
  if (!['draft', 'published'].includes(status)) throw new HttpError(422, 'Invalid workflow status', 'status must be draft or published');
  const workflow: any = await Workflow.findOne({ _id: req.params.id, organizationId });
  if (!workflow) throw new HttpError(404, 'Workflow not found', 'Workflow not found');
  if (status === 'published') {
    const canonical = canonicalizeWorkflowDefinition(workflow.toObject());
    assertValidWorkflowGraph(canonical);
    await assertWorkflowResources({ organizationId, workflow: canonical, requireOperational: true });
  }
  workflow.status = status;
  if (status === 'published') {
    const previous = await WorkflowVersion.findOne({ organizationId, workflowId: workflow._id }).sort({ version: -1 });
    const version: any = await WorkflowVersion.create({ organizationId, workflowId: workflow._id, version: Number(previous?.version || 0) + 1, snapshot: workflow.toObject(), comment: 'Published immutable version' });
    workflow.publishedVersion = version._id; workflow.definitionHash = definitionHash(workflow.toObject());
  }
  await workflow.save(); await syncSchedules(workflow); res.json(workflow);
}));

router.delete('/:id', asyncRoute(async (req: AuthenticatedRequest, res: any) => {
  const organizationId = requireOrganizationId(req); const workflow: any = await Workflow.findOne({ _id: req.params.id, organizationId });
  if (!workflow) throw new HttpError(404, 'Workflow not found', 'Workflow not found');
  workflow.status = 'archived'; workflow.archivedAt = new Date(); await workflow.save(); await removeSchedules(organizationId, String(req.params.id));
  await recordAudit({ req, organizationId, action: 'workflow.archive', entityType: 'Workflow', entityId: String(workflow._id) });
  res.status(204).end();
}));

router.post('/:id/dry-run', asyncRoute(async (req: AuthenticatedRequest, res: any) => {
  const organizationId = requireOrganizationId(req);
  const workflow = await Workflow.findOne({ _id: req.params.id, organizationId }).lean();
  if (!workflow) throw new HttpError(404, 'Workflow not found', 'Workflow not found');
  await assertWorkflowResources({ organizationId, workflow, requireOperational: true });
  const result: any = await dryRunWorkflow({ organizationId, workflowId: String(req.params.id), payload: req.body?.payload || {}, startNodeId: req.body?.startNodeId });
  const version: any = await WorkflowVersion.findOne({ organizationId, workflowId: req.params.id }).sort({ version: -1 }).lean();
  if (!version || definitionHash(canonicalizeWorkflowDefinition(version.snapshot)) !== result.definitionHash) throw Object.assign(new Error('Save the current workflow version before requesting execution approval'), { statusCode: 409 });
  const approvalToken = crypto.randomBytes(32).toString('base64url');
  const now = Date.now(); const expiresAt = new Date(now + 15 * 60_000);
  await WorkflowDryRunApproval.create({
    organizationId, workflowId: req.params.id, workflowVersionId: version._id,
    tokenHash: crypto.createHash('sha256').update(approvalToken).digest('hex'),
    definitionHash: result.definitionHash, payloadHash: result.payloadHash, planHash: result.planHash,
    startNodeId: result.startNodeId, createdBy: req.auth!.userId, expiresAt,
    purgeAt: new Date(now + 7 * 86_400_000),
  });
  await recordAudit({ req, organizationId, action: 'workflow.dry_run_completed', entityType: 'Workflow', entityId: String(req.params.id), metadata: { planHash: result.planHash, impact: result.impact } });
  res.json({ ...result, approvalToken, approvalExpiresAt: expiresAt });
}));

router.post('/:id/run-test', asyncRoute(async (req: AuthenticatedRequest, res: any) => {
  const organizationId = requireOrganizationId(req); const workflow = await Workflow.findOne({ _id: req.params.id, organizationId });
  if (!workflow) throw new HttpError(404, 'Workflow not found', 'Workflow not found');
  if (req.body?.confirmation !== 'EXECUTE') throw new HttpError(422, 'Execution confirmation required', 'Type EXECUTE to confirm this approved preview');
  const approvalToken = String(req.body?.approvalToken || '');
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(approvalToken)) throw new HttpError(422, 'Dry-run approval required', 'A valid dry-run approvalToken is required');
  const payload = req.body?.payload || {};
  const currentDefinitionHash = definitionHash(canonicalizeWorkflowDefinition(workflow.toObject()));
  const payloadHash = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
  const tokenHash = crypto.createHash('sha256').update(approvalToken).digest('hex');
  const approval: any = await WorkflowDryRunApproval.findOne({
    organizationId, workflowId: workflow._id, tokenHash, definitionHash: currentDefinitionHash, payloadHash,
    consumedAt: { $exists: false }, expiresAt: { $gt: new Date() }, createdBy: req.auth!.userId,
  }).select('+tokenHash');
  if (!approval) throw new HttpError(409, 'Dry-run approval mismatch', 'Dry-run approval is expired, already used, or does not match this exact workflow and payload');
  await assertUsageAvailable(organizationId, 'workflow_execution');
  const correlationId = requestCorrelationId(req) || crypto.randomUUID();
  const execution: any = new Execution({ organizationId, workflowId: workflow._id, workflowVersionId: approval.workflowVersionId, definitionHash: approval.definitionHash, correlationId, status: 'queued', input: {}, steps: [], checkpoint: {} });
  execution.inputCiphertext = encryptJson(payload, `workflow-input:${organizationId}:${execution._id}`); await execution.save();
  const consumed = await WorkflowDryRunApproval.updateOne({ _id: approval._id, organizationId, consumedAt: { $exists: false } }, { $set: { consumedAt: new Date(), consumedExecutionId: execution._id } });
  if (!consumed.modifiedCount) { await Execution.deleteOne({ _id: execution._id, organizationId }); throw new HttpError(409, 'Dry-run approval used', 'Dry-run approval was already used'); }
  await workflowQueue.add('run', { organizationId, workflowId: req.params.id, execId: String(execution._id), correlationId, startNodeId: approval.startNodeId, allowDraft: true }, { attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 });
  await recordAudit({ req, organizationId, action: 'workflow.approved_test_queued', entityType: 'Execution', entityId: String(execution._id), metadata: { workflowId: String(workflow._id), planHash: approval.planHash } });
  res.status(202).json({ queued: true, executionId: execution._id, correlationId });
}));

router.post('/:id/run-now', () => { throw new HttpError(405, 'Synchronous execution disabled', 'Synchronous workflow writes are disabled; use run-test after dry-run approval'); });

export default router;
