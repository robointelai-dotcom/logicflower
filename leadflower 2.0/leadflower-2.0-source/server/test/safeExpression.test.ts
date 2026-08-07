import { describe, expect, it } from 'vitest';
import { evaluateExpression, parseSafeExpression } from '../src/services/safeExpression';
import { canonicalizeWorkflowDefinition, validateWorkflowGraph } from '../src/services/workflowValidation';

describe('safe workflow expressions', () => {
  it('evaluates branching without JavaScript execution', () => {
    const expression = { and: [{ '>': [{ var: 'payload.total' }, 100] }, { '==': [{ var: 'payload.country' }, 'LK'] }] };
    expect(evaluateExpression(expression, { payload: { total: 150, country: 'LK' } })).toBe(true);
    expect(evaluateExpression(expression, { payload: { total: 50, country: 'LK' } })).toBe(false);
  });
  it('rejects source code strings', () => expect(() => parseSafeExpression('return process.env')).toThrow(/valid JSON/));
  it('rejects cycles and arbitrary code nodes', () => {
    const definition = { nodes: [
      { id: 'a', type: 'workflowNode', data: { kind: 'trigger.webhook', label: 'start', config: {} }, position: { x: 0, y: 0 } },
      { id: 'b', type: 'workflowNode', data: { kind: 'action.code.js', label: 'bad', config: {} }, position: { x: 0, y: 0 } },
    ], edges: [{ id: 'ab', source: 'a', target: 'b', data: {} }, { id: 'ba', source: 'b', target: 'a', data: {} }] };
    const result = validateWorkflowGraph(definition); expect(result.valid).toBe(false); expect(result.errors.join(' ')).toMatch(/disabled for security/); expect(result.errors.join(' ')).toMatch(/cycles/i);
  });
  it('migrates legacy nodes only when explicitly requested', () => {
    const legacy = { nodes: [{ id: 'a', type: 'trigger.webhook', data: {} }], edges: [] };
    expect(canonicalizeWorkflowDefinition(legacy).nodes[0].data.kind).toBeUndefined();
    expect(canonicalizeWorkflowDefinition(legacy, { allowLegacy: true }).nodes[0].data.kind).toBe('trigger.webhook');
  });
});
