import { describe, expect, it } from 'vitest';
import { requireOrganizationId } from '../src/types/authenticatedRequest';
describe('tenant scoping', () => {
  it('requires canonical req.auth.organizationId', () => {
    expect(() => requireOrganizationId({ auth: { userId: 'u', sessionId: 's' } } as any)).toThrow(/organization/i);
    expect(requireOrganizationId({ auth: { userId: 'u', sessionId: 's', organizationId: 'org' } } as any)).toBe('org');
  });
});
