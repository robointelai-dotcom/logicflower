import crypto from 'crypto';
import Workflow from '../models/Workflow';
import WorkflowVersion from '../models/WorkflowVersion';
import Execution from '../models/Execution';
import ExecutionNodeRun from '../models/ExecutionNodeRun';
import { workflowQueue } from '../queue';
import { nodeExecutors, WorkflowContext } from './nodeLibrary';
import { assertValidWorkflowGraph, canonicalizeWorkflowDefinition } from './workflowValidation';
import { definitionHash } from './canonicalJson';
import { redact, redactedError } from './redaction';
import { withRetry } from './retry';
import { decryptJson, encryptJson } from '../security/encryption';
import { reserveMeteredUsage } from './entitlements';
import { env } from '../env';

export interface RunWorkflowOptions {
  organizationId: string;
  execId?: string;
  startNodeId?: string;
  triggerKind?: string;
  correlationId?: string;
  allowDraft?: boolean;
  resume?: boolean;
  maxSteps?: number;
}

function edgeBranch(edge: any) { return edge?.data?.branch ?? edge?.data?.case ?? edge?.sourceHandle; }
function queueJobId(prefix: string, material: string) { return `${prefix}-${crypto.createHash('sha256').update(material).digest('hex').slice(0, 48)}`; }
function stateAad(organizationId: string, executionId: string) { return `workflow-state:${organizationId}:${executionId}`; }
function inputAad(organizationId: string, executionId: string) { return `workflow-input:${organizationId}:${executionId}`; }

async function pinnedDefinition(workflow: any, organizationId: string, allowDraft: boolean) {
  let version: any;
  if (!allowDraft && workflow.publishedVersion) version = await WorkflowVersion.findOne({ _id: workflow.publishedVersion, organizationId, workflowId: workflow._id }).lean();
  if (!version) version = await WorkflowVersion.findOne({ organizationId, workflowId: workflow._id }).sort({ version: -1 }).lean();
  if (!version) throw new Error('Workflow has no immutable version');
  const definition: any = canonicalizeWorkflowDefinition(version.snapshot);
  assertValidWorkflowGraph(definition);
  return { version, definition, hash: definitionHash(definition) };
}

async function exactPinnedDefinition(input: { organizationId: string; workflowId: any; workflowVersionId: any; expectedHash: string }) {
  const version: any = await WorkflowVersion.findOne({
    _id: input.workflowVersionId,
    organizationId: input.organizationId,
    workflowId: input.workflowId,
  }).lean();
  if (!version) throw new Error('Pinned workflow version not found');
  const definition: any = canonicalizeWorkflowDefinition(version.snapshot);
  assertValidWorkflowGraph(definition);
  const hash = definitionHash(definition);
  if (hash !== input.expectedHash) throw new Error('Pinned workflow definition hash mismatch');
  return { version, definition, hash };
}

