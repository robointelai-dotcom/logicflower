import { parseSafeExpression } from './safeExpression';
import { AI_HARD_LIMITS, aiProviderForModel, assertStructuredOutputSchema, safeAiStatePath } from './aiPolicy';
import { platformChargeNotice } from './nodeLibrary';

export const SUPPORTED_NODE_TYPES = new Set([
  'action.contact.tag.add', 'action.contact.tag.remove', 'condition.contact.hasTag',
  'trigger.webhook', 'trigger.schedule', 'trigger.ghl.contactCreated', 'trigger.ghl.formSubmitted',
  'trigger.ghl.tagAssigned', 'trigger.ghl.tagRemoved', 'trigger.hubspot.event', 'trigger.klaviyo.event',
  'trigger.activecampaign.event',
  'control.if', 'control.switch', 'control.delay', 'control.ab.split', 'control.ultra.split',
  'action.log', 'action.state.set',
  'action.ghl.createOrUpdateContact', 'action.ghl.updateContact', 'action.ghl.addTag', 'action.ghl.removeTag',
  'action.ghl.createOpportunity', 'action.ghl.send.sms', 'action.ghl.send.email',
  'action.hubspot.upsertContact', 'action.klaviyo.upsertProfile', 'action.klaviyo.createEvent',
  'action.activecampaign.upsertContact', 'action.googleSheets.appendRows', 'action.googleSheets.readRange',
  'logic.condition', 'logic.delay', 'logic.split', 'transform.field', 'action.contact.update',
  'action.tag.add', 'action.tag.remove', 'action.notification', 'action.approved_webhook',
  'action.ai.structured',
  'trigger.platform_event',
]);

const REMOVED_NODE_TYPES = new Set([
  'action.code.js', 'action.ghl.request', 'action.redis.set', 'action.redis.get', 'control.goto',
  'action.http.request', 'action.http.mapper', 'action.http.ultra',
]);

export interface WorkflowValidationResult { valid: boolean; errors: string[]; warnings: string[]; }

export function canonicalizeWorkflowDefinition(workflow: any, options: { allowLegacy?: boolean } = {}) {
  const nodes = (Array.isArray(workflow?.nodes) ? workflow.nodes : []).map((node: any) => {
    if (node?.data?.kind) {
      return {
        id: String(node.id || node._id || ''),
        type: String(node.type || 'workflowNode'),
        position: { x: Number(node.position?.x || 0), y: Number(node.position?.y || 0) },
        data: { kind: String(node.data.kind), label: String(node.data.label || node.data.kind), config: node.data.config && typeof node.data.config === 'object' ? node.data.config : {} },
      };
    }
    if (!options.allowLegacy) return node;
    const legacyKind = String(node?.type || '');
    const legacyData = node?.data && typeof node.data === 'object' ? node.data : {};
    const { kind: _kind, label, config: _config, ...legacyConfig } = legacyData;
    return {
      id: String(node.id || node._id || ''), type: 'workflowNode',
      position: { x: Number(node.position?.x || 0), y: Number(node.position?.y || 0) },
      data: { kind: legacyKind, label: String(label || legacyKind), config: legacyConfig },
    };
  });
  const edges = (Array.isArray(workflow?.edges) ? workflow.edges : []).map((edge: any) => ({
    id: String(edge.id || `${edge.source}-${edge.target}`), source: String(edge.source || ''), target: String(edge.target || ''),
    sourceHandle: edge.sourceHandle ? String(edge.sourceHandle) : undefined,
    targetHandle: edge.targetHandle ? String(edge.targetHandle) : undefined,
    data: edge.data && typeof edge.data === 'object' ? edge.data : {},
  }));
  return { ...workflow, nodes, edges, schemaVersion: 2 };
}

