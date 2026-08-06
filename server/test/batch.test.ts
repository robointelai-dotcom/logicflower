import { describe, expect, it } from 'vitest';
import { canonicalBatchOperation, normalizeBatchRecord, normalizeEmail, normalizePhone } from '../src/services/batchNormalization';
import { batchDedupeKeys } from '../src/services/batchService';

describe('batch preflight', () => {
  it('normalizes email and E.164-like phone values', () => {
    expect(normalizeEmail(' Test@Example.COM ')).toBe('test@example.com');
    expect(normalizeEmail('invalid')).toBe('');
    expect(normalizePhone('077 123 4567', '94')).toBe('+94771234567');
    expect(normalizeBatchRecord({ email: ' A@B.COM ', phone: '0771234567' }, { defaultCountryCode: '94' })).toMatchObject({ email: 'a@b.com', phone: '+94771234567' });
  });
  it('maps UI operations to canonical connector operations', () => {
    expect(canonicalBatchOperation('update_contacts')).toBe('contact.upsert');
    expect(canonicalBatchOperation('add_tags')).toBe('contact.addTag');
    expect(() => canonicalBatchOperation('arbitrary.request')).toThrow(/Unsupported/);
  });
  it('treats email and phone identifiers as OR deduplication rules', () => {
    const first = batchDedupeKeys({ email: 'same@example.com', phone: '+94770000001' }, ['email', 'phone']);
    const sameEmail = batchDedupeKeys({ email: 'same@example.com', phone: '+94770000002' }, ['email', 'phone']);
    const samePhone = batchDedupeKeys({ email: 'other@example.com', phone: '+94770000001' }, ['email', 'phone']);
    const unrelated = batchDedupeKeys({ email: 'new@example.com', phone: '+94770000003' }, ['email', 'phone']);
    expect(sameEmail.some((key) => first.includes(key))).toBe(true);
    expect(samePhone.some((key) => first.includes(key))).toBe(true);
    expect(unrelated.some((key) => first.includes(key))).toBe(false);
  });
});
