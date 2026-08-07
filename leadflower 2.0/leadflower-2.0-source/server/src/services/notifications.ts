import axios from 'axios';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import NotificationChannel from '../models/NotificationChannel';
import Alert from '../models/Alert';
import { notificationQueue } from '../queue';
import { env } from '../env';
import { decryptJson } from '../security/encryption';
import { pinnedHttpsAgent, validateOutboundUrl } from './ssrfGuard';

let smtpTransport: any;
function mailTransport() {
  if (!smtpTransport) smtpTransport = nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined });
  return smtpTransport;
}

export async function sendConfiguredNotification(input: { organizationId: string; channelId: string; subject: string; message: string; correlationId?: string; allowUnverified?: boolean }) {
  const channel: any = await NotificationChannel.findOne({ _id: input.channelId, organizationId: input.organizationId, enabled: true, ...(input.allowUnverified ? {} : { status: 'verified' }) }).select('+secretCiphertext');
  if (!channel) throw new Error('Notification channel not found or disabled');
  const secret = channel.secretCiphertext ? decryptJson<any>(channel.secretCiphertext, `notification-channel:${input.organizationId}:${channel._id}`) : {};
  if (channel.type === 'email') {
    if (!env.SMTP_HOST) throw new Error('SMTP is not configured');
    const recipients = Array.isArray(secret.recipients) ? secret.recipients : Array.isArray(channel.config?.recipients) ? channel.config.recipients : [];
    if (!recipients.length) throw new Error('Email notification channel has no recipients');
    const result = await mailTransport().sendMail({ from: env.EMAIL_FROM, to: recipients.join(','), subject: input.subject.replace(/[\r\n]+/g, ' ').slice(0, 200), text: input.message.slice(0, 50_000), headers: input.correlationId ? { 'X-Correlation-ID': input.correlationId } : undefined });
    return { ok: true, messageId: result.messageId };
  }
  if (!secret.url) throw new Error('Webhook notification URL is not configured');
  const validated = await validateOutboundUrl(String(secret.url));
  const payload = channel.type === 'slack' ? { text: `*${input.subject.replace(/[\r\n]+/g, ' ').slice(0, 200)}*\n${input.message.slice(0, 30_000)}` } : { subject: input.subject.replace(/[\r\n]+/g, ' ').slice(0, 200), message: input.message.slice(0, 50_000), correlationId: input.correlationId };
  if (channel.type === 'slack' && !['hooks.slack.com', 'hooks.slack-gov.com'].includes(validated.url.hostname.toLowerCase())) throw new Error('Slack channels require an official Slack webhook host');
  const response = await axios.post(validated.url.toString(), payload, { timeout: 15_000, maxRedirects: 0, maxContentLength: 256_000, httpsAgent: pinnedHttpsAgent(validated), headers: secret.signingSecret ? { 'X-LogicFlower-Signature': crypto.createHmac('sha256', secret.signingSecret).update(JSON.stringify(payload)).digest('hex') } : undefined });
  return { ok: true, status: response.status };
}

export async function reconcileNotificationAlerts(limit = 200) {
  const now = new Date(); const stale = new Date(Date.now() - 5 * 60_000);
  // tenant-safe: cross-tenant alert outbox worker
  await Alert.updateMany({ status: 'sending', attemptCount: { $lt: 5 }, lastAttemptAt: { $lt: stale } }, { $set: { status: 'queued', nextAttemptAt: now } });
  // tenant-safe: cross-tenant alert outbox worker
  await Alert.updateMany({ status: 'failed', attemptCount: { $lt: 5 } }, { $set: { status: 'queued', nextAttemptAt: now } });
  // tenant-safe: cross-tenant alert outbox worker
  const alerts: any[] = await Alert.find({ status: 'queued', $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] }).sort({ createdAt: 1 }).limit(Math.min(500, Math.max(1, limit))).select('_id organizationId attemptCount').lean();
  for (const alert of alerts) {
    await notificationQueue.add('incident-alert', { organizationId: String(alert.organizationId), alertId: String(alert._id) }, { jobId: `alert-${alert._id}-${Number(alert.attemptCount || 0) + 1}`, attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 });
  }
  return alerts.length;
}
