import { describe, expect, it } from 'vitest';
import { nodeExecutors } from '../src/services/nodeLibrary';
import { validateWorkflowGraph } from '../src/services/workflowValidation';

const ctx: any = { organizationId: 'org', workflowId: 'workflow', executionId: 'execution', correlationId: 'correlation', payload: { contact: { country: 'LK', joinedAt: '2026-08-05T10:00:00Z' } }, state: {} };

describe('structured workflow nodes', () => {
  it('evaluates UI field conditions against the event payload', async () => {
    await expect(nodeExecutors['logic.condition']!({ data: { field: 'contact.country', operator: 'equals', value: 'LK' }, ctx: { ...ctx, state: {} } })).resolves.toEqual({ result: true });
  });

  it('implements UI field transformations without code execution', async () => {
    const local = { ...ctx, state: {} };
    await nodeExecutors['transform.field']!({ data: { source: 'contact.joinedAt', target: 'joinedIso', operation: 'date_iso' }, ctx: local });
    expect(local.state.joinedIso).toBe('2026-08-05T10:00:00.000Z');
  });

  it('rejects graph cycles with visual yes/no handles', () => {
    const result = validateWorkflowGraph({
      nodes: [
        { id: 'start', type: 'workflowNode', position: { x: 0, y: 0 }, data: { kind: 'trigger.webhook', label: 'Start', config: {} } },
        { id: 'condition', type: 'workflowNode', position: { x: 1, y: 0 }, data: { kind: 'logic.condition', label: 'Condition', config: { field: 'contact.country', operator: 'equals', value: 'LK' } } },
      ],
      edges: [
        { id: 'forward', source: 'start', target: 'condition' },
        { id: 'cycle', source: 'condition', target: 'start', sourceHandle: 'yes' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/cycles/i);
  });

  it('rejects client-supplied webhook URLs and secrets', () => {
    const result = validateWorkflowGraph({
      nodes: [
        { id: 'start', type: 'workflowNode', position: { x: 0, y: 0 }, data: { kind: 'trigger.webhook', label: 'Start', config: {} } },
        { id: 'send', type: 'workflowNode', position: { x: 1, y: 0 }, data: { kind: 'action.approved_webhook', label: 'Send', config: { destinationId: 'destination', method: 'POST', url: 'https://attacker.example', secret: 'x' } } },
      ],
      edges: [{ id: 'edge', source: 'start', target: 'send' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/inline URL or secrets/);
  });

  it('rejects legacy raw HTTP workflow executors', () => {
    const result = validateWorkflowGraph({
      nodes: [
        { id: 'start', type: 'workflowNode', position: { x: 0, y: 0 }, data: { kind: 'trigger.webhook', label: 'Start', config: {} } },
        { id: 'raw', type: 'workflowNode', position: { x: 1, y: 0 }, data: { kind: 'action.http.request', label: 'Raw request', config: { url: 'https://example.com' } } },
      ],
      edges: [{ id: 'edge', source: 'start', target: 'raw' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/disabled for security/);
    expect(nodeExecutors['action.http.request']).toBeUndefined();
  });
});
