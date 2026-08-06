import crypto from 'crypto';
import { Router } from 'express';
import { Types } from 'mongoose';
import rateLimit from 'express-rate-limit';
import WebhookKey from '../models/WebhookKey';
import WebhookEvent from '../models/WebhookEvent';
import WebhookDelivery from '../models/WebhookDelivery';
import Workflow from '../models/Workflow';
import PlatformConnection from '../models/PlatformConnection';
import { workflowQueue } from '../queue';
import { decryptString, encryptJson, encryptString } from '../security/encryption';
import { redactHeaders } from '../services/redaction';
import { requireOrganizationId } from '../types/authenticatedRequest';
import { env } from '../env';
import { getConnectionCredential } from '../services/connectionCredentials';
import { requireIdempotency } from '../middleware/idempotency';
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor';
import { HttpError } from '../http/problem';
import { normalizedEvent, verifyActiveCampaign, verifyGhlHeaders, verifyHmac, verifyHubSpotV3, verifyKlaviyo } from '../services/webhookSecurity';
export { normalizedEvent, verifyActiveCampaign, verifyGhl, verifyGhlHeaders, verifyGhlLegacy, verifyHmac, verifyHubSpotV3, verifyKlaviyo } from '../services/webhookSecurity';

const router = Router();
const limiter = rateLimit({ windowMs: 60_000, max: 240, keyGenerator: (req: any) => `${req.ip}:${req.params.key || req.params.connectionId || 'unknown'}` });
const asyncRoute = (handler: any) => (req: any, res: any, next: any) => Promise.resolve(handler(req, res, next)).catch(next);
const keyAad = (organizationId: string, id: string) => `webhook-key:${organizationId}:${id}`;
const rawBody = (req: any) => req.rawBody || Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
function storedHeaders(headers: any) { const allowed = new Set(['content-type', 'user-agent', 'x-wh-signature', 'x-ghl-signature', 'x-hubspot-request-timestamp', 'x-hubspot-signature-v3', 'klaviyo-timestamp', 'klaviyo-signature', 'is_signature']); return redactHeaders(Object.fromEntries(Object.entries(headers || {}).filter(([key]) => allowed.has(key.toLowerCase())))); }
function triggerFor(provider: string, eventType: string, body: any) {
  const type = eventType.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (provider === 'generic') return 'trigger.webhook';
  if (provider === 'ghl') {
    const action = String(body?.action || body?.data?.action || '').toLowerCase();
    if (['contacttagremoved', 'contacttagremove', 'tagremoved', 'contactuntagged'].includes(type) || action === 'remove' || action === 'removed') return 'trigger.ghl.tagRemoved';
    if (['contacttagadded', 'contacttagadd', 'tagadded', 'contacttagassigned'].includes(type) || action === 'add' || action === 'added') return 'trigger.ghl.tagAssigned';
    if (['formsubmit', 'formsubmitted', 'contactformsubmitted'].includes(type)) return 'trigger.ghl.formSubmitted';
    if (['contactcreate', 'contactcreated'].includes(type)) return 'trigger.ghl.contactCreated';
    return 'trigger.platform_event';
  }
  return provider === 'hubspot' ? 'trigger.hubspot.event' : provider === 'klaviyo' ? 'trigger.klaviyo.event' : 'trigger.activecampaign.event';
}

export async function reconcileWebhookDeliveries(limit = 200) {
  // tenant-safe: worker-side delivery reconciliation; the organisation is carried on each delivery record
  const deliveries: any[] = await WebhookDelivery.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(limit);
  for (const delivery of deliveries) {
    try {
      await workflowQueue.add('webhook', { organizationId: String(delivery.organizationId), workflowId: String(delivery.workflowId), startNodeId: delivery.startNodeId, triggerKind: delivery.triggerKind, correlationId: crypto.randomUUID(), webhookEventId: String(delivery.webhookEventId), webhookDeliveryId: String(delivery._id) }, { jobId: `webhook-delivery-${delivery._id}`, attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 });
      delivery.status = 'queued'; delivery.attempts += 1; await delivery.save();
    } catch (error: any) { delivery.lastError = String(error.message).slice(0, 1_000); await delivery.save(); }
  }
}

