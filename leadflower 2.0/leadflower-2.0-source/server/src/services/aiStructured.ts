import axios, { AxiosRequestConfig } from 'axios'
import { Types } from 'mongoose'
import AiConnectionConsent, { AiConnectionProvider } from '../models/AiConnectionConsent'
import PlatformConnection from '../models/PlatformConnection'
import { getConnectionCredential } from './connectionCredentials'
import { recordUsage } from './usage'
import {
  AI_HARD_LIMITS,
  StructuredJsonSchema,
  assertStructuredOutput,
  assertStructuredOutputSchema,
  isAllowedAiModel,
} from './aiPolicy'

export class AiExecutionError extends Error {
  constructor(public code: string, message: string, public retryable = false) {
    super(message)
    this.name = 'AiExecutionError'
  }
}

export interface AiAuthorization {
  provider: AiConnectionProvider
  apiKey: string
  allowedModels: string[]
  maxInputTokens: number
  maxOutputTokens: number
}

export interface ExecuteStructuredAiInput {
  organizationId: string
  connectionId: string
  model: string
  prompt: string
  systemPrompt?: string
  outputSchema: StructuredJsonSchema
  maxOutputTokens?: number
  timeoutMs?: number
  idempotencyKey: string
  source?: string
}

export interface AiTokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface ExecuteStructuredAiResult {
  provider: AiConnectionProvider
  model: string
  output: Record<string, unknown>
  usage: AiTokenUsage
}

type HttpRequest = (config: AxiosRequestConfig) => Promise<{ data: any; status?: number }>
type MeterUsage = typeof recordUsage

export interface AiStructuredDependencies {
  authorize: (input: { organizationId: string; connectionId: string; model: string }) => Promise<AiAuthorization>
  request: HttpRequest
  meter: MeterUsage
}

interface ProviderResult {
  rawOutput: unknown
  usage: AiTokenUsage
  complete: boolean
}

