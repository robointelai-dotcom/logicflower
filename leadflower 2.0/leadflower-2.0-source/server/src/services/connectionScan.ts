import crypto from 'crypto';
import ConnectionScan from '../models/ConnectionScan';
import PlatformConnection from '../models/PlatformConnection';
import { connectionScanQueue } from '../queue';
import { createConnector, ConnectorProvider } from './connectors';
import type { PlatformProvider } from '../models/PlatformConnection';
import { normalizeEmail, normalizePhone } from './batchNormalization';
import pino from '../logger';
import { env } from '../env';

/**
 * Default onboarding scan ceiling.
 *
 * The report's conversion moment ("you have 3,140 duplicate contacts") assumes
 * an account-wide figure, but an unbounded first-run scan against a large
 * account is slow and burns provider rate budget. The cap is therefore a
 * default rather than a constant: raise it per deployment, or per organisation
 * once a paid plan justifies the read volume. Truncation is always reported.
 */
export const CONNECTION_SCAN_LIMIT = 5_000;

export function resolveScanLimit(input: { organizationLimit?: number | null } = {}): number {
  const configured = Number(input.organizationLimit ?? env.CONNECTION_SCAN_LIMIT);
  if (!Number.isFinite(configured) || configured < 100) return CONNECTION_SCAN_LIMIT;
  return Math.min(env.CONNECTION_SCAN_MAX_LIMIT, Math.floor(configured));
}
const SCANNABLE = new Set<PlatformProvider>(['ghl', 'hubspot', 'klaviyo', 'activecampaign']);

function queueId(id: string) { return `connection-scan-${id}`; }
function safeScan(scan: any) {
  const source = scan?.toObject ? scan.toObject() : scan;
  return { ...source, id: String(source._id), connectionId: String(source.connectionId) };
}

export async function queueConnectionScan(input: { organizationId: string; connectionId: string; provider: PlatformProvider; reason?: 'connection' | 'reauthorization' | 'manual' }) {
  if (!SCANNABLE.has(input.provider)) return null;
  const active: any = await ConnectionScan.findOne({ organizationId: input.organizationId, connectionId: input.connectionId, status: { $in: ['queued', 'running'] } }).sort({ createdAt: -1 });
  const scan: any = active || await ConnectionScan.create({ ...input, sampleLimit: resolveScanLimit(), status: 'queued' });
  try {
    await connectionScanQueue.add('scan', { organizationId: input.organizationId, connectionId: input.connectionId, provider: input.provider, scanId: String(scan._id) }, { jobId: queueId(String(scan._id)), attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 });
  } catch (error) {
    pino.error({ err: error, organizationId: input.organizationId, connectionId: input.connectionId, scanId: String(scan._id) }, 'connection scan enqueue failed; maintenance will retry');
  }
  return safeScan(scan);
}

