import crypto from 'crypto';
import Workflow from '../models/Workflow';
import { canonicalizeWorkflowDefinition, assertValidWorkflowGraph } from './workflowValidation';
import { evaluateExpression, parseSafeExpression } from './safeExpression';
import { canonicalJson, definitionHash } from './canonicalJson';

function readPath(payload: any, state: any, path: string) {
  const raw = String(path || '').trim();
  const fromState = raw.startsWith('state.');
  const parts = raw.replace(/^(?:payload|state)\./, '').split('.').filter(Boolean);
  const read = (root: any) => parts.reduce((value: any, key) => value == null ? undefined : value[key], root);
  if (fromState) return read(state);
  const payloadValue = read(payload);
  return payloadValue === undefined ? read(state) : payloadValue;
}

function setPath(root: Record<string, any>, path: string, value: unknown) {
  const parts = path.replace(/^state\./, '').split('.').filter(Boolean);
  if (!parts.length || parts.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Unsafe transform target');
  let current: Record<string, any> = root;
  for (const part of parts.slice(0, -1)) current = (current[part] && typeof current[part] === 'object') ? current[part] : (current[part] = {});
  current[parts.at(-1)!] = value;
}

function conditionResult(config: any, payload: any, state: any) {
  if (config?.expression !== undefined || config?.jsonLogic !== undefined) {
    return Boolean(evaluateExpression(parseSafeExpression(config.expression ?? config.jsonLogic), { payload, state }));
  }
  const actual = readPath(payload, state, String(config?.field || ''));
  const expected = config?.value;
  const operations: Record<string, () => boolean> = {
    equals: () => String(actual ?? '') === String(expected ?? ''),
    not_equals: () => String(actual ?? '') !== String(expected ?? ''),
    contains: () => String(actual ?? '').includes(String(expected ?? '')),
    greater_than: () => Number(actual) > Number(expected),
    less_than: () => Number(actual) < Number(expected),
    exists: () => actual !== undefined && actual !== null && actual !== '',
  };
  const operation = operations[String(config?.operator || 'equals')];
  if (!operation) throw new Error('Unsupported condition operator');
  return operation();
}

function transformValue(config: any, payload: any, state: any) {
  const source = readPath(payload, state, String(config?.source || ''));
  switch (String(config?.operation || 'copy')) {
    case 'copy': return source;
    case 'lowercase': return String(source ?? '').toLowerCase();
    case 'uppercase': return String(source ?? '').toUpperCase();
    case 'trim': return String(source ?? '').trim();
    case 'string': return String(source ?? '');
    case 'number': {
      const value = Number(source); if (!Number.isFinite(value)) throw new Error('Field cannot be converted to a finite number'); return value;
    }
    case 'date_iso': {
      const value = new Date(source); if (Number.isNaN(value.getTime())) throw new Error('Field cannot be converted to an ISO date'); return value.toISOString();
    }
    default: return '[validated at execution]';
  }
}

function actionImpact(kind: string, config: any) {
  const internalOnly = new Set(['action.log', 'action.state.set']);
  const readOnly = new Set(['action.googleSheets.readRange']);
  const provider = String(config?.provider || kind.split('.')[1] || 'internal');
  return {
    external: !internalOnly.has(kind),
    destructive: !internalOnly.has(kind) && !readOnly.has(kind),
    provider,
    connectionId: config?.connectionId ? String(config.connectionId) : undefined,
    destinationId: config?.destinationId ? String(config.destinationId) : undefined,
    field: config?.field ? String(config.field) : undefined,
  };
}

export async function dryRunWorkflow(input: { organizationId: string; workflowId: string; payload: any; startNodeId?: string }) {
  const workflow: any = await Workflow.findOne({ _id: input.workflowId, organizationId: input.organizationId }).lean();
  if (!workflow) throw new Error('Workflow not found');
  const definition: any = canonicalizeWorkflowDefinition(workflow); assertValidWorkflowGraph(definition);
  const nodeMap = new Map<string, any>(definition.nodes.map((node: any) => [String(node.id), node]));
  const outgoing = (id: string) => definition.edges.filter((edge: any) => String(edge.source) === id);
  const start = (input.startNodeId ? nodeMap.get(input.startNodeId) : undefined) || definition.nodes.find((node: any) => String(node.data.kind).startsWith('trigger.'));
  if (!start) throw new Error('No matching trigger');
  if (!String(start.data.kind).startsWith('trigger.')) throw new Error('startNodeId must reference a trigger node');
  const pending = [start]; const visited = new Set<string>(); const state: Record<string, any> = {}; const plan: any[] = [];
  while (pending.length) {
    const node = pending.shift(); const id = String(node.id); if (visited.has(id)) continue; visited.add(id);
    const kind = String(node.data.kind); const config = node.data.config || {}; let output: any = {};
    if (kind === 'control.if') output = { result: Boolean(evaluateExpression(parseSafeExpression(config.expression ?? config.jsonLogic ?? true), { payload: input.payload, state })) };
    else if (kind === 'logic.condition') output = { result: conditionResult(config, input.payload, state) };
    else if (kind === 'control.switch' || kind === 'logic.split') output = { value: evaluateExpression(parseSafeExpression(config.expression ?? config.jsonLogic ?? null), { payload: input.payload, state }) };
    if (kind === 'logic.split' && config.expression === undefined && config.jsonLogic === undefined) {
      const percentage = Math.min(100, Math.max(0, Number(config.percentage ?? 50)));
      const roll = crypto.createHash('sha256').update(`${input.workflowId}:${id}:${canonicalJson(input.payload)}`).digest().readUInt32BE(0) / 0xffffffff * 100;
      output = { value: roll < percentage ? 'A' : 'B', deterministicPreview: true };
    }
    if (kind === 'control.ab.split') {
      const buckets = Array.isArray(config.buckets) && config.buckets.length ? config.buckets : [{ label: 'A', percent: 50 }, { label: 'B', percent: 50 }];
      const total = buckets.reduce((sum: number, bucket: any) => sum + Math.max(0, Number(bucket.percent || 0)), 0);
      const roll = crypto.createHash('sha256').update(`${input.workflowId}:${id}:${canonicalJson(input.payload)}`).digest().readUInt32BE(0) / 0xffffffff * total;
      let accumulated = 0; let selected = buckets.at(-1)?.label;
      for (const bucket of buckets) { accumulated += Math.max(0, Number(bucket.percent || 0)); if (roll <= accumulated) { selected = bucket.label; break; } }
      output = { value: String(selected), deterministicPreview: true };
    }
    if (kind === 'control.ultra.split') output = { possibleValues: ['A', 'B'], indeterminateUntilExecution: true };
    if (kind === 'transform.field') {
      const value = transformValue(config, input.payload, state); setPath(state, String(config.target || ''), value); output = { target: String(config.target || ''), value };
    }
    if (kind === 'action.state.set') {
      const target = String(config.target || ''); const value = config.value ?? config.valueTemplate ?? '[evaluated at execution]'; setPath(state, target, value); output = { target, value };
    }
    const impact = kind.startsWith('action.') ? actionImpact(kind, config) : undefined;
    plan.push({ nodeId: id, kind, effect: kind.startsWith('action.') ? 'would_execute' : kind.includes('delay') ? 'would_schedule_continuation' : 'evaluated', output, impact });
    let selected = outgoing(id);
    if (kind === 'control.if' || kind === 'logic.condition') { const aliases = output.result ? ['true', 'yes'] : ['false', 'no']; selected = selected.filter((edge: any) => aliases.includes(String(edge.data?.branch ?? edge.sourceHandle).toLowerCase())); }
    if (kind === 'control.switch' || kind === 'logic.split') selected = selected.filter((edge: any) => String(edge.data?.case ?? edge.sourceHandle) === String(output.value) || edge.data?.default === true);
    if (kind === 'control.ab.split') selected = selected.filter((edge: any) => String(edge.data?.case ?? edge.sourceHandle) === String(output.value));
    if (kind === 'control.ultra.split') selected = selected.filter((edge: any) => ['A', 'B'].includes(String(edge.data?.case ?? edge.sourceHandle)));
    for (const edge of selected) { const next = nodeMap.get(String(edge.target)); if (next) pending.push(next); }
  }
  const actions = plan.filter((item) => item.impact);
  const externalActions = actions.filter((item) => item.impact.external);
  const destructiveActions = actions.filter((item) => item.impact.destructive);
  const workflowDefinitionHash = definitionHash(definition);
  const payloadHash = crypto.createHash('sha256').update(canonicalJson(input.payload || {})).digest('hex');
  const impact = {
    nodesVisited: plan.length,
    actions: actions.length,
    externalActions: externalActions.length,
    destructiveActions: destructiveActions.length,
    scheduledContinuations: plan.filter((item) => item.effect === 'would_schedule_continuation').length,
    providers: Array.from(new Set(externalActions.map((item) => item.impact.provider))),
  };
  const planHash = crypto.createHash('sha256').update(canonicalJson({ workflowDefinitionHash, payloadHash, startNodeId: String(start.id), plan, impact })).digest('hex');
  return { safe: true, noSideEffects: true, approvalRequired: externalActions.length > 0, workflowId: input.workflowId, startNodeId: String(start.id), definitionHash: workflowDefinitionHash, payloadHash, planHash, impact, plan };
}