function finiteTokenCount(value: unknown): number {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

function safeTimeout(value: unknown): number {
  const timeout = Number(value ?? 20_000)
  if (!Number.isFinite(timeout)) throw new AiExecutionError('AI_INVALID_CONFIGURATION', 'AI timeout must be finite')
  return Math.min(AI_HARD_LIMITS.maxTimeoutMs, Math.max(AI_HARD_LIMITS.minTimeoutMs, Math.trunc(timeout)))
}

function requestBudget(input: ExecuteStructuredAiInput, authorization: AiAuthorization) {
  const requestedOutput = Number(input.maxOutputTokens ?? authorization.maxOutputTokens)
  if (!Number.isSafeInteger(requestedOutput) || requestedOutput < 1) {
    throw new AiExecutionError('AI_INVALID_CONFIGURATION', 'AI maxOutputTokens must be a positive integer')
  }
  const maxOutputTokens = Math.min(requestedOutput, authorization.maxOutputTokens, AI_HARD_LIMITS.maxOutputTokens)
  const inputBytes = Buffer.byteLength(input.prompt, 'utf8') + Buffer.byteLength(input.systemPrompt || '', 'utf8') +
    Buffer.byteLength(JSON.stringify(input.outputSchema), 'utf8')
  if (inputBytes > AI_HARD_LIMITS.maxInputBytes) throw new AiExecutionError('AI_INPUT_BUDGET_EXCEEDED', 'AI input exceeds the hard byte budget')
  // A UTF-8 byte is a conservative upper bound for tokenizer units; the fixed
  // allowance covers provider message/tool framing without logging the prompt.
  const estimatedInputTokens = inputBytes + 1_024
  if (estimatedInputTokens > authorization.maxInputTokens) {
    throw new AiExecutionError('AI_INPUT_BUDGET_EXCEEDED', 'AI input exceeds the connection consent token budget')
  }
  return { maxOutputTokens, estimatedInputTokens, timeoutMs: safeTimeout(input.timeoutMs) }
}

export async function resolveAiAuthorization(input: {
  organizationId: string
  connectionId: string
  model: string
}): Promise<AiAuthorization> {
  if (!Types.ObjectId.isValid(input.organizationId) || !Types.ObjectId.isValid(input.connectionId)) {
    throw new AiExecutionError('AI_CONNECTION_UNAVAILABLE', 'AI connection is unavailable')
  }
  const connection: any = await PlatformConnection.findOne({
    _id: input.connectionId,
    organizationId: input.organizationId,
    provider: { $in: ['openai', 'anthropic', 'googleai'] },
    status: { $in: ['active', 'degraded', 'error'] },
  }).select('provider').lean()
  if (!connection) throw new AiExecutionError('AI_CONNECTION_UNAVAILABLE', 'AI connection is unavailable')
  const provider = connection.provider as AiConnectionProvider
  const consent: any = await AiConnectionConsent.findOne({
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    provider,
    enabled: true,
  }).lean()
  if (!consent) throw new AiExecutionError('AI_CONSENT_REQUIRED', 'AI processing is not enabled for this connection')
  if (!isAllowedAiModel(provider, input.model) || !consent.allowedModels.includes(input.model)) {
    throw new AiExecutionError('AI_MODEL_NOT_ALLOWED', 'AI model is not allowed by platform policy and tenant consent')
  }
  const credential = await getConnectionCredential({
    organizationId: input.organizationId,
    provider,
    connectionId: input.connectionId,
  })
  const apiKey = typeof credential.apiKey === 'string' ? credential.apiKey.trim() : ''
  if (apiKey.length < 8) throw new AiExecutionError('AI_CREDENTIAL_UNAVAILABLE', 'AI API-key credential is unavailable')
  return {
    provider,
    apiKey,
    allowedModels: [...consent.allowedModels],
    maxInputTokens: Math.min(Number(consent.maxInputTokens), AI_HARD_LIMITS.maxInputTokens),
    maxOutputTokens: Math.min(Number(consent.maxOutputTokens), AI_HARD_LIMITS.maxOutputTokens),
  }
}

function providerRequest(input: ExecuteStructuredAiInput, authorization: AiAuthorization, maxOutputTokens: number): AxiosRequestConfig {
  const common = { timeout: safeTimeout(input.timeoutMs), maxRedirects: 0, maxContentLength: 1_048_576, maxBodyLength: 262_144 }
  if (authorization.provider === 'openai') {
    return {
      ...common,
      method: 'POST',
      url: 'https://api.openai.com/v1/responses',
      headers: { Authorization: `Bearer ${authorization.apiKey}`, 'Content-Type': 'application/json' },
      data: {
        model: input.model,
        store: false,
        max_output_tokens: maxOutputTokens,
        input: [
          ...(input.systemPrompt ? [{ role: 'system', content: [{ type: 'input_text', text: input.systemPrompt }] }] : []),
          { role: 'user', content: [{ type: 'input_text', text: input.prompt }] },
        ],
        text: { format: { type: 'json_schema', name: 'workflow_output', strict: true, schema: input.outputSchema } },
      },
      validateStatus: (status) => status >= 200 && status < 300,
    }
  }
  if (authorization.provider === 'anthropic') {
    return {
      ...common,
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': authorization.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      data: {
        model: input.model,
        max_tokens: maxOutputTokens,
        ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
        messages: [{ role: 'user', content: input.prompt }],
        tools: [{ name: 'workflow_structured_output', description: 'Return the requested structured workflow result.', input_schema: input.outputSchema }],
        tool_choice: { type: 'tool', name: 'workflow_structured_output' },
      },
      validateStatus: (status) => status >= 200 && status < 300,
    }
  }
  return {
    ...common,
    method: 'POST',
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
    headers: { 'x-goog-api-key': authorization.apiKey, 'Content-Type': 'application/json' },
    data: {
      contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
      ...(input.systemPrompt ? { systemInstruction: { parts: [{ text: input.systemPrompt }] } } : {}),
      generationConfig: {
        maxOutputTokens,
        responseMimeType: 'application/json',
        responseJsonSchema: input.outputSchema,
      },
    },
    validateStatus: (status) => status >= 200 && status < 300,
  }
}

function extractProviderResult(provider: AiConnectionProvider, data: any): ProviderResult {
  if (provider === 'openai') {
    const content = Array.isArray(data?.output) ? data.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : []) : []
    const rawOutput = typeof data?.output_text === 'string' ? data.output_text : content.find((item: any) => item?.type === 'output_text')?.text
    return {
      rawOutput,
      usage: { inputTokens: finiteTokenCount(data?.usage?.input_tokens), outputTokens: finiteTokenCount(data?.usage?.output_tokens) },
      complete: data?.status !== 'incomplete' && !data?.incomplete_details,
    }
  }
  if (provider === 'anthropic') {
    const tool = Array.isArray(data?.content) ? data.content.find((item: any) => item?.type === 'tool_use' && item?.name === 'workflow_structured_output') : undefined
    return {
      rawOutput: tool?.input,
      usage: { inputTokens: finiteTokenCount(data?.usage?.input_tokens), outputTokens: finiteTokenCount(data?.usage?.output_tokens) },
      complete: data?.stop_reason === 'tool_use' || data?.stop_reason === 'end_turn',
    }
  }
  const candidate = data?.candidates?.[0]
  const text = Array.isArray(candidate?.content?.parts) ? candidate.content.parts.find((part: any) => typeof part?.text === 'string')?.text : undefined
  return {
    rawOutput: text,
    usage: {
      inputTokens: finiteTokenCount(data?.usageMetadata?.promptTokenCount),
      outputTokens: finiteTokenCount(data?.usageMetadata?.candidatesTokenCount),
    },
    complete: ['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(String(candidate?.finishReason || '')),
  }
}