export function validateWorkflowGraph(workflow: any): WorkflowValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const canonical = canonicalizeWorkflowDefinition(workflow);
  const nodes = Array.isArray(canonical?.nodes) ? canonical.nodes : [];
  const edges = Array.isArray(canonical?.edges) ? canonical.edges : [];
  if (!nodes.length) errors.push('Workflow must contain at least one node');
  if (nodes.length > 500) errors.push('Workflow exceeds the 500-node limit');
  if (edges.length > 1_000) errors.push('Workflow exceeds the 1,000-edge limit');

  const ids = new Set<string>();
  for (const node of nodes) {
    const id = String(node?.id || node?._id || '').trim();
    const type = String(node?.data?.kind || '').trim();
    const config = node?.data?.config || {};
    if (!id) errors.push('Every workflow node requires an id');
    else if (ids.has(id)) errors.push(`Duplicate node id: ${id}`);
    else ids.add(id);
    if (REMOVED_NODE_TYPES.has(type)) errors.push(`Node type ${type} is disabled for security or is unsupported`);
    else if (!SUPPORTED_NODE_TYPES.has(type)) errors.push(`Unsupported node type: ${type || '(missing)'}`);
    // A warning, not an error: these nodes still work and are still publishable.
    // The point is that the cost is visible at authoring time rather than on an
    // invoice a month later.
    const chargeNotice = platformChargeNotice(type);
    if (chargeNotice) warnings.push(`Node ${id || type} incurs platform charges. ${chargeNotice}`);
    if (type === 'control.if' || type === 'control.switch' || type === 'logic.condition' || type === 'logic.split') {
      if (config?.js || config?.code) errors.push(`${type} node ${id} contains JavaScript; migrate it to JSON Logic`);
      try { parseSafeExpression(config?.expression ?? config?.jsonLogic ?? (type === 'control.if' || type === 'logic.condition' ? true : null)); }
      catch (error: any) { errors.push(`${type} node ${id}: ${error.message}`); }
    }
    if (type === 'control.delay' || type === 'logic.delay') {
      const multipliers: Record<string, number> = { milliseconds: 1, seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
      const unit = String(config?.unit || 'milliseconds');
      const milliseconds = config?.ms !== undefined ? Number(config.ms) : Number(config?.amount || 0) * (multipliers[unit] || Number.NaN);
      if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 30 * 86_400_000) errors.push(`Delay node ${id} must be a finite duration between 0 and 30 days`);
    }
    if (type === 'trigger.schedule') {
      const cron = String(config?.cron || '').trim();
      const timezone = String(config?.timezone || 'UTC');
      // Bounded before matching. The expression below is linear despite the
      // nested quantifier — `[^\s]+` and `\s+` are disjoint character classes,
      // so there is no ambiguous split for a backtracking engine to explore
      // (verified against 200k-character adversarial inputs). The length guard
      // is defence in depth rather than a fix for that.
      // eslint-disable-next-line security/detect-unsafe-regex -- disjoint classes; see note above
      if (cron.length > 200 || !/^([^\s]+\s+){4,5}[^\s]+$/.test(cron)) errors.push(`Schedule trigger ${id} requires a 5- or 6-field cron expression`);
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { errors.push(`Schedule trigger ${id} has an invalid timezone`); }
    }
    if (type === 'trigger.platform_event') {
      if (!String(config?.connectionId || '').trim()) errors.push(`Platform event trigger ${id} requires connectionId`);
      if (!String(config?.event || '').trim()) errors.push(`Platform event trigger ${id} requires an event name`);
    }
    if (type === 'logic.condition' && config?.expression === undefined && config?.jsonLogic === undefined) {
      const operators = new Set(['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'exists']);
      if (!String(config?.field || '').trim()) errors.push(`Condition node ${id} requires a field`);
      if (!operators.has(String(config?.operator || 'equals'))) errors.push(`Condition node ${id} has an unsupported operator`);
    }
    if (type === 'logic.split' && config?.expression === undefined && config?.jsonLogic === undefined) {
      const percentage = Number(config?.percentage);
      if (!Number.isFinite(percentage) || percentage <= 0 || percentage >= 100) errors.push(`Split node ${id} percentage must be between 1 and 99`);
    }
    if (type === 'transform.field') {
      const operations = new Set(['copy', 'lowercase', 'uppercase', 'trim', 'number', 'string', 'date_iso', 'phone_e164']);
      if (!String(config?.source || '').trim() || !String(config?.target || '').trim()) errors.push(`Transform node ${id} requires source and target fields`);
      if (!operations.has(String(config?.operation || 'copy'))) errors.push(`Transform node ${id} has an unsupported operation`);
      if (/__proto__|prototype|constructor/.test(String(config?.target || ''))) errors.push(`Transform node ${id} has an unsafe target`);
    }
    if (type === 'action.contact.update') {
      if (!String(config?.connectionId || '').trim()) errors.push(`Contact update node ${id} requires connectionId`);
      if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(String(config?.field || '')) || ['__proto__', 'prototype', 'constructor'].includes(String(config?.field || ''))) errors.push(`Contact update node ${id} requires a safe field`);
    }
    if (type === 'action.tag.add' || type === 'action.tag.remove') {
      if (!String(config?.connectionId || '').trim()) errors.push(`Tag node ${id} requires connectionId`);
      if (!String(config?.tag || config?.tagId || '').trim() && !Array.isArray(config?.tags)) errors.push(`Tag node ${id} requires a tag`);
    }
    if (type === 'action.notification') {
      if (!String(config?.channelId || '').trim()) errors.push(`Notification node ${id} requires channelId`);
      if (!String(config?.message || '').trim()) errors.push(`Notification node ${id} requires a non-empty message`);
    }
    if (type === 'action.approved_webhook') {
      if (!String(config?.destinationId || '').trim()) errors.push(`Approved webhook node ${id} requires destinationId`);
      if (!['POST', 'PUT', 'PATCH'].includes(String(config?.method || 'POST').toUpperCase())) errors.push(`Approved webhook node ${id} has an unsupported method`);
      if (['url', 'approvedHost', 'headers', 'secret', 'signingSecret'].some(key => config?.[key] !== undefined)) errors.push(`Approved webhook node ${id} may reference only a verified destination, not inline URL or secrets`);
    }
    if (type === 'action.ai.structured') {
      if (!/^[a-fA-F0-9]{24}$/.test(String(config?.connectionId || ''))) errors.push(`Structured AI node ${id} requires a valid connectionId`);
      if (!aiProviderForModel(String(config?.model || ''))) errors.push(`Structured AI node ${id} requires an allowlisted model`);
      if (typeof config?.promptTemplate !== 'string' || !config.promptTemplate.trim() || Buffer.byteLength(config.promptTemplate, 'utf8') > 16_384) errors.push(`Structured AI node ${id} requires a promptTemplate of at most 16384 bytes`);
      if (config?.systemPrompt !== undefined && (typeof config.systemPrompt !== 'string' || Buffer.byteLength(config.systemPrompt, 'utf8') > 8_192)) errors.push(`Structured AI node ${id} systemPrompt exceeds 8192 bytes`);
      if (config?.systemPromptTemplate !== undefined && (typeof config.systemPromptTemplate !== 'string' || Buffer.byteLength(config.systemPromptTemplate, 'utf8') > 8_192)) errors.push(`Structured AI node ${id} legacy systemPromptTemplate exceeds 8192 bytes`);
      if (config?.systemPrompt !== undefined && config?.systemPromptTemplate !== undefined) errors.push(`Structured AI node ${id} cannot set both systemPrompt and legacy systemPromptTemplate`);
      if (!safeAiStatePath(config?.saveAs)) errors.push(`Structured AI node ${id} requires a safe saveAs state path`);
      const maxOutputTokens = Number(config?.maxOutputTokens ?? 1_024);
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > AI_HARD_LIMITS.maxOutputTokens) errors.push(`Structured AI node ${id} maxOutputTokens must be an integer from 1 to ${AI_HARD_LIMITS.maxOutputTokens}`);
      const timeoutMs = Number(config?.timeoutMs ?? 20_000);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < AI_HARD_LIMITS.minTimeoutMs || timeoutMs > AI_HARD_LIMITS.maxTimeoutMs) errors.push(`Structured AI node ${id} timeoutMs must be between ${AI_HARD_LIMITS.minTimeoutMs} and ${AI_HARD_LIMITS.maxTimeoutMs}`);
      if (['apiKey', 'accessToken', 'credentials', 'endpoint', 'baseUrl', 'headers'].some(key => config?.[key] !== undefined)) errors.push(`Structured AI node ${id} cannot contain credentials, headers, or provider endpoints`);
      try { assertStructuredOutputSchema(config?.outputSchema); }
      catch (error: any) { errors.push(`Structured AI node ${id}: ${error.message}`); }
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const edge of edges) {
    const source = String(edge?.source || '');
    const target = String(edge?.target || '');
    if (!ids.has(source)) errors.push(`Edge references missing source node: ${source}`);
    if (!ids.has(target)) errors.push(`Edge references missing target node: ${target}`);
    if (ids.has(source) && ids.has(target)) adjacency.get(source)!.push(target);
  }

  const triggers = nodes.filter((node: any) => String(node?.data?.kind || '').startsWith('trigger.'));
  if (triggers.length === 0) errors.push('Workflow requires a trigger node');
  if (triggers.length > 1) warnings.push('Workflow has multiple triggers; each event starts from its matching trigger');

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleNodes = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) { cycleNodes.add(id); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id) || []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  if (cycleNodes.size) errors.push(`Workflow cycles are not allowed (${Array.from(cycleNodes).join(', ')})`);

  return { valid: errors.length === 0, errors, warnings };
}

export function assertValidWorkflowGraph(workflow: any) {
  const result = validateWorkflowGraph(workflow);
  if (!result.valid) {
    const error: any = new Error(result.errors.join('; '));
    error.code = 'INVALID_WORKFLOW';
    error.statusCode = 422;
    error.details = result;
    throw error;
  }
  return result;
}

export function assertSafeWorkflowDraft(workflow: any) {
  const result = validateWorkflowGraph(workflow);
  const securityErrors = result.errors.filter(error => /disabled for security|unsupported node type|contains JavaScript|unsafe|inline URL or secrets|Expression exceeds|valid JSON, not JavaScript/i.test(error));
  if (securityErrors.length) {
    const exception: any = new Error(securityErrors.join('; ')); exception.code = 'UNSAFE_WORKFLOW'; exception.statusCode = 422; throw exception;
  }
  return result;
}
