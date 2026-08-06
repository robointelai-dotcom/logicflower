import { afterEach, describe, expect, it, vi } from 'vitest'
import PlatformConnection from '../src/models/PlatformConnection'
import { assertWorkflowResources } from '../src/services/workflowResources'

afterEach(() => vi.restoreAllMocks())

describe('workflow tenant resource boundary', () => {
  it('queries references inside the active organization and rejects a missing cross-tenant connection', async () => {
    const find = vi.spyOn(PlatformConnection, 'find').mockReturnValue({ select: vi.fn(() => ({ lean: vi.fn(async () => []) })) } as any)
    const workflow = { nodes: [{ id: 'write', data: { kind: 'action.contact.update', config: { provider: 'hubspot', connectionId: '66b2641cd99ce98ee7d9ea01' } } }] }
    await expect(assertWorkflowResources({ organizationId: '66b2641cd99ce98ee7d9ea02', workflow, requireOperational: true })).rejects.toMatchObject({ status: 422 })
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '66b2641cd99ce98ee7d9ea02' }))
  })
})