export default async function runWorkflow(workflowId: string, payload: any, options: RunWorkflowOptions) {
  const organizationId = String(options?.organizationId || '');
  if (!organizationId) throw new Error('organizationId is required to execute a workflow');
  const workflow: any = await Workflow.findOne({ _id: workflowId, organizationId });
  if (!workflow) throw new Error('Workflow not found');
  if (!options.allowDraft && workflow.status !== 'published') throw new Error('Only published workflows can be executed');
  const correlationId = String(options.correlationId || crypto.randomUUID());
  let execution: any;
  let pinned: any;

  if (options.execId) {
    execution = await Execution.findOne({ _id: options.execId, organizationId, workflowId: workflow._id }).select('+stateCiphertext +inputCiphertext');
    if (!execution) throw new Error('Execution not found');
    if (execution.status === 'cancel_requested' || execution.status === 'cancelled') {
      execution.status = 'cancelled';
      execution.finishedAt ||= new Date();
      execution.currentNodeId = undefined;
      execution.durationMs = execution.startedAt ? execution.finishedAt.getTime() - execution.startedAt.getTime() : 0;
      await execution.save();
      return execution;
    }
    if (options.resume) {
      if (execution.status !== 'waiting') throw new Error('Only a waiting execution can be resumed');
      pinned = await exactPinnedDefinition({ organizationId, workflowId: workflow._id, workflowVersionId: execution.workflowVersionId, expectedHash: execution.definitionHash });
    } else {
      if (execution.status !== 'queued') throw new Error('Execution already started; automatic restart is forbidden');
      if (execution.workflowVersionId || execution.definitionHash) {
        if (!execution.workflowVersionId || !execution.definitionHash) throw new Error('Queued execution has incomplete workflow version provenance');
        pinned = await exactPinnedDefinition({ organizationId, workflowId: workflow._id, workflowVersionId: execution.workflowVersionId, expectedHash: execution.definitionHash });
      } else {
        pinned = await pinnedDefinition(workflow, organizationId, Boolean(options.allowDraft));
        execution.workflowVersionId = pinned.version._id; execution.definitionHash = pinned.hash;
      }
      if (payload === undefined && execution.inputCiphertext) payload = decryptJson(execution.inputCiphertext, inputAad(organizationId, String(execution._id)));
      execution.input = redact(payload); execution.inputCiphertext ||= encryptJson(payload, inputAad(organizationId, String(execution._id))); execution.startedAt = new Date();
    }
    execution.status = 'running'; execution.correlationId = correlationId; execution.error = undefined; execution.finishedAt = undefined;
    await execution.save();
  } else {
    pinned = await pinnedDefinition(workflow, organizationId, Boolean(options.allowDraft));
    execution = await Execution.create({
      organizationId, workflowId: workflow._id, workflowVersionId: pinned.version._id, definitionHash: pinned.hash,
      correlationId, status: 'running', startedAt: new Date(), input: redact(payload), inputCiphertext: encryptJson(payload, inputAad(organizationId, 'pending')), stateCiphertext: encryptJson({}, stateAad(organizationId, 'pending')), checkpoint: {}, steps: [], stepCount: 0,
    });
    execution.inputCiphertext = encryptJson(payload, inputAad(organizationId, String(execution._id))); execution.stateCiphertext = encryptJson({}, stateAad(organizationId, String(execution._id))); await execution.save();
  }

  const canonical: any = pinned.definition;
  const failExecution = async (error: any, currentNodeId?: string) => {
    execution.status = 'failed'; execution.error = redactedError(error); execution.currentNodeId = currentNodeId;
    execution.finishedAt = new Date(); execution.durationMs = execution.startedAt ? execution.finishedAt.getTime() - execution.startedAt.getTime() : 0;
    await execution.save();
  };

  try {
    await reserveMeteredUsage({
      organizationId,
      metric: 'workflow_execution',
      quantity: 1,
      idempotencyKey: `workflow-execution:${String(execution._id)}`,
      source: 'workflowEngine',
      metadata: { workflowId: String(workflow._id), executionId: String(execution._id) },
    });
    const nodes = canonical.nodes || []; const edges = canonical.edges || [];
    const nodeMap = new Map<string, any>(nodes.map((node: any) => [String(node.id), node]));
    const outgoing = (nodeId: string) => edges.filter((edge: any) => String(edge.source) === nodeId);
    let pending: any[]; const executed = new Set<string>(); const queued = new Set<string>();
    if (options.resume && execution.inputCiphertext) payload = decryptJson(execution.inputCiphertext, inputAad(organizationId, String(execution._id)));
    let state: Record<string, any> = {};
    if (execution.stateCiphertext) state = decryptJson(execution.stateCiphertext, stateAad(organizationId, String(execution._id)));

    if (options.resume) {
      const pendingIds = Array.isArray(execution.checkpoint?.pendingNodeIds) ? execution.checkpoint.pendingNodeIds.map(String) : [];
      pending = pendingIds.map((id: string) => nodeMap.get(id)).filter(Boolean);
      for (const id of execution.checkpoint?.executedNodeIds || []) executed.add(String(id));
      for (const node of pending) queued.add(String(node.id));
      if (!pending.length) throw new Error('Waiting execution has no continuation checkpoint');
    } else {
      const start = (options.startNodeId ? nodeMap.get(String(options.startNodeId)) : undefined)
        || (options.triggerKind ? nodes.find((node: any) => node.data.kind === options.triggerKind) : undefined)
        || nodes.find((node: any) => String(node.data.kind).startsWith('trigger.'));
      if (!start) throw new Error('No matching trigger node');
      if (!String(start.data.kind).startsWith('trigger.')) throw new Error('startNodeId must reference a trigger node');
      pending = [start]; queued.add(String(start.id));
    }

    const maximumSteps = Math.min(1_000, Math.max(1, options.maxSteps || env.WORKFLOW_MAX_STEPS));
    let finalOutput: any = payload;
    const ctx: WorkflowContext = { organizationId, correlationId, workflowId: String(workflow._id), executionId: String(execution._id), payload, state };

    while (pending.length) {
      const persisted: any = await Execution.findOne({ _id: execution._id, organizationId }).select('status');
      if (persisted?.status === 'cancel_requested' || persisted?.status === 'cancelled') {
        execution.status = 'cancelled'; execution.finishedAt = new Date(); execution.currentNodeId = undefined;
        execution.durationMs = execution.startedAt ? execution.finishedAt.getTime() - execution.startedAt.getTime() : 0; await execution.save(); return execution;
      }
      if (executed.size >= maximumSteps) throw new Error(`Workflow exceeded maximum step count (${maximumSteps})`);
      const node = pending.shift(); const nodeId = String(node.id); queued.delete(nodeId);
      if (executed.has(nodeId)) continue;
      const kind = String(node.data.kind); const config = node.data.config || {}; ctx.nodeId = nodeId;
      execution.currentNodeId = nodeId;

      if (kind === 'logic.delay' || kind === 'control.delay') {
        const unitMultiplier: any = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
        const delayMs = Math.min(30 * 24 * 60 * 60 * 1_000, Math.max(1_000, Number(config?.ms || config?.delayMs || (Number(config?.amount || 1) * (unitMultiplier[String(config?.unit || 'seconds')] || 1_000)))));
        executed.add(nodeId);
        execution.steps.push({ nodeId, type: kind, startedAt: new Date(), finishedAt: new Date(), status: 'succeeded', output: { scheduledDelayMs: delayMs } });
        for (const edge of outgoing(nodeId)) {
          const next = nodeMap.get(String(edge.target)); if (next && !executed.has(String(next.id)) && !queued.has(String(next.id))) { pending.push(next); queued.add(String(next.id)); }
        }
        const cancellation: any = await Execution.findOne({ _id: execution._id, organizationId }).select('status');
        if (cancellation?.status === 'cancel_requested' || cancellation?.status === 'cancelled') {
          execution.status = 'cancelled'; execution.finishedAt = new Date(); execution.currentNodeId = undefined;
          execution.durationMs = execution.startedAt ? execution.finishedAt.getTime() - execution.startedAt.getTime() : 0;
          await execution.save(); return execution;
        }
        execution.status = 'waiting'; execution.currentNodeId = undefined; execution.stateCiphertext = encryptJson(ctx.state, stateAad(organizationId, String(execution._id)));
        execution.checkpoint = { pendingNodeIds: pending.map(item => String(item.id)), executedNodeIds: Array.from(executed), resumeAt: new Date(Date.now() + delayMs) };
        await execution.save();
        await workflowQueue.add('resume', { organizationId, workflowId, execId: String(execution._id), correlationId, resume: true }, { jobId: queueJobId('resume', `${execution._id}:${nodeId}`), delay: delayMs, attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 });
        return execution;
      }

      const idempotencyKey = crypto.createHash('sha256').update(`${organizationId}:${execution._id}:${nodeId}`).digest('hex');
      ctx.idempotencyKey = idempotencyKey;
      let claim: any;
      try { claim = await ExecutionNodeRun.create({ organizationId, executionId: execution._id, nodeId, idempotencyKey, status: 'processing' }); }
      catch (error: any) {
        if (error?.code !== 11000) throw error;
        claim = await ExecutionNodeRun.findOne({ organizationId, executionId: execution._id, nodeId });
        if (claim?.status === 'succeeded') {
          finalOutput = claim.result; executed.add(nodeId);
          for (const edge of outgoing(nodeId)) { const next = nodeMap.get(String(edge.target)); if (next && !executed.has(String(next.id)) && !queued.has(String(next.id))) { pending.push(next); queued.add(String(next.id)); } }
          continue;
        }
        throw new Error(`Node ${nodeId} has an uncertain prior outcome; manual review is required before retry`);
      }

      executed.add(nodeId);
      execution.checkpoint = { pendingNodeIds: pending.map(item => String(item.id)), executedNodeIds: Array.from(executed), updatedAt: new Date() };
      await execution.save();
      const step: any = { nodeId, type: kind, startedAt: new Date(), status: 'running', logs: [] };
      try {
        const executor = nodeExecutors[kind]; if (!executor) throw new Error(`No executor registered for ${kind}`);
        const retrySafe = kind.startsWith('trigger.') || kind.startsWith('control.') || kind.startsWith('logic.') || kind === 'action.log' || kind === 'action.state.set' || kind === 'transform.field' || kind === 'action.googleSheets.readRange';
        const configuredAttempts = retrySafe ? Math.min(5, Math.max(1, Number(config?.retry?.attempts || 1))) : 1; let attemptUsed = 0;
        const output = await withRetry(async attempt => { attemptUsed = attempt; return executor({ data: config, ctx }); }, { attempts: configuredAttempts, baseDelayMs: Number(config?.retry?.baseDelayMs || 300), maxDelayMs: 10_000 });
        finalOutput = output; step.attempt = attemptUsed; step.finishedAt = new Date(); step.status = 'succeeded'; step.output = redact(output);
        execution.steps.push(step); execution.stateCiphertext = encryptJson(ctx.state, stateAad(organizationId, String(execution._id))); execution.stepCount = executed.size;
        claim.status = 'succeeded'; claim.result = redact(output); claim.finishedAt = new Date(); await claim.save(); await execution.save();
        const nextEdges = outgoing(nodeId); let selected: any[] = nextEdges;
        if (kind === 'control.if' || kind === 'logic.condition') {
          const aliases = output?.result ? new Set(['true', 'yes']) : new Set(['false', 'no']);
          selected = nextEdges.filter((edge: any) => aliases.has(String(edgeBranch(edge)).toLowerCase()));
        } else if (['control.switch', 'control.ab.split', 'control.ultra.split', 'logic.split'].includes(kind)) {
          selected = nextEdges.filter((edge: any) => String(edgeBranch(edge)) === String(output?.value));
          if (!selected.length) selected = nextEdges.filter((edge: any) => edge?.data?.default === true || String(edgeBranch(edge)) === 'default');
        }
        for (const edge of selected) { const next = nodeMap.get(String(edge.target)); if (next && !executed.has(String(next.id)) && !queued.has(String(next.id))) { pending.push(next); queued.add(String(next.id)); } }
      } catch (error: any) {
        step.finishedAt = new Date(); step.status = 'failed'; step.error = redactedError(error); execution.steps.push(step);
        claim.status = 'failed'; claim.error = redactedError(error); claim.finishedAt = new Date(); await claim.save(); await failExecution(error, nodeId); throw error;
      }
    }

    execution.status = 'succeeded'; execution.output = redact(finalOutput); execution.stateCiphertext = encryptJson(ctx.state, stateAad(organizationId, String(execution._id)));
    execution.currentNodeId = undefined; execution.checkpoint = { completed: true, executedNodeIds: Array.from(executed), updatedAt: new Date() };
    execution.finishedAt = new Date(); execution.durationMs = execution.finishedAt.getTime() - execution.startedAt.getTime(); await execution.save();
    return execution;
  } catch (error: any) { if (execution.status !== 'failed') await failExecution(error, execution.currentNodeId); throw error; }
}
