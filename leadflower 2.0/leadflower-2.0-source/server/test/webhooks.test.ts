import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { normalizedEvent, verifyActiveCampaign, verifyGhl, verifyGhlLegacy, verifyHmac, verifyHubSpotV3, verifyKlaviyo } from '../src/services/webhookSecurity';

describe('signed webhook ingress', () => {
  it('accepts only a matching HMAC over the exact raw bytes', () => {
    const secret = 'test-secret'; const body = Buffer.from('{"event":"contact.updated","value":1}');
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyHmac(body, `sha256=${signature}`, secret)).toBe(true);
    expect(verifyHmac(Buffer.from('{"event":"contact.updated","value":2}'), signature, secret)).toBe(false);
    expect(verifyHmac(body, '00', secret)).toBe(false);
  });

  it('rejects an invalid HighLevel Ed25519 signature', () => {
    expect(verifyGhl(Buffer.from('{"type":"ContactCreate"}'), crypto.randomBytes(64).toString('base64'))).toBe(false);
  });

  it('verifies both current Ed25519 and legacy RSA HighLevel signature algorithms', () => {
    const body = Buffer.from('{"type":"ContactCreate","id":"contact-1"}');
    const ed = crypto.generateKeyPairSync('ed25519');
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const edSignature = crypto.sign(null, body, ed.privateKey).toString('base64');
    const rsaSignature = crypto.sign('sha256', body, rsa.privateKey).toString('base64');
    expect(verifyGhl(body, edSignature, ed.publicKey.export({ format: 'pem', type: 'spki' }).toString())).toBe(true);
    expect(verifyGhlLegacy(body, rsaSignature, rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString())).toBe(true);
    expect(verifyGhlLegacy(Buffer.from('{}'), rsaSignature, rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString())).toBe(false);
  });

  it('derives a stable duplicate identity and never trusts a generic body id', () => {
    const bytes = Buffer.from('{"id":"customer-record","event":"contact.updated"}');
    const first = normalizedEvent('generic', { id: 'customer-record', event: 'contact.updated' }, bytes);
    const second = normalizedEvent('generic', { id: 'customer-record', event: 'contact.updated' }, bytes);
    expect(first.eventId).toBe(second.eventId);
    expect(first.eventId).not.toBe('customer-record');
  });

  it('verifies HubSpot v3 using the decoded absolute URI and a fresh timestamp', () => {
    const body = Buffer.from('{"eventId":10}'); const secret = 'hubspot-secret'; const timestamp = '1760000000000'; const absoluteUri = 'https://api.example.test/hooks/contact%2Fupdated';
    const source = Buffer.concat([Buffer.from('POST'), Buffer.from('https://api.example.test/hooks/contact/updated'), body, Buffer.from(timestamp)]);
    const signature = crypto.createHmac('sha256', secret).update(source).digest('base64');
    expect(verifyHubSpotV3({ secret, method: 'POST', absoluteUri, body, timestamp, signature, now: Number(timestamp) + 10_000 })).toBe(true);
    expect(verifyHubSpotV3({ secret, method: 'POST', absoluteUri, body, timestamp, signature, now: Number(timestamp) + 301_000 })).toBe(false);
    const reservedEscapeUri = 'https://api.example.test/hooks/value%26other';
    const reservedSource = Buffer.concat([Buffer.from('POST'), Buffer.from(reservedEscapeUri), body, Buffer.from(timestamp)]);
    const reservedSignature = crypto.createHmac('sha256', secret).update(reservedSource).digest('base64');
    expect(verifyHubSpotV3({ secret, method: 'POST', absoluteUri: reservedEscapeUri, body, timestamp, signature: reservedSignature, now: Number(timestamp) })).toBe(true);
  });

  it('verifies Klaviyo and ActiveCampaign HMAC vectors', () => {
    const body = Buffer.from('{"type":"profile.updated"}'); const secret = 'webhook-secret'; const timestamp = '1760000000';
    const klaviyo = crypto.createHmac('sha256', secret).update(body).update(timestamp).digest('hex');
    const activeCampaign = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyKlaviyo({ secret, body, timestamp, signature: `v1=${klaviyo}`, now: Number(timestamp) * 1_000 + 1_000 })).toBe(true);
    // ActiveCampaign carries no signature-timestamp header, so freshness is
    // evaluated against the timestamp inside the signed body. A payload with no
    // usable timestamp is rejected by default rather than accepted, because
    // signature validity alone never expires.
    expect(verifyActiveCampaign({ secret, body, signature: activeCampaign, requireTimestamp: false })).toBe(true);
    expect(verifyActiveCampaign({ secret, body: Buffer.from('{}'), signature: activeCampaign, requireTimestamp: false })).toBe(false);
  });
});
