import axios from 'axios';
import crypto from 'crypto';
import UltraSplit from '../models/UltraSplit';
import Contact from '../models/Contact';
import PlatformConnection from '../models/PlatformConnection';
import { createConnector, ConnectorProvider } from './connectors';
import { evaluateExpression, parseSafeExpression } from './safeExpression';
import { redact } from './redaction';
import { renderTemplate } from './templating';
import { pinnedHttpsAgent, safeRequestHeaders } from './ssrfGuard';
import { getVerifiedDestination } from './destinations';
import { getByPath } from './templating';
import { normalizePhone } from './batchNormalization';
import { executeStructuredAi } from './aiStructured';
import { safeAiStatePath } from './aiPolicy';

export interface WorkflowContext {
  organizationId: string;
  correlationId: string;
  workflowId: string;
  executionId: string;
  nodeId?: string;
  idempotencyKey?: string;
  payload: any;
  state: Record<string, any>;
}

export type NodeExecutor = (args: { data: any; ctx: WorkflowContext }) => Promise<any>;

function template(value: any, ctx: WorkflowContext) {
  return renderTemplate(String(value ?? ''), { payload: ctx.payload, state: ctx.state, ctx });
}

function parseTemplateObject(value: any, ctx: WorkflowContext) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object') return value;
  const rendered = template(value, ctx);
  try { return JSON.parse(rendered); } catch { throw new Error('Rendered body must be valid JSON'); }
}

function assignPath(target: any, path: string, value: any) {
  const parts = path.split('.').filter(Boolean);
  let cursor = target;
  for (let index = 0; index < parts.length; index += 1) {
    const key = parts[index]!;
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe mapping path');
    if (index === parts.length - 1) cursor[key] = value;
    else { if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {}; cursor = cursor[key]; }
  }
}

function workflowValue(ctx: WorkflowContext, path: string) {
  const normalized = String(path || '').trim();
  if (!normalized) return undefined;
  if (normalized.startsWith('payload.') || normalized.startsWith('state.') || normalized === 'payload' || normalized === 'state') {
    return getByPath({ payload: ctx.payload, state: ctx.state }, normalized);
  }
  const payloadValue = getByPath(ctx.payload, normalized);
  return payloadValue === undefined ? getByPath(ctx.state, normalized) : payloadValue;
}

function contactId(data: any, ctx: WorkflowContext) {
  return String(data?.contactId ? template(data.contactId, ctx) : ctx.state.contactId || ctx.payload?.contactId || ctx.payload?.contact?.id || ctx.payload?.id || '').trim();
}

async function providerForStructuredAction(data: any, ctx: WorkflowContext, allowed: ConnectorProvider[]) {
  const connectionId = String(data?.connectionId || '').trim();
  if (!connectionId) throw new Error('connectionId is required');
  const connection: any = await PlatformConnection.findOne({
    _id: connectionId,
    organizationId: ctx.organizationId,
    status: { $in: ['active', 'degraded', 'error'] },
  }).select('provider').lean();
  if (!connection || !allowed.includes(connection.provider as ConnectorProvider)) throw new Error('Connection is unavailable or does not support this action');
  return connection.provider as ConnectorProvider;
}

async function connectorFor(data: any, ctx: WorkflowContext, provider: ConnectorProvider) {
  return createConnector({ organizationId: ctx.organizationId, provider, connectionId: data?.connectionId ? String(data.connectionId) : undefined });
}

/**
 * Actions that execute inside the customer's external CRM and therefore incur
 * that platform's per-action workflow charge.
 *
 * This is the cost the product exists to remove. A ten-step sequence run
 * through GoHighLevel's workflow engine costs roughly $0.01 per action, so
 * 10,000 leads a month is about $1,000 in workflow fees before a single message
 * is paid for. Sending through the operator's own SMTP, SendGrid or Twilio
 * credentials — which is what the sequence engine does — reduces that line to
 * the raw provider cost.
 *
 * These nodes keep working. Removing them would break published workflows, and
 * there are legitimate uses: a customer mid-migration, or one who genuinely
 * wants the message to appear in their CRM's own conversation thread. But they
 * are labelled, and the label travels with the node into validation warnings
 * and the node catalogue so nobody adopts one without seeing the cost.
 */
