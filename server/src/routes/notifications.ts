import { Router } from 'express';
import { z } from 'zod';
import NotificationChannel from '../models/NotificationChannel';
import { decryptJson, encryptJson } from '../security/encryption';
import { sendConfiguredNotification } from '../services/notifications';
import { validateOutboundUrl } from '../services/ssrfGuard';
import { recordAudit } from '../services/audit';
import { HttpError } from '../http/problem';
import { requireOrganizationId, requestCorrelationId } from '../types/authenticatedRequest';
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor';

const router = Router(); const asyncRoute = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
const EVENTS = ['incident.created', 'incident.resolved', 'connection.failed', 'workflow.changed', 'batch.failed'] as const;
const configSchema = z.object({ recipients: z.array(z.string().email()).max(20).optional(), url: z.string().url().max(2_048).optional() }).strict();
const inputSchema = z.object({
  name: z.string().trim().min(1).max(160).refine(value => !/[\r\n]/.test(value)).optional(),
  type: z.enum(['email', 'slack', 'webhook']).optional(),
  destination: z.string().trim().max(2_048).optional(),
  config: configSchema.optional(),
  events: z.array(z.enum(EVENTS)).min(1).max(EVENTS.length).optional(),
  minimumSeverity: z.enum(['info', 'warning', 'critical']).optional(),
  signingSecret: z.string().min(16).max(512).optional(),
  enabled: z.boolean().optional(),
}).strict();