async function persistAndQueue(input: { organizationId: string; provider: string; sourceId: string; connectionId?: string; workflowId?: string; body: any; bytes: Buffer; headers: any }) {
  const event = normalizedEvent(input.provider, input.body, input.bytes); const rowId = new Types.ObjectId(); let row: any;
  try { row = await WebhookEvent.create({ _id: rowId, organizationId: input.organizationId, sourceId: input.sourceId, connectionId: input.connectionId, ...event, payload: undefined, payloadCiphertext: encryptJson(event.payload, `webhook-event:${input.organizationId}:${rowId}`), headers: storedHeaders(input.headers), status: 'received' }); }
  catch (error: any) { if (error?.code === 11000) return { duplicate: true, eventId: event.eventId }; throw error; }
  const triggerKind = triggerFor(input.provider, event.eventType, input.body); const acceptedKinds = input.provider === 'generic' ? [triggerKind] : Array.from(new Set([triggerKind, 'trigger.platform_event']));
  const query: any = { organizationId: input.organizationId, status: 'published', 'nodes.data.kind': { $in: acceptedKinds } }; if (input.workflowId) query._id = input.workflowId;
  const workflows: any[] = await Workflow.find(query).select('_id nodes').lean(); const workflowIds: any[] = [];
  for (const workflow of workflows) {
    const trigger = workflow.nodes.find((node: any) => {
      const kind = String(node?.data?.kind || ''); const config = node?.data?.config || {};
      if (!acceptedKinds.includes(kind)) return false;
      if (input.connectionId && config.connectionId && String(config.connectionId) !== input.connectionId) return false;
      if (kind === 'trigger.platform_event' && (!input.connectionId || String(config.connectionId || '') !== input.connectionId)) return false;
      const configuredEvent = String(config.event || '').trim().toLowerCase();
      return !configuredEvent || configuredEvent === '*' || configuredEvent === event.eventType.toLowerCase();
    });
    if (!trigger) continue; workflowIds.push(workflow._id);
    await WebhookDelivery.create({ organizationId: input.organizationId, webhookEventId: row._id, workflowId: workflow._id, startNodeId: String(trigger.id), triggerKind: String(trigger.data.kind), status: 'pending' });
  }
  row.workflowIds = workflowIds; row.status = workflowIds.length ? 'queued' : 'processed'; await row.save(); await reconcileWebhookDeliveries();
  return { duplicate: false, eventId: event.eventId, queued: workflowIds.length, noSubscribers: workflowIds.length === 0 };
}