export const PLATFORM_CHARGED_NODE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'action.ghl.send.sms': 'Sends through HighLevel and incurs their per-action workflow charge. Use an SMS sequence step with your own Twilio credentials to avoid it.',
  'action.ghl.send.email': 'Sends through HighLevel and incurs their per-action workflow charge. Use an email sequence step with your own SMTP or SendGrid credentials to avoid it.',
  'action.ghl.addTag': 'Tags inside HighLevel and incurs their per-action workflow charge. Use action.contact.tag.add to tag locally at no per-action cost.',
  'action.ghl.removeTag': 'Untags inside HighLevel and incurs their per-action workflow charge. Use action.contact.tag.remove to untag locally at no per-action cost.',
  'action.tag.add': 'Routes through HighLevel and incurs their per-action workflow charge. Use action.contact.tag.add instead.',
})

export function platformChargeNotice(nodeType: string): string | undefined {
  return PLATFORM_CHARGED_NODE_TYPES[nodeType]
}

export const nodeExecutors: Record<string, NodeExecutor> = {
  'trigger.webhook': async ({ ctx }) => ({ ok: true, payload: ctx.payload }),
  'trigger.schedule': async ({ ctx }) => ({ ok: true, payload: ctx.payload }),
  'trigger.ghl.contactCreated': async ({ ctx }) => ({ ok: true, payload: ctx.payload }),
  'trigger.ghl.formSubmitted': async ({ ctx }) => ({ ok: true, payload: ctx.payload }),
  'trigger.ghl.tagRemoved': async ({ ctx }) => ({ ok: true, payload: ctx.payload }),
  'trigger.hubspot.event': async ({ ctx }) => ({ ok: true, payload: ctx.payload }),
  'trigger.klaviyo.event': async ({ ctx }) => ({ ok: true, payload: ctx.payload }),
  'trigger.activecampaign.event': async ({ ctx }) => ({ ok: true, payload: ctx.payload }),
  'trigger.platform_event': async ({ ctx }) => ({ ok: true, payload: ctx.payload }),

  'trigger.ghl.tagAssigned': async ({ data, ctx }) => {
    const contactId = String(ctx.payload?.contactId || ctx.payload?.contact?.id || ctx.payload?.id || '');
    if (!contactId) throw new Error('HighLevel tag event does not contain contactId');
    const cached = await Contact.findOne({ organizationId: ctx.organizationId, ...(data?.connectionId ? { connectionId: data.connectionId } : {}), ghlId: contactId }).lean();
    return { ok: true, contactId, contact: cached || ctx.payload?.contact, payload: ctx.payload };
  },

  'control.if': async ({ data, ctx }) => {
    const expression = parseSafeExpression(data?.expression ?? data?.jsonLogic ?? true);
    return { result: Boolean(evaluateExpression(expression, { payload: ctx.payload, state: ctx.state, ctx: { correlationId: ctx.correlationId } })) };
  },
  'control.switch': async ({ data, ctx }) => {
    const expression = parseSafeExpression(data?.expression ?? data?.jsonLogic ?? null);
    return { value: evaluateExpression(expression, { payload: ctx.payload, state: ctx.state, ctx: { correlationId: ctx.correlationId } }) };
  },
  'logic.condition': async ({ data, ctx }) => {
    if (data?.expression !== undefined || data?.jsonLogic !== undefined) return { result: Boolean(evaluateExpression(parseSafeExpression(data.expression ?? data.jsonLogic), { payload: ctx.payload, state: ctx.state })) };
    const actual = workflowValue(ctx, String(data?.field || '')); const expected = data?.value;
    const operations: any = { equals: () => String(actual ?? '') === String(expected ?? ''), not_equals: () => String(actual ?? '') !== String(expected ?? ''), contains: () => String(actual ?? '').includes(String(expected ?? '')), greater_than: () => Number(actual) > Number(expected), less_than: () => Number(actual) < Number(expected), exists: () => actual !== undefined && actual !== null && actual !== '' };
    const operation = operations[String(data?.operator || 'equals')]; if (!operation) throw new Error('Unsupported condition operator'); return { result: Boolean(operation()) };
  },
  'logic.split': async ({ data, ctx }) => {
    if (data?.expression !== undefined || data?.jsonLogic !== undefined) return { value: evaluateExpression(parseSafeExpression(data.expression ?? data.jsonLogic), { payload: ctx.payload, state: ctx.state }) };
    const percentage = Math.min(100, Math.max(0, Number(data?.percentage ?? 50))); const digest = crypto.createHash('sha256').update(`${ctx.executionId}:${ctx.nodeId}`).digest();
    return { value: digest.readUInt32BE(0) / 0xffffffff * 100 < percentage ? 'A' : 'B' };
  },
  'control.delay': async ({ data }) => {
    const milliseconds = Math.min(300_000, Math.max(0, Number(data?.ms || 0)));
    if (!Number.isFinite(milliseconds)) throw new Error('Delay must be a finite number');
    await new Promise(resolve => setTimeout(resolve, milliseconds));
    return { waitedMs: milliseconds };
  },
  'control.ab.split': async ({ data, ctx }) => {
    const buckets = Array.isArray(data?.buckets) && data.buckets.length ? data.buckets : [{ label: 'A', percent: 50 }, { label: 'B', percent: 50 }];
    const total = buckets.reduce((sum: number, bucket: any) => sum + Math.max(0, Number(bucket.percent || 0)), 0);
    if (total <= 0) throw new Error('A/B split percentages must total more than zero');
    const digest = crypto.createHash('sha256').update(String(data?.stickyKey ? template(data.stickyKey, ctx) : `${ctx.executionId}:${ctx.nodeId}`)).digest();
    const roll = digest.readUInt32BE(0) / 0xffffffff * total;
    let accumulated = 0;
    for (const bucket of buckets) { accumulated += Math.max(0, Number(bucket.percent || 0)); if (roll <= accumulated) return { value: String(bucket.label) }; }
    return { value: String(buckets[buckets.length - 1].label) };
  },
  'control.ultra.split': async ({ ctx }) => {
    const key = `${ctx.organizationId}:${ctx.workflowId}:${ctx.nodeId}`;
    const document: any = await UltraSplit.findOneAndUpdate({ organizationId: ctx.organizationId, key }, { $inc: { seq: 1 }, $setOnInsert: { organizationId: ctx.organizationId } }, { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
    const sequence = Number(document?.seq || 1);
    return { value: sequence % 2 === 1 ? 'A' : 'B', sequence };
  },

  'action.log': async ({ data, ctx }) => ({ ok: true, message: template(data?.message, ctx) }),
  'action.state.set': async ({ data, ctx }) => {
    const target = String(data?.target || '').trim();
    if (!target || ['__proto__', 'prototype', 'constructor'].includes(target)) throw new Error('Safe state target is required');
    const value = data?.valueExpression !== undefined
      ? evaluateExpression(parseSafeExpression(data.valueExpression), { payload: ctx.payload, state: ctx.state })
      : data?.rawJsonTemplate ? parseTemplateObject(data.rawJsonTemplate, ctx) : template(data?.valueTemplate ?? data?.value, ctx);
    ctx.state[target] = value;
    return { ok: true, target, value: redact(value) };
  },
  'action.ai.structured': async ({ data, ctx }) => {
    const saveAs = safeAiStatePath(data?.saveAs);
    if (!saveAs) throw new Error('A safe saveAs state path is required for structured AI output');
    const prompt = template(data?.promptTemplate, ctx);
    const systemPromptSource = data?.systemPrompt ?? data?.systemPromptTemplate;
    const systemPrompt = systemPromptSource
      ? template(systemPromptSource, ctx)
      : 'Return only the object requested by the supplied JSON schema.';
    const idempotencyKey = ctx.idempotencyKey || crypto.createHash('sha256')
      .update(`${ctx.organizationId}:${ctx.executionId}:${ctx.nodeId || 'ai'}`)
      .digest('hex');
    const result = await executeStructuredAi({
      organizationId: ctx.organizationId,
      connectionId: String(data?.connectionId || ''),
      model: String(data?.model || ''),
      prompt,
      systemPrompt,
      outputSchema: data?.outputSchema,
      maxOutputTokens: data?.maxOutputTokens,
      timeoutMs: data?.timeoutMs,
      idempotencyKey,
      source: 'action.ai.structured',
    });
    // The model output is available to later nodes only through encrypted
    // workflow state. Returning metadata prevents plaintext step/output logs.
    assignPath(ctx.state, saveAs, result.output);
    return {
      ok: true,
      provider: result.provider,
      model: result.model,
      savedAs: saveAs,
      usage: result.usage,
    };
  },
  'action.approved_webhook': async ({ data, ctx }) => {
    if (!data?.destinationId) throw new Error('destinationId is required');
    const destination = await getVerifiedDestination({ organizationId: ctx.organizationId, destinationId: String(data.destinationId) });
    const method = String(data?.method || 'POST').toUpperCase(); if (!destination.allowedMethods.includes(method)) throw new Error('Destination method is not approved');
    const body = parseTemplateObject(data?.bodyTemplate || '{}', ctx); const validated = { url: new URL(destination.url), addresses: destination.pinnedAddresses };
    if (!validated.addresses.length) throw new Error('Verified destination has no pinned address');
    const response = await axios.request({ method, url: destination.url, headers: safeRequestHeaders(destination.headers || {}), data: body, timeout: 15_000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, httpsAgent: pinnedHttpsAgent(validated), validateStatus: status => status >= 200 && status < 300 });
    return { ok: true, status: response.status, data: redact(response.data) };
  },

  'action.ghl.createOrUpdateContact': async ({ data, ctx }) => {
    const connector = await connectorFor(data, ctx, 'ghl');
    const input = parseTemplateObject(data?.bodyTemplate || data?.input || {}, ctx);
    const result: any = await connector.execute('contact.upsert', input);
    const contactId = result?.contact?.id || result?.data?.id || result?.id;
    if (contactId) ctx.state.contactId = String(contactId);
    return redact(result);
  },
  'action.ghl.updateContact': async ({ data, ctx }) => {
    const connector = await connectorFor(data, ctx, 'ghl');
    const contactId = template(data?.contactId || '{{state.contactId}}', ctx);
    return redact(await connector.execute('contact.update', { id: contactId, ...parseTemplateObject(data?.bodyTemplate || {}, ctx) }));
  },
  'action.ghl.addTag': async ({ data, ctx }) => redact(await (await connectorFor(data, ctx, 'ghl')).execute('contact.addTag', { contactId: template(data?.contactId || '{{state.contactId}}', ctx), tags: data?.tags || [template(data?.tag || data?.tagId, ctx)] })),
  'action.ghl.removeTag': async ({ data, ctx }) => redact(await (await connectorFor(data, ctx, 'ghl')).execute('contact.removeTag', { contactId: template(data?.contactId || '{{state.contactId}}', ctx), tags: data?.tags || [template(data?.tag || data?.tagId, ctx)] })),
  'action.ghl.createOpportunity': async ({ data, ctx }) => redact(await (await connectorFor(data, ctx, 'ghl')).execute('opportunity.create', parseTemplateObject(data?.bodyTemplate || {}, ctx))),
  'action.ghl.send.sms': async ({ data, ctx }) => redact(await (await connectorFor(data, ctx, 'ghl')).execute('message.send', { type: 'SMS', ...parseTemplateObject(data?.bodyTemplate || {}, ctx) })),
  'action.ghl.send.email': async ({ data, ctx }) => redact(await (await connectorFor(data, ctx, 'ghl')).execute('message.send', { type: 'Email', ...parseTemplateObject(data?.bodyTemplate || {}, ctx) })),
  'action.hubspot.upsertContact': async ({ data, ctx }) => redact(await (await connectorFor(data, ctx, 'hubspot')).execute('contact.upsert', parseTemplateObject(data?.bodyTemplate || data?.input || {}, ctx))),
  'action.klaviyo.upsertProfile': async ({ data, ctx }) => redact(await (await connectorFor(data, ctx, 'klaviyo')).execute('profile.upsert', parseTemplateObject(data?.bodyTemplate || data?.input || {}, ctx))),
  'action.klaviyo.createEvent': async ({ data, ctx }) => redact(await (await connectorFor(data, ctx, 'klaviyo')).execute('event.create', parseTemplateObject(data?.bodyTemplate || data?.input || {}, ctx))),
  'action.activecampaign.upsertContact': async ({ data, ctx }) => redact(await (await connectorFor(data, ctx, 'activecampaign')).execute('contact.upsert', parseTemplateObject(data?.bodyTemplate || data?.input || {}, ctx))),
  'action.googleSheets.appendRows': async ({ data, ctx }) => redact(await (await connectorFor(data, ctx, 'google')).execute('rows.append', parseTemplateObject(data?.bodyTemplate || data?.input || {}, ctx))),
  'action.googleSheets.readRange': async ({ data, ctx }) => redact(await (await connectorFor(data, ctx, 'google')).execute('range.read', parseTemplateObject(data?.bodyTemplate || data?.input || {}, ctx))),
};

nodeExecutors['action.contact.update'] = async ({ data, ctx }) => {
  const provider = await providerForStructuredAction(data, ctx, ['ghl', 'hubspot', 'klaviyo', 'activecampaign']);
  const field = String(data?.field || '').trim();
  if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(field) || ['__proto__', 'prototype', 'constructor'].includes(field)) throw new Error('A safe contact field is required');
  const id = contactId(data, ctx); const value = template(data?.value, ctx);
  const connector = await connectorFor(data, ctx, provider);
  if (provider === 'ghl') {
    if (!id) throw new Error('contactId is required for a HighLevel contact update');
    return redact(await connector.execute('contact.update', { id, [field]: value }));
  }
  const properties = { [field]: value };
  const email = field === 'email' ? value : String(ctx.payload?.email || ctx.payload?.contact?.email || '');
  if (provider === 'activecampaign' && !email) throw new Error('ActiveCampaign contact update requires an email in the event or email field');
  return redact(await connector.execute('contact.upsert', { id: id || undefined, email: email || undefined, properties }));
};
/**
 * LOCAL tag actions.
 *
 * The direct replacement for `action.ghl.addTag` and `action.ghl.removeTag`
 * below. Those execute inside the customer's external CRM and incur its
 * per-action workflow charge; these write to the contact record here, run any
 * matching tag rules in this process, and cost nothing per action.
 *
 * Behaviour is otherwise identical, so a workflow can be migrated by changing
 * the node type and nothing else.
 */
nodeExecutors['action.contact.tag.add'] = async ({ data, ctx }) => {
  const { applyTagChanges } = await import('./crm/tags')
  const tags = (Array.isArray(data?.tags) ? data.tags : [data?.tag]).filter(Boolean).map((tag: unknown) => template(String(tag), ctx))
  if (!tags.length) throw new Error('action.contact.tag.add requires at least one tag')
  const result = await applyTagChanges({
    organizationId: ctx.organizationId,
    contactId: contactId(data, ctx),
    add: tags,
    source: `workflow:${ctx.nodeId}`,
  })
  return { added: result.added, tags: result.tags, rulesFired: result.rulesFired }
}

nodeExecutors['action.contact.tag.remove'] = async ({ data, ctx }) => {
  const { applyTagChanges } = await import('./crm/tags')
  const tags = (Array.isArray(data?.tags) ? data.tags : [data?.tag]).filter(Boolean).map((tag: unknown) => template(String(tag), ctx))
  if (!tags.length) throw new Error('action.contact.tag.remove requires at least one tag')
  const result = await applyTagChanges({
    organizationId: ctx.organizationId,
    contactId: contactId(data, ctx),
    remove: tags,
    source: `workflow:${ctx.nodeId}`,
  })
  return { removed: result.removed, tags: result.tags, rulesFired: result.rulesFired }
}

/**
 * Branch on whether a contact carries a tag.
 *
 * Matched on the normalised key, so a branch written for "vip" holds when
 * somebody types "VIP" instead.
 */
nodeExecutors['condition.contact.hasTag'] = async ({ data, ctx }) => {
  const { hasTag } = await import('./crm/tags')
  const Contact = (await import('../models/Contact')).default
  const wanted = (Array.isArray(data?.tags) ? data.tags : [data?.tag]).filter(Boolean).map((tag: unknown) => template(String(tag), ctx))
  if (!wanted.length) throw new Error('condition.contact.hasTag requires at least one tag')
  const contact: any = await Contact.findOne({ _id: contactId(data, ctx), organizationId: ctx.organizationId }).select('tags').lean()
  const tags: string[] = contact?.tags ?? []
  // `all` requires every tag; the default requires any one of them.
  const matched = data?.mode === 'all' ? wanted.every((tag: string) => hasTag(tags, tag)) : wanted.some((tag: string) => hasTag(tags, tag))
  return { value: matched ? 'A' : 'B', matched }
}

nodeExecutors['action.tag.add'] = async ({ data, ctx }) => {
  await providerForStructuredAction(data, ctx, ['ghl']);
  return redact(await (await connectorFor(data, ctx, 'ghl')).execute('contact.addTag', { contactId: contactId(data, ctx), tags: data?.tags || [template(data?.tag || data?.tagId, ctx)] }));
};
nodeExecutors['action.tag.remove'] = async ({ data, ctx }) => {
  await providerForStructuredAction(data, ctx, ['ghl']);
  return redact(await (await connectorFor(data, ctx, 'ghl')).execute('contact.removeTag', { contactId: contactId(data, ctx), tags: data?.tags || [template(data?.tag || data?.tagId, ctx)] }));
};
nodeExecutors['action.notification'] = async ({ data, ctx }) => {
  const { sendConfiguredNotification } = await import('./notifications');
  const message = template(data?.message || '', ctx); if (!data?.channelId || !message.trim()) throw new Error('Notification channelId and non-empty message are required');
  return sendConfiguredNotification({ organizationId: ctx.organizationId, channelId: String(data.channelId), subject: template(data?.subject || 'LogicFlower notification', ctx), message, correlationId: ctx.correlationId });
};

nodeExecutors['transform.field'] = async ({ data, ctx }) => {
  const source = workflowValue(ctx, String(data?.source || '')); const operation = String(data?.operation || 'copy');
  let value: any = source;
  if (operation === 'lowercase') value = String(source ?? '').toLowerCase();
  else if (operation === 'uppercase') value = String(source ?? '').toUpperCase();
  else if (operation === 'trim') value = String(source ?? '').trim();
  else if (operation === 'number') { value = Number(source); if (!Number.isFinite(value)) throw new Error('Field cannot be converted to a finite number'); }
  else if (operation === 'string') value = String(source ?? '');
  else if (operation === 'date_iso') { const date = new Date(source); if (Number.isNaN(date.getTime())) throw new Error('Field cannot be converted to an ISO date'); value = date.toISOString(); }
  else if (operation === 'phone_e164') { value = normalizePhone(source, String(data?.defaultCountryCode || '')); if (!value.startsWith('+')) throw new Error('Field cannot be converted to E.164 without a country code'); }
  else if (operation !== 'copy') throw new Error('Unsupported field transform operation');
  const target = String(data?.target || ''); if (!target || target.includes('__proto__')) throw new Error('Safe transform target is required'); assignPath(ctx.state, target.replace(/^state\./, ''), value); return { target, value: redact(value) };
};