function parseProviderOutput(rawOutput: unknown): unknown {
  if (typeof rawOutput !== 'string') return rawOutput
  if (Buffer.byteLength(rawOutput, 'utf8') > AI_HARD_LIMITS.maxOutputBytes) {
    throw new AiExecutionError('AI_OUTPUT_INVALID', 'AI provider output exceeds the hard byte budget')
  }
  try { return JSON.parse(rawOutput) } catch { throw new AiExecutionError('AI_OUTPUT_INVALID', 'AI provider did not return valid JSON') }
}

function safeProviderError(error: any): AiExecutionError {
  if (error instanceof AiExecutionError) return error
  const status = Number(error?.response?.status)
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') return new AiExecutionError('AI_PROVIDER_TIMEOUT', 'AI provider request timed out', true)
  if (status === 429) return new AiExecutionError('AI_PROVIDER_RATE_LIMITED', 'AI provider rate limit was reached', true)
  if (status === 401 || status === 403) return new AiExecutionError('AI_PROVIDER_AUTHENTICATION_FAILED', 'AI provider rejected the configured API key')
  if (status >= 400 && status < 500) return new AiExecutionError('AI_PROVIDER_REJECTED', 'AI provider rejected the structured request')
  return new AiExecutionError('AI_PROVIDER_UNAVAILABLE', 'AI provider is temporarily unavailable', true)
}

async function meterProviderUsage(input: ExecuteStructuredAiInput, provider: AiConnectionProvider, usage: AiTokenUsage, meter: MeterUsage): Promise<void> {
  const metadata = { provider, model: input.model, connectionId: input.connectionId }
  await Promise.all([
    meter({ organizationId: input.organizationId, metric: 'ai_request', quantity: 1, idempotencyKey: `${input.idempotencyKey}:request`, source: input.source || 'action.ai.structured', metadata }),
    meter({ organizationId: input.organizationId, metric: 'ai_input_token', quantity: usage.inputTokens, idempotencyKey: `${input.idempotencyKey}:input`, source: input.source || 'action.ai.structured', metadata }),
    meter({ organizationId: input.organizationId, metric: 'ai_output_token', quantity: usage.outputTokens, idempotencyKey: `${input.idempotencyKey}:output`, source: input.source || 'action.ai.structured', metadata }),
  ])
}

const defaults: AiStructuredDependencies = {
  authorize: resolveAiAuthorization,
  request: (config) => axios.request(config),
  meter: recordUsage,
}

export async function executeStructuredAi(
  input: ExecuteStructuredAiInput,
  dependencies: Partial<AiStructuredDependencies> = {},
): Promise<ExecuteStructuredAiResult> {
  assertStructuredOutputSchema(input.outputSchema)
  if (!input.prompt || typeof input.prompt !== 'string') throw new AiExecutionError('AI_INVALID_CONFIGURATION', 'AI prompt is required')
  if (!/^[a-f0-9:-]{16,240}$/i.test(input.idempotencyKey)) throw new AiExecutionError('AI_INVALID_CONFIGURATION', 'A safe AI metering idempotency key is required')
  const deps = { ...defaults, ...dependencies }
  try {
    const authorization = await deps.authorize({ organizationId: input.organizationId, connectionId: input.connectionId, model: input.model })
    if (!isAllowedAiModel(authorization.provider, input.model) || !authorization.allowedModels.includes(input.model)) {
      throw new AiExecutionError('AI_MODEL_NOT_ALLOWED', 'AI model is not allowed by platform policy and tenant consent')
    }
    const budget = requestBudget(input, authorization)
    const response = await deps.request(providerRequest(input, authorization, budget.maxOutputTokens))
    const providerResult = extractProviderResult(authorization.provider, response.data)
    await meterProviderUsage(input, authorization.provider, providerResult.usage, deps.meter)
    if (!providerResult.complete) throw new AiExecutionError('AI_OUTPUT_INCOMPLETE', 'AI provider output was incomplete')
    const output = parseProviderOutput(providerResult.rawOutput)
    try { assertStructuredOutput(output, input.outputSchema) }
    catch { throw new AiExecutionError('AI_OUTPUT_INVALID', 'AI provider output failed local schema validation') }
    return { provider: authorization.provider, model: input.model, output, usage: providerResult.usage }
  } catch (error) {
    throw safeProviderError(error)
  }
}
