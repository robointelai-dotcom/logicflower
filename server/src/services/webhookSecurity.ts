import crypto from 'crypto';
import { env } from '../env';

const DEFAULT_GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=\n-----END PUBLIC KEY-----`;
const DEFAULT_GHL_LEGACY_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKU
J062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXp
IocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzN
h/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhC
HULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJ
PQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAyk
T1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----`;

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function freshTimestamp(value: string, now: number, maximumAgeMs: number) {
  const parsed = Number(value); if (!Number.isFinite(parsed)) return false;
  const milliseconds = parsed > 1e12 ? parsed : parsed * 1_000;
  return Math.abs(now - milliseconds) <= maximumAgeMs;
}

/**
 * Resolve a provider public key, preferring a configured override.
 *
 * The keys below are the published HighLevel values, embedded so the system
 * works out of the box. Hardcoding them alone would mean a provider key
 * rotation requires a code change and a redeploy, during which every inbound
 * webhook fails verification. The override lets an operator paste the new key
 * into configuration and restart.
 *
 * `\n` escapes are normalised so a key can be supplied as a single-line
 * environment variable, which is how secret stores and container platforms
 * usually hold PEM material.
 */
function resolvePublicKey(configured: string | undefined, fallback: string): string {
  const value = String(configured || '').trim();
  if (!value) return fallback;
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

export function ghlEd25519PublicKey(): string {
  return resolvePublicKey(env.GHL_WEBHOOK_PUBLIC_KEY, DEFAULT_GHL_ED25519_PUBLIC_KEY);
}

export function ghlLegacyRsaPublicKey(): string {
  return resolvePublicKey(env.GHL_LEGACY_WEBHOOK_PUBLIC_KEY, DEFAULT_GHL_LEGACY_RSA_PUBLIC_KEY);
}

/**
 * Extract an event timestamp from a provider payload.
 *
 * HighLevel and ActiveCampaign do not send a dedicated signature-timestamp
 * header the way HubSpot and Klaviyo do, so freshness is evaluated against the
 * timestamp inside the signed body. That is still a real defence: the value is
 * covered by the signature, so an attacker replaying a captured request cannot
 * advance it without invalidating the signature.
 */
export function payloadTimestamp(body: Buffer): number | null {
  let parsed: any;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
  const candidate = parsed?.timestamp ?? parsed?.occurredAt ?? parsed?.createdAt ?? parsed?.date_created ?? parsed?.eventTime;
  if (candidate === undefined || candidate === null) return null;
  const numeric = Number(candidate);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1_000;
  const parsedDate = new Date(String(candidate)).getTime();
  return Number.isFinite(parsedDate) ? parsedDate : null;
}

export type FreshnessResult = { fresh: boolean; reason: 'fresh' | 'stale' | 'no_timestamp' };

/**
 * Evaluate replay freshness for a provider that has no timestamp header.
 *
 * When the payload carries no usable timestamp the result is `no_timestamp`
 * rather than a silent pass. The caller decides the policy, and the default
 * (WEBHOOK_REQUIRE_TIMESTAMP) is to reject, because durable event-id
 * de-duplication alone stops being a replay defence once the retention worker
 * purges the event record.
 */
export function evaluateBodyFreshness(body: Buffer, now = Date.now(), maximumAgeMs = env.WEBHOOK_MAX_AGE_SECONDS * 1_000): FreshnessResult {
  const timestamp = payloadTimestamp(body);
  if (timestamp === null) return { fresh: false, reason: 'no_timestamp' };
  return Math.abs(now - timestamp) <= maximumAgeMs ? { fresh: true, reason: 'fresh' } : { fresh: false, reason: 'stale' };
}

export function verifyHmac(body: Buffer, signature: string, secret: string) {
  return safeEqual(signature.replace(/^sha256=/i, '').trim().toLowerCase(), crypto.createHmac('sha256', secret).update(body).digest('hex'));
}

export function verifyGhl(body: Buffer, signature: string, publicKey = ghlEd25519PublicKey()) {
  if (!signature || signature === 'N/A') return false;
  try { return crypto.verify(null, body, publicKey, Buffer.from(signature.trim(), 'base64')); } catch { return false; }
}

export function verifyGhlLegacy(body: Buffer, signature: string, publicKey = ghlLegacyRsaPublicKey()) {
  if (!signature || signature === 'N/A') return false;
  try { return crypto.verify('sha256', body, publicKey, Buffer.from(signature.trim(), 'base64')); } catch { return false; }
}

/**
 * HighLevel signature verification with replay freshness.
 *
 * Signature alone is not replay defence: a captured request stays validly
 * signed forever. The original implementation relied entirely on the
 * WebhookEvent unique index, which the retention worker deletes at the plan
 * cutoff — seven days on Starter — after which the same captured request
 * replays and re-executes the subscribed workflow.
 */
export function verifyGhlHeaders(
  body: Buffer,
  headers: Record<string, string | string[] | undefined>,
  options: { now?: number; maximumAgeMs?: number; requireTimestamp?: boolean } = {},
): boolean {
  const current = String(headers['x-ghl-signature'] || '');
  const signatureValid = current
    ? verifyGhl(body, current)
    : verifyGhlLegacy(body, String(headers['x-wh-signature'] || ''));
  if (!signatureValid) return false;

  const freshness = evaluateBodyFreshness(body, options.now ?? Date.now(), options.maximumAgeMs ?? env.WEBHOOK_MAX_AGE_SECONDS * 1_000);
  if (freshness.reason === 'stale') return false;
  if (freshness.reason === 'no_timestamp') {
    const require = options.requireTimestamp ?? env.WEBHOOK_REQUIRE_TIMESTAMP;
    return !require;
  }
  return true;
}

export function verifyHubSpotV3(input: { secret: string; method: string; absoluteUri: string; body: Buffer; timestamp: string; signature: string; now?: number; maximumAgeMs?: number }) {
  if (!input.secret || !input.signature || !freshTimestamp(input.timestamp, input.now ?? Date.now(), input.maximumAgeMs ?? 300_000)) return false;
  // HubSpot requires decoding only this documented allowlist, not arbitrary URI escapes.
  const decodedUri = input.absoluteUri.replace(/%(?:3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (encoded) =>
    String.fromCharCode(Number.parseInt(encoded.slice(1), 16)));
  const source = Buffer.concat([Buffer.from(input.method.toUpperCase()), Buffer.from(decodedUri), input.body, Buffer.from(input.timestamp)]);
  const expected = crypto.createHmac('sha256', input.secret).update(source).digest('base64');
  return safeEqual(input.signature.trim(), expected);
}

export function verifyKlaviyo(input: { secret: string; body: Buffer; timestamp: string; signature: string; now?: number; maximumAgeMs?: number }) {
  if (!input.secret || !input.signature || !freshTimestamp(input.timestamp, input.now ?? Date.now(), input.maximumAgeMs ?? 300_000)) return false;
  // Klaviyo signs the exact raw request body followed by the timestamp bytes.
  const expected = crypto.createHmac('sha256', input.secret).update(input.body).update(input.timestamp).digest('hex');
  const candidates = input.signature.split(/[ ,]+/).map(value => value.replace(/^v\d+=/i, '').trim()).filter(Boolean);
  return candidates.some(candidate => safeEqual(candidate.toLowerCase(), expected));
}

export function verifyActiveCampaign(input: {
  secret: string;
  body: Buffer;
  signature: string;
  now?: number;
  maximumAgeMs?: number;
  requireTimestamp?: boolean;
}): boolean {
  if (!input.secret || !input.signature) return false;
  const expected = crypto.createHmac('sha256', input.secret).update(input.body).digest('hex');
  if (!safeEqual(input.signature.replace(/^sha256=/i, '').trim().toLowerCase(), expected)) return false;

  const freshness = evaluateBodyFreshness(input.body, input.now ?? Date.now(), input.maximumAgeMs ?? env.WEBHOOK_MAX_AGE_SECONDS * 1_000);
  if (freshness.reason === 'stale') return false;
  if (freshness.reason === 'no_timestamp') return !(input.requireTimestamp ?? env.WEBHOOK_REQUIRE_TIMESTAMP);
  return true;
}

export function normalizedEvent(provider: string, body: any, bytes: Buffer) {
  const eventId = String(body?.webhookId || body?.eventId || crypto.createHash('sha256').update(bytes).digest('hex'));
  const eventType = String(body?.type || body?.event || body?.subscriptionType || body?.topic || 'unknown');
  let occurredAt = new Date();
  const sourceTimestamp = body?.timestamp ?? body?.occurredAt;
  if (sourceTimestamp) {
    const numeric = Number(sourceTimestamp);
    occurredAt = Number.isFinite(numeric) ? new Date(numeric > 1e12 ? numeric : numeric * 1_000) : new Date(String(sourceTimestamp));
    if (Number.isNaN(occurredAt.getTime())) occurredAt = new Date();
  }
  return { provider, eventId, eventType, occurredAt, subject: { contactId: body?.contactId || body?.objectId || body?.data?.id, locationId: body?.locationId, accountId: body?.portalId || body?.accountId }, payload: body };
}