export async function runConnectionScan(input: { organizationId: string; connectionId: string; provider: ConnectorProvider; scanId: string }) {
  const connection = await PlatformConnection.exists({ _id: input.connectionId, organizationId: input.organizationId, provider: input.provider, status: { $in: ['active', 'degraded'] } });
  if (!connection) throw new Error('Scannable connection does not belong to the job organization');
  const scan: any = await ConnectionScan.findOneAndUpdate({ _id: input.scanId, organizationId: input.organizationId, connectionId: input.connectionId, status: 'queued' }, { $set: { status: 'running', startedAt: new Date(), error: null } }, { new: true });
  if (!scan) {
    const existing: any = await ConnectionScan.findOne({ _id: input.scanId, organizationId: input.organizationId, connectionId: input.connectionId });
    if (existing?.status === 'completed') return safeScan(existing);
    throw new Error('Connection scan is unavailable or already running');
  }
  try {
    const connector = await createConnector({ organizationId: input.organizationId, provider: input.provider, connectionId: input.connectionId });
    if (!connector.listContactsPage) throw new Error(`${input.provider} does not support a safe contact inventory scan`);
    const emailRecords = new Map<string, Set<number>>(); const phoneRecords = new Map<string, Set<number>>();
    let cursor: string | undefined; let scanned = 0; let invalidEmails = 0; let invalidPhones = 0; let missingPrimaryIdentifier = 0; let truncated = false;
    const seenCursors = new Set<string>();
    const scanLimit = resolveScanLimit({ organizationLimit: scan.sampleLimit });
    while (scanned < scanLimit) {
      const page = await connector.listContactsPage(cursor, Math.min(100, scanLimit - scanned));
      if (!page.contacts.length) break;
      for (const contact of page.contacts) {
        if (scanned >= scanLimit) { truncated = true; break; }
        const recordIndex = scanned; scanned += 1;
        const rawEmail = String(contact.email || '').trim(); const rawPhone = String(contact.phone || '').trim();
        const email = normalizeEmail(rawEmail); const phone = normalizePhone(rawPhone);
        if (rawEmail && !email) invalidEmails += 1;
        if (rawPhone && !phone) invalidPhones += 1;
        if (!email && !phone) missingPrimaryIdentifier += 1;
        if (email) { const hash = crypto.createHash('sha256').update(`email:${email}`).digest('hex'); const records = emailRecords.get(hash) || new Set<number>(); records.add(recordIndex); emailRecords.set(hash, records); }
        if (phone) { const hash = crypto.createHash('sha256').update(`phone:${phone}`).digest('hex'); const records = phoneRecords.get(hash) || new Set<number>(); records.add(recordIndex); phoneRecords.set(hash, records); }
      }
      if (!page.nextCursor) break;
      if (seenCursors.has(page.nextCursor)) throw new Error('Provider returned a repeated pagination cursor');
      seenCursors.add(page.nextCursor); cursor = page.nextCursor;
      if (scanned >= scanLimit) truncated = true;
    }
    const duplicateSets = [...emailRecords.values(), ...phoneRecords.values()].filter((records) => records.size > 1);
    const duplicateRecordIds = new Set<number>(); for (const records of duplicateSets) for (const index of records) duplicateRecordIds.add(index);
    scan.status = 'completed'; scan.scannedCount = scanned; scan.duplicateGroups = duplicateSets.length; scan.duplicateRecords = duplicateRecordIds.size;
    scan.invalidEmails = invalidEmails; scan.invalidPhones = invalidPhones; scan.missingPrimaryIdentifier = missingPrimaryIdentifier; scan.truncated = truncated;
    scan.completedAt = new Date(); await scan.save(); return safeScan(scan);
  } catch (error) {
    scan.status = 'failed'; scan.error = { code: 'CONNECTION_SCAN_FAILED', message: 'The provider inventory scan could not be completed' }; scan.completedAt = new Date(); await scan.save();
    pino.error({ err: error, organizationId: input.organizationId, connectionId: input.connectionId, scanId: input.scanId }, 'connection scan failed');
    throw error;
  }
}

export async function reconcileConnectionScans(limit = 100) {
  const stale = new Date(Date.now() - 10 * 60_000);
  // tenant-safe: cross-tenant scan reconciliation worker
  await ConnectionScan.updateMany({ status: 'running', updatedAt: { $lt: stale } }, { $set: { status: 'queued', error: { code: 'STALE_SCAN_RECOVERED', message: 'The interrupted scan was safely requeued' } } });
  // tenant-safe: cross-tenant scan reconciliation worker; each scan carries its own organisation
  const scans: any[] = await ConnectionScan.find({ status: 'queued' }).sort({ createdAt: 1 }).limit(Math.min(500, Math.max(1, limit))).lean();
  for (const scan of scans) await connectionScanQueue.add('scan', { organizationId: String(scan.organizationId), connectionId: String(scan.connectionId), provider: scan.provider, scanId: String(scan._id) }, { jobId: queueId(String(scan._id)), attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 }).catch(() => undefined);
  return scans.length;
}

export { safeScan as serializeConnectionScan };
