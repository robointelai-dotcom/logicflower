import { beforeEach, describe, expect, it, vi } from 'vitest'

const database = vi.hoisted(() => ({
  connection: { provider: 'openai' },
  consent: {
    enabled: true,
    allowedModels: ['gpt-4.1-mini'],
    maxInputTokens: 8_192,
    maxOutputTokens: 1_024,
  },
  credential: { accessToken: 'oauth-token-that-must-not-be-used' } as Record<string, unknown>,
}))

const PlatformConnectionMock = vi.hoisted(() => ({
  findOne: vi.fn(() => ({ select: () => ({ lean: async () => database.connection }) })),
}))
const ConsentMock = vi.hoisted(() => ({
  findOne: vi.fn(() => ({ lean: async () => database.consent })),
}))
const credentialMock = vi.hoisted(() => vi.fn(async () => database.credential))

vi.mock('../src/models/PlatformConnection', () => ({ default: PlatformConnectionMock }))
vi.mock('../src/models/AiConnectionConsent', async () => {
  const actual: any = await vi.importActual('../src/models/AiConnectionConsent')
  return { ...actual, default: ConsentMock }
})
vi.mock('../src/services/connectionCredentials', () => ({ getConnectionCredential: credentialMock }))

const schema = {
  type: 'object',
  properties: {
    summary: { type: 'string', maxLength: 120 },
    score: { type: 'integer', minimum: 0, maximum: 100 },
  },
  required: ['summary', 'score'],
  additionalProperties: false,
}

const baseInput = {
  organizationId: '507f1f77bcf86cd799439011',
  connectionId: '507f1f77bcf86cd799439012',
  model: 'gpt-4.1-mini',
  prompt: 'Classify this record.',
  systemPrompt: 'Return a classification object.',
  outputSchema: schema,
  maxOutputTokens: 300,
  timeoutMs: 5_000,
  idempotencyKey: 'a'.repeat(64),
}

function authorization(provider: 'openai' | 'anthropic' | 'googleai', model: string) {
  return {
    provider,
    apiKey: `secret-${provider}-api-key`,
    allowedModels: [model],
    maxInputTokens: 8_192,
    maxOutputTokens: 1_024,
  }
}

