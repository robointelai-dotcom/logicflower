import { afterEach, describe, expect, it, vi } from 'vitest'
import Workflow from '../src/models/Workflow'
import { dryRunWorkflow } from '../src/services/workflowDryRun'

afterEach(() => vi.restoreAllMocks())

describe('workflow impact preview', () => {
  it('follows the selected structured branch and produces a stable plan hash without side effects', async () => {
    const workflow = {
      _id: '66b2641cd99ce98ee7d9ea01',
      organizationId: '66b2641cd99ce98ee7d9ea02',
      nodes: [
        { id: 'start', type: 'workflowNode', position: { x: 0, y: 0 }, data: { kind: 'trigger.webhook', label: 'Start', config: {} } },
        { id: 'condition', type: 'workflowNode', position: { x: 1, y: 0 }, data: { kind: 'logic.condition', label: 'Country', config: { field: 'contact.country', operator: 'equals', value: 'LK' } } },
        { id: 'yes-log', type: 'workflowNode', position: { x: 2, y: 0 }, data: { kind: 'action.log', label: 'Matched', config: { message: 'matched' } } },
        { id: 'no-log', type: 'workflowNode', position: { x: 2, y: 1 }, data: { kind: 'action.log', label: 'Not matched', config: { message: 'not matched' } } },
      ],
      edges: [
        { id: 'start-condition', source: 'start', target: 'condition' },
        { id: 'yes', source: 'condition', target: 'yes-log', sourceHandle: 'yes' },
        { id: 'no', source: 'condition', target: 'no-log', sourceHandle: 'no' },
      ],
    }
    vi.spyOn(Workflow, 'findOne').mockReturnValue({ lean: vi.fn(async () => workflow) } as any)
    const input = { organizationId: String(workflow.organizationId), workflowId: String(workflow._id), payload: { contact: { country: 'LK' } } }
    const first = await dryRunWorkflow(input)
    const second = await dryRunWorkflow(input)
    expect(first.noSideEffects).toBe(true)
    expect(first.plan.map((step) => step.nodeId)).toEqual(['start', 'condition', 'yes-log'])
    expect(first.planHash).toBe(second.planHash)
    expect(first.impact.destructiveActions).toBe(0)
  })
})
