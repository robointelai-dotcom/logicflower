import { describe, expect, it, vi } from 'vitest'

const executeStructuredAi = vi.hoisted(() => vi.fn(async () => ({
  provider: 'openai',
  model: 'gpt-4.1-mini',
  output: { privateClassification: 'do-not-persist-in-step-output' },
  usage: { inputTokens: 20, outputTokens: 8 },
})))

vi.mock('../src/services/aiStructured', () => ({ executeStructuredAi }))

describe('structured AI workflow node', () => {
  it('stores output only in encrypted workflow state and returns non-sensitive metadata', async () => {
    const { nodeExecutors } = await import('../src/services/nodeLibrary')
    const ctx: any = {
      organizationId: '507f1f77bcf86cd799439011',
      correlationId: 'correlation',
      workflowId: 'workflow',
      executionId: 'execution',
      nodeId: 'ai-node',
      idempotencyKey: 'b'.repeat(64),
      payload: { message: 'customer payload' },
      state: {},
    }
    const result = await nodeExecutors['action.ai.structured']!({
      data: {
        connectionId: '507f1f77bcf86cd799439012',
        model: 'gpt-4.1-mini',
        systemPrompt: 'Classify safely.',
        promptTemplate: 'Classify {{payload.message}}',
        outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        saveAs: 'ai.result',
      },
      ctx,
    })
    expect(ctx.state.ai.result).toEqual({ privateClassification: 'do-not-persist-in-step-output' })
    expect(result).toMatchObject({ ok: true, provider: 'openai', model: 'gpt-4.1-mini', savedAs: 'ai.result' })
    expect(JSON.stringify(result)).not.toContain('do-not-persist-in-step-output')
    expect(executeStructuredAi).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: 'Classify safely.',
      idempotencyKey: 'b'.repeat(64),
    }))
  })
})