describe('structured AI BYOK executor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    database.connection = { provider: 'openai' }
    database.consent = { enabled: true, allowedModels: ['gpt-4.1-mini'], maxInputTokens: 8_192, maxOutputTokens: 1_024 }
    database.credential = { accessToken: 'oauth-token-that-must-not-be-used' }
  })

  it('uses the fixed OpenAI structured-output contract and meters without prompt/output metadata', async () => {
    const { executeStructuredAi } = await import('../src/services/aiStructured')
    const request = vi.fn(async (_config: any) => ({ data: {
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ summary: 'qualified', score: 92 }) }] }],
      usage: { input_tokens: 41, output_tokens: 12 },
    } }))
    const meter = vi.fn(async (_usage: any) => undefined)
    const result = await executeStructuredAi(baseInput, {
      authorize: vi.fn(async () => authorization('openai', baseInput.model)), request, meter,
    })
    const config: any = request.mock.calls[0]![0]
    expect(config.url).toBe('https://api.openai.com/v1/responses')
    expect(config.headers.Authorization).toBe('Bearer secret-openai-api-key')
    expect(config.data.store).toBe(false)
    expect(config.data.text.format).toMatchObject({ type: 'json_schema', strict: true, schema })
    expect(result).toEqual({ provider: 'openai', model: 'gpt-4.1-mini', output: { summary: 'qualified', score: 92 }, usage: { inputTokens: 41, outputTokens: 12 } })
    expect(meter).toHaveBeenCalledTimes(3)
    for (const [usage] of meter.mock.calls) {
      expect(usage.metadata).toEqual({ provider: 'openai', model: 'gpt-4.1-mini', connectionId: baseInput.connectionId })
      expect(JSON.stringify(usage)).not.toContain(baseInput.prompt)
      expect(JSON.stringify(usage)).not.toContain('qualified')
    }
  })

  it('forces Anthropic tool output and validates the returned tool object locally', async () => {
    const { executeStructuredAi } = await import('../src/services/aiStructured')
    const model = 'claude-haiku-4-5-20251001'
    const request = vi.fn(async (_config: any) => ({ data: {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'workflow_structured_output', input: { summary: 'review', score: 55 } }],
      usage: { input_tokens: 60, output_tokens: 18 },
    } }))
    const result = await executeStructuredAi({ ...baseInput, model }, {
      authorize: vi.fn(async () => authorization('anthropic', model)), request, meter: vi.fn(async (_usage: any) => undefined),
    })
    const config: any = request.mock.calls[0]![0]
    expect(config.url).toBe('https://api.anthropic.com/v1/messages')
    expect(config.headers['x-api-key']).toBe('secret-anthropic-api-key')
    expect(config.data.tool_choice).toEqual({ type: 'tool', name: 'workflow_structured_output' })
    expect(config.data.tools[0].input_schema).toEqual(schema)
    expect(result.output).toEqual({ summary: 'review', score: 55 })
  })

  it('uses a fixed Google AI host, an API-key header, and JSON-schema response mode', async () => {
    const { executeStructuredAi } = await import('../src/services/aiStructured')
    const model = 'gemini-2.5-flash'
    const request = vi.fn(async (_config: any) => ({ data: {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ summary: 'ok', score: 75 }) }] } }],
      usageMetadata: { promptTokenCount: 33, candidatesTokenCount: 9 },
    } }))
    await executeStructuredAi({ ...baseInput, model }, {
      authorize: vi.fn(async () => authorization('googleai', model)), request, meter: vi.fn(async (_usage: any) => undefined),
    })
    const config: any = request.mock.calls[0]![0]
    expect(config.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
    expect(config.headers['x-goog-api-key']).toBe('secret-googleai-api-key')
    expect(config.url).not.toContain('secret-googleai-api-key')
    expect(config.data.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: schema })
  })

  it('rejects access-token-only credentials because BYOK requires encrypted apiKey material', async () => {
    const { resolveAiAuthorization } = await import('../src/services/aiStructured')
    await expect(resolveAiAuthorization({
      organizationId: baseInput.organizationId,
      connectionId: baseInput.connectionId,
      model: baseInput.model,
    })).rejects.toMatchObject({ code: 'AI_CREDENTIAL_UNAVAILABLE' })
    database.credential = { apiKey: 'valid-encrypted-api-key-after-decryption', accessToken: 'ignored' }
    await expect(resolveAiAuthorization({
      organizationId: baseInput.organizationId,
      connectionId: baseInput.connectionId,
      model: baseInput.model,
    })).resolves.toMatchObject({ provider: 'openai', apiKey: 'valid-encrypted-api-key-after-decryption' })
  })

  it('enforces model/input budgets before making a provider request', async () => {
    const { executeStructuredAi } = await import('../src/services/aiStructured')
    const request = vi.fn()
    await expect(executeStructuredAi({ ...baseInput, prompt: 'x'.repeat(33_000) }, {
      authorize: vi.fn(async () => authorization('openai', baseInput.model)), request, meter: vi.fn(),
    })).rejects.toMatchObject({ code: 'AI_INPUT_BUDGET_EXCEEDED' })
    await expect(executeStructuredAi({ ...baseInput, model: 'not-a-real-model' }, {
      authorize: vi.fn(async () => authorization('openai', 'not-a-real-model')), request, meter: vi.fn(),
    })).rejects.toMatchObject({ code: 'AI_MODEL_NOT_ALLOWED' })
    expect(request).not.toHaveBeenCalled()
  })

  it('returns only redacted provider/schema failures, never provider bodies, prompts, or keys', async () => {
    const { executeStructuredAi } = await import('../src/services/aiStructured')
    const rejectedRequest = vi.fn(async (_config: any) => {
      throw { response: { status: 400, data: { error: `provider echoed ${baseInput.prompt} secret-openai-api-key` } } }
    })
    const error = await executeStructuredAi(baseInput, {
      authorize: vi.fn(async () => authorization('openai', baseInput.model)),
      request: rejectedRequest, meter: vi.fn(),
    }).catch((caught) => caught)
    expect(error).toMatchObject({ code: 'AI_PROVIDER_REJECTED' })
    expect(String(error.message)).not.toContain(baseInput.prompt)
    expect(String(error.message)).not.toContain('secret-openai-api-key')

    const invalidOutput = vi.fn(async (_config: any) => ({ data: {
      status: 'completed',
      output_text: JSON.stringify({ summary: 'private-output-value', score: 'wrong-type' }),
      usage: { input_tokens: 4, output_tokens: 4 },
    } }))
    const schemaError = await executeStructuredAi(baseInput, {
      authorize: vi.fn(async () => authorization('openai', baseInput.model)), request: invalidOutput, meter: vi.fn(async (_usage: any) => undefined),
    }).catch((caught) => caught)
    expect(schemaError).toMatchObject({ code: 'AI_OUTPUT_INVALID' })
    expect(String(schemaError.message)).not.toContain('private-output-value')
  })
})