router.get('/keys', asyncRoute(async (req: any, res: any) => { const organizationId = requireOrganizationId(req); const limit = pageLimit(req.query.limit); const cursor = decodeCursor(req.query.cursor); const query: any = { organizationId }; if (cursor) query._id = { $lt: cursor }; const rows: any[] = await WebhookKey.find(query).sort({ _id: -1 }).limit(limit + 1).lean(); const hasMore = rows.length > limit; res.json({ items: rows.slice(0, limit).map((item: any) => ({ ...item, inboundUrl: `/api/v1/webhooks/inbound/${item.key}` })), nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null }); }));
router.post('/keys', requireIdempotency, asyncRoute(async (req: any, res: any) => { const organizationId = requireOrganizationId(req); const workflowId = req.body?.workflowId ? String(req.body.workflowId) : undefined; if (workflowId && (!Types.ObjectId.isValid(workflowId) || !await Workflow.exists({ _id: workflowId, organizationId }))) throw new HttpError(422, 'Invalid workflow', 'workflowId must reference a workflow in this organization'); const id = new Types.ObjectId(); const key = crypto.randomBytes(24).toString('base64url'); const secret = crypto.randomBytes(32).toString('base64url'); const row: any = await WebhookKey.create({ _id: id, organizationId, label: String(req.body?.label || 'Inbound').trim().slice(0, 160), key, hmacSecretCiphertext: encryptString(secret, keyAad(organizationId, String(id))), workflowId: workflowId || null, enabled: true, provider: 'generic' }); res.status(201).json({ id: row._id, label: row.label, key: row.key, secret, inboundUrl: `/api/v1/webhooks/inbound/${row.key}` }); }));
router.delete('/keys/:id', requireIdempotency, asyncRoute(async (req: any, res: any) => { const row = await WebhookKey.findOneAndDelete({ _id: req.params.id, organizationId: requireOrganizationId(req) }); if (!row) throw new HttpError(404, 'Webhook key not found', 'Webhook key not found'); res.status(204).end(); }));
// tenant-safe: public inbound endpoint; the unguessable key is the tenant identifier and the organisation is derived from it
router.post('/inbound/:key', limiter, asyncRoute(async (req: any, res: any) => { const row: any = await WebhookKey.findOne({ key: req.params.key, enabled: true }).select('+hmacSecretCiphertext'); if (!row) throw new HttpError(404, 'Invalid webhook key', 'Invalid webhook key'); const bytes = rawBody(req); const secret = decryptString(row.hmacSecretCiphertext, keyAad(String(row.organizationId), String(row._id))); const signature = String(req.headers['x-logicflower-signature'] || ''); if (!signature || !verifyHmac(bytes, signature, secret)) throw new HttpError(401, 'Invalid webhook signature', 'Invalid webhook signature'); const payload = { ...req.body, eventId: String(req.headers['x-idempotency-key'] || crypto.createHash('sha256').update(bytes).digest('hex')), event: req.body?.event || 'generic.webhook' }; const result = await persistAndQueue({ organizationId: String(row.organizationId), provider: 'generic', sourceId: String(row._id), workflowId: row.workflowId ? String(row.workflowId) : undefined, body: payload, bytes, headers: req.headers }); res.status(result.duplicate ? 200 : 202).json(result); }));
router.post('/provider/:provider/:connectionId', limiter, asyncRoute(async (req: any, res: any) => {
  const provider = String(req.params.provider).toLowerCase();
  if (!['ghl', 'hubspot', 'klaviyo', 'activecampaign'].includes(provider)) throw new HttpError(404, 'Unsupported webhook provider', 'Unsupported webhook provider');
  // tenant-safe: public inbound endpoint; provider signature verification is the authorisation gate and the organisation is derived from the matched connection
  const connection: any = await PlatformConnection.findOne({ _id: req.params.connectionId, provider, status: { $in: ['active', 'degraded', 'error'] } }).lean();
  if (!connection) throw new HttpError(404, 'Connection not found', 'Connection not found');
  const organizationId = String(connection.organizationId); const connectionId = String(connection._id); const bytes = rawBody(req); let verified = false;
  if (provider === 'ghl') verified = verifyGhlHeaders(bytes, req.headers, { maximumAgeMs: env.WEBHOOK_MAX_AGE_SECONDS * 1_000 });
  else {
    const credential: any = await getConnectionCredential({ organizationId, provider: provider as any, connectionId });
    const webhookSecret = String(credential?.metadata?.webhookSecret || '');
    if (provider === 'hubspot') {
      const secret = webhookSecret || String(env.HUBSPOT_CLIENT_SECRET || '');
      if (!secret) throw new HttpError(503, 'Webhook verification unavailable', 'HubSpot webhook verification is not configured for this connection', 'about:blank', true);
      const absoluteUri = new URL(req.originalUrl, env.API_URL).toString();
      verified = verifyHubSpotV3({ secret, method: req.method, absoluteUri, body: bytes, timestamp: String(req.headers['x-hubspot-request-timestamp'] || ''), signature: String(req.headers['x-hubspot-signature-v3'] || ''), maximumAgeMs: env.WEBHOOK_MAX_AGE_SECONDS * 1_000 });
    } else if (provider === 'klaviyo') {
      if (!webhookSecret) throw new HttpError(503, 'Webhook verification unavailable', 'Klaviyo webhook verification is not configured for this connection', 'about:blank', true);
      verified = verifyKlaviyo({ secret: webhookSecret, body: bytes, timestamp: String(req.headers['klaviyo-timestamp'] || ''), signature: String(req.headers['klaviyo-signature'] || ''), maximumAgeMs: env.WEBHOOK_MAX_AGE_SECONDS * 1_000 });
    } else {
      if (!webhookSecret) throw new HttpError(503, 'Webhook verification unavailable', 'ActiveCampaign webhookSecret is not configured for this connection', 'about:blank', true);
      const headerName = String(credential?.metadata?.webhookHeaderName || 'x-logicflower-signature').toLowerCase();
      verified = verifyActiveCampaign({ secret: webhookSecret, body: bytes, signature: String(req.headers[headerName] || ''), maximumAgeMs: env.WEBHOOK_MAX_AGE_SECONDS * 1_000 });
    }
  }
  if (!verified) throw new HttpError(401, 'Invalid webhook signature', 'Invalid webhook signature');
  const bodies = Array.isArray(req.body) ? req.body : [req.body || {}]; const results: any[] = [];
  for (let index = 0; index < bodies.length; index += 1) {
    const body = bodies[index] && typeof bodies[index] === 'object' ? { ...bodies[index] } : { value: bodies[index] };
    if (!body.webhookId && !body.eventId && bodies.length > 1) body.eventId = `${crypto.createHash('sha256').update(bytes).digest('hex')}:${index}`;
    results.push(await persistAndQueue({ organizationId, provider, sourceId: connectionId, connectionId, body, bytes, headers: req.headers }));
  }
  const duplicate = results.every(result => result.duplicate); const queued = results.reduce((sum, result) => sum + Number(result.queued || 0), 0);
  res.status(duplicate ? 200 : 202).json({ duplicate, queued, events: results });
}));

export const rawWebhookBodyContract = { paths: ['/api/v1/webhooks/inbound', '/api/v1/webhooks/provider'], verify: (req: any, _res: any, buffer: Buffer) => { req.rawBody = Buffer.from(buffer); } };
export default router;
