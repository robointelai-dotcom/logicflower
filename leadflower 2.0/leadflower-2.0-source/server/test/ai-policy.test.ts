import { describe, expect, it } from 'vitest'
import { assertStructuredOutput, assertStructuredOutputSchema, safeAiStatePath } from '../src/services/aiPolicy'
import { validateWorkflowGraph } from '../src/services/workflowValidation'

const schema = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['approve', 'review', 'reject'] },
    reasons: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 5 },
  },
  required: ['decision', 'reasons'],
  additionalProperties: false,
}

describe('structured AI schema and workflow policy', () => {
  it('accepts the constrained schema subset and rejects local output mismatches', () => {
    expect(() => assertStructuredOutputSchema(schema)).not.toThrow()
    expect(() => assertStructuredOutput({ decision: 'review', reasons: ['missing phone'] }, schema)).not.toThrow()
    expect(() => assertStructuredOutput({ decision: 'invented', reasons: [], leaked: true }, schema)).toThrow(/schema validation/)
  })

  it('rejects open schemas, executable/ambiguous keywords, unsafe paths, and oversized schema depth', () => {
    expect(() => assertStructuredOutputSchema({ ...schema, additionalProperties: true })).toThrow(/additionalProperties/)
    expect(() => assertStructuredOutputSchema({ ...schema, oneOf: [] })).toThrow(/keyword oneOf/)
    expect(safeAiStatePath('ai.result')).toBe('ai.result')
    expect(safeAiStatePath('__proto__.result')).toBeUndefined()
  })

  it('accepts a safe action.ai.structured node and rejects inline credentials/endpoints', () => {
    const base = {
      nodes: [
        { id: 'trigger', type: 'workflowNode', data: { kind: 'trigger.webhook', config: {} }, position: { x: 0, y: 0 } },
        { id: 'ai', type: 'workflowNode', data: { kind: 'action.ai.structured', config: {
          connectionId: '507f1f77bcf86cd799439012',
          model: 'gpt-4.1-mini',
          systemPrompt: 'Return a classification object.',
          promptTemplate: 'Classify {{payload.message}}',
          outputSchema: schema,
          saveAs: 'ai.result',
          maxOutputTokens: 500,
          timeoutMs: 10_000,
        } }, position: { x: 0, y: 100 } },
      ],
      edges: [{ id: 'edge', source: 'trigger', target: 'ai' }],
    }
    expect(validateWorkflowGraph(base).valid).toBe(true)
    const unsafe = structuredClone(base)
    ;(unsafe.nodes[1]!.data as any).config = { ...unsafe.nodes[1]!.data.config, apiKey: 'must-never-be-inline', endpoint: 'https://attacker.example' }
    const result = validateWorkflowGraph(unsafe)
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toMatch(/cannot contain credentials/)
  })
})