function parseInput(body: any) { const result = inputSchema.safeParse(body); if (!result.success) throw new HttpError(400, 'Invalid notification channel', result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')); return result.data; }
function requireAdmin(req: any) { if (!['owner', 'admin'].includes(String(req.auth?.role || ''))) throw new HttpError(403, 'Insufficient role', 'Owner or admin role required'); }
function publicChannel(value: any) { const item = value.toObject ? value.toObject() : { ...value }; delete item.secretCiphertext; delete item.config?.recipients; return { ...item, id: String(item._id), verified: item.status === 'verified' }; }
function suppliedDestination(body: z.infer<typeof inputSchema>, type: string) {
  if (body.destination) return body.destination;
  if (type === 'email' && body.config?.recipients?.length) return body.config.recipients.join(',');
  return body.config?.url || '';
}
async function validatedChannel(input: { type: string; name: string; destination: string; events?: readonly string[]; minimumSeverity?: string; signingSecret?: string }) {
  const { type, name } = input; const destination = String(input.destination || '').trim();
  if (!['email', 'slack', 'webhook'].includes(type) || !name || !destination) throw new HttpError(400, 'Invalid notification channel', 'name, valid type, and destination are required');
  const events = input.events?.length ? Array.from(new Set(input.events)) : ['incident.created'];
  if (type === 'email') {
    const recipients = destination.split(',').map(item => item.trim().toLowerCase()).filter(Boolean); const invalid = recipients.some(email => !z.string().email().safeParse(email).success);
    if (!recipients.length || recipients.length > 20 || invalid) throw new HttpError(400, 'Invalid recipients', 'Destination must contain one to twenty valid email addresses');
    return { type, name, events, config: { recipientCount: recipients.length }, secret: { recipients }, masked: recipients.map(email => email.replace(/^(.).+(@.+)$/, '$1***$2')).join(', ') };
  }
  const checked = await validateOutboundUrl(destination);
  if (type === 'slack' && !['hooks.slack.com', 'hooks.slack-gov.com'].includes(checked.url.hostname.toLowerCase())) throw new HttpError(400, 'Invalid Slack destination', 'Slack destination must use an official Slack webhook host');
  return { type, name, events, config: {}, secret: { url: checked.url.toString(), pinnedAddresses: checked.addresses, ...(input.signingSecret ? { signingSecret: input.signingSecret } : {}) }, masked: `${checked.url.protocol}//${checked.url.hostname}/***` };
}

router.get('/channels', asyncRoute(async (req: any, res: any) => { const limit = pageLimit(req.query.limit); const cursor = decodeCursor(req.query.cursor); const query: any = { organizationId: requireOrganizationId(req) }; if (cursor) query._id = { $lt: cursor }; const rows: any[] = await NotificationChannel.find(query).sort({ _id: -1 }).limit(limit + 1).lean(); const hasMore = rows.length > limit; res.json({ items: rows.slice(0, limit).map(publicChannel), nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null }); }));
router.post('/channels', asyncRoute(async (req: any, res: any) => {
  requireAdmin(req); const organizationId = requireOrganizationId(req); const body = parseInput(req.body); const type = String(body.type || ''); const name = String(body.name || '');
  const input = await validatedChannel({ type, name, destination: suppliedDestination(body, type), events: body.events, minimumSeverity: body.minimumSeverity, signingSecret: body.signingSecret });
  const channel: any = new NotificationChannel({ organizationId, type: input.type, name: input.name, config: input.config, events: input.events, destinationMasked: input.masked, minimumSeverity: body.minimumSeverity || 'warning', status: 'unverified', enabled: body.enabled !== false });
  channel.secretCiphertext = encryptJson(input.secret, `notification-channel:${organizationId}:${channel._id}`); await channel.save();
  await recordAudit({ req, organizationId, action: 'notification_channel.create', entityType: 'NotificationChannel', entityId: String(channel._id) }); res.status(201).json(publicChannel(channel));
}));
router.patch('/channels/:id', asyncRoute(async (req: any, res: any) => {
  requireAdmin(req); const organizationId = requireOrganizationId(req); const body = parseInput(req.body); const current: any = await NotificationChannel.findOne({ _id: req.params.id, organizationId }).select('+secretCiphertext');
  if (!current) throw new HttpError(404, 'Channel not found', 'Channel not found'); if (body.type && body.type !== current.type) throw new HttpError(409, 'Channel type cannot change', 'Create a new channel to change its type');
  const oldSecret = current.secretCiphertext ? decryptJson<any>(current.secretCiphertext, `notification-channel:${organizationId}:${current._id}`) : {};
  const providedDestination = suppliedDestination(body, current.type); const destination = providedDestination || (current.type === 'email' ? (oldSecret.recipients || []).join(',') : oldSecret.url);
  const input = await validatedChannel({ type: current.type, name: String(body.name || current.name), destination, events: body.events || current.events, minimumSeverity: body.minimumSeverity || current.minimumSeverity, signingSecret: body.signingSecret || oldSecret.signingSecret });
  const destinationChanged = Boolean(providedDestination || body.signingSecret); current.name = input.name; current.config = input.config; current.events = input.events; current.destinationMasked = input.masked; current.minimumSeverity = body.minimumSeverity || current.minimumSeverity; if (body.enabled !== undefined) current.enabled = body.enabled;
  if (destinationChanged) { current.secretCiphertext = encryptJson(input.secret, `notification-channel:${organizationId}:${current._id}`); current.status = 'unverified'; current.verifiedAt = undefined; }
  await current.save(); await recordAudit({ req, organizationId, action: 'notification_channel.update', entityType: 'NotificationChannel', entityId: String(current._id) }); res.json(publicChannel(current));
}));
router.delete('/channels/:id', asyncRoute(async (req: any, res: any) => { requireAdmin(req); const organizationId = requireOrganizationId(req); const channel = await NotificationChannel.findOneAndDelete({ _id: req.params.id, organizationId }); if (!channel) throw new HttpError(404, 'Channel not found', 'Channel not found'); await recordAudit({ req, organizationId, action: 'notification_channel.delete', entityType: 'NotificationChannel', entityId: String(channel._id) }); res.status(204).end(); }));
router.post('/channels/:id/test', asyncRoute(async (req: any, res: any) => {
  requireAdmin(req); const organizationId = requireOrganizationId(req); const result = await sendConfiguredNotification({ organizationId, channelId: req.params.id, subject: 'LogicFlower test notification', message: 'Your notification channel is working.', correlationId: requestCorrelationId(req), allowUnverified: true });
  await NotificationChannel.updateOne({ _id: req.params.id, organizationId }, { $set: { status: 'verified', verifiedAt: new Date(), lastTestedAt: new Date() } });
  await recordAudit({ req, organizationId, action: 'notification_channel.verified', entityType: 'NotificationChannel', entityId: req.params.id }); res.json(result);
}));
export default router;
