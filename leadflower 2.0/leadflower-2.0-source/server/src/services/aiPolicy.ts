import { AiConnectionProvider } from '../models/AiConnectionConsent'

export const AI_PROVIDER_MODELS: Readonly<Record<AiConnectionProvider, readonly string[]>> = Object.freeze({
  openai: Object.freeze(['gpt-4.1-mini', 'gpt-4.1', 'gpt-5-mini']),
  anthropic: Object.freeze(['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929']),
  googleai: Object.freeze(['gemini-2.5-flash', 'gemini-2.5-pro']),
})

export const AI_HARD_LIMITS = Object.freeze({
  maxSchemaBytes: 16_384,
  maxInputBytes: 32_768,
  maxInputTokens: 32_768,
  maxOutputBytes: 262_144,
  maxOutputTokens: 4_096,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 45_000,
})

export type StructuredJsonSchema = Record<string, unknown>

const SAFE_PROPERTY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/
const UNSAFE_PROPERTY = new Set(['__proto__', 'prototype', 'constructor'])
const COMMON_KEYWORDS = new Set(['type', 'title', 'description', 'enum', 'const'])
const TYPE_KEYWORDS: Record<string, Set<string>> = {
  object: new Set([...COMMON_KEYWORDS, 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties']),
  array: new Set([...COMMON_KEYWORDS, 'items', 'minItems', 'maxItems']),
  string: new Set([...COMMON_KEYWORDS, 'minLength', 'maxLength']),
  number: new Set([...COMMON_KEYWORDS, 'minimum', 'maximum']),
  integer: new Set([...COMMON_KEYWORDS, 'minimum', 'maximum']),
  boolean: COMMON_KEYWORDS,
  null: COMMON_KEYWORDS,
}

function failSchema(path: string, detail: string): never {
  throw new Error(`Invalid structured output schema at ${path}: ${detail}`)
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function inspectSchema(schema: unknown, path: string, depth: number, state: { properties: number }): void {
  if (!plainObject(schema)) failSchema(path, 'schema must be an object')
  if (depth > 8) failSchema(path, 'schema nesting exceeds 8 levels')
  const type = schema.type
  if (typeof type !== 'string' || !TYPE_KEYWORDS[type]) failSchema(path, 'type must be one supported JSON type')
  for (const key of Object.keys(schema)) if (!TYPE_KEYWORDS[type]!.has(key)) failSchema(path, `keyword ${key} is not supported`)
  if (schema.title !== undefined && (typeof schema.title !== 'string' || schema.title.length > 160)) failSchema(path, 'title is too long')
  if (schema.description !== undefined && (typeof schema.description !== 'string' || schema.description.length > 500)) failSchema(path, 'description is too long')
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > 100)) failSchema(path, 'enum must contain 1 to 100 values')

  if (type === 'object') {
    if (!plainObject(schema.properties)) failSchema(path, 'object properties are required')
    if (schema.additionalProperties !== false) failSchema(path, 'additionalProperties must be false')
    const properties = schema.properties as Record<string, unknown>
    const names = Object.keys(properties)
    state.properties += names.length
    if (state.properties > 100) failSchema(path, 'schema exceeds 100 total properties')
    for (const name of names) {
      if (!SAFE_PROPERTY.test(name) || UNSAFE_PROPERTY.has(name)) failSchema(path, `unsafe property name ${name}`)
      inspectSchema(properties[name], `${path}.properties.${name}`, depth + 1, state)
    }
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string')) failSchema(path, 'required must be an array of property names')
    const required = new Set(schema.required as string[])
    if (required.size !== (schema.required as string[]).length || [...required].some((name) => !hasOwn(properties, name))) failSchema(path, 'required contains an unknown or duplicate property')
    for (const key of ['minProperties', 'maxProperties'] as const) {
      if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || Number(schema[key]) < 0 || Number(schema[key]) > 100)) failSchema(path, `${key} must be an integer from 0 to 100`)
    }
  } else if (type === 'array') {
    inspectSchema(schema.items, `${path}.items`, depth + 1, state)
    for (const key of ['minItems', 'maxItems'] as const) {
      if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || Number(schema[key]) < 0 || Number(schema[key]) > 100)) failSchema(path, `${key} must be an integer from 0 to 100`)
    }
  } else if (type === 'string') {
    for (const key of ['minLength', 'maxLength'] as const) {
      if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || Number(schema[key]) < 0 || Number(schema[key]) > 16_384)) failSchema(path, `${key} must be an integer from 0 to 16384`)
    }
  } else if (type === 'number' || type === 'integer') {
    for (const key of ['minimum', 'maximum'] as const) {
      if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) failSchema(path, `${key} must be finite`)
    }
  }
}

export function assertStructuredOutputSchema(schema: unknown): asserts schema is StructuredJsonSchema {
  let bytes: number
  try { bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8') } catch { failSchema('$', 'schema must be JSON serializable') }
  if (bytes! > AI_HARD_LIMITS.maxSchemaBytes) failSchema('$', `schema exceeds ${AI_HARD_LIMITS.maxSchemaBytes} bytes`)
  inspectSchema(schema, '$', 0, { properties: 0 })
  if ((schema as Record<string, unknown>).type !== 'object') failSchema('$', 'root type must be object')
}

function outputFailure(path: string, detail: string): never {
  throw new Error(`AI output failed schema validation at ${path}: ${detail}`)
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateValue(value: unknown, schema: Record<string, any>, path: string, depth: number): void {
  if (depth > 8) outputFailure(path, 'value nesting exceeds 8 levels')
  if (schema.enum && !(schema.enum as unknown[]).some((candidate) => sameJsonValue(candidate, value))) outputFailure(path, 'value is outside the enum')
  if (hasOwn(schema, 'const') && !sameJsonValue(schema.const, value)) outputFailure(path, 'value does not match const')
  switch (schema.type) {
    case 'object': {
      if (!plainObject(value)) outputFailure(path, 'expected object')
      const record = value as Record<string, unknown>
      const properties = schema.properties as Record<string, Record<string, any>>
      for (const required of schema.required as string[]) if (!hasOwn(record, required)) outputFailure(`${path}.${required}`, 'required property is missing')
      for (const name of Object.keys(record)) {
        if (!hasOwn(properties, name)) outputFailure(`${path}.${name}`, 'additional property is forbidden')
        validateValue(record[name], properties[name]!, `${path}.${name}`, depth + 1)
      }
      const size = Object.keys(record).length
      if (schema.minProperties !== undefined && size < schema.minProperties) outputFailure(path, 'too few properties')
      if (schema.maxProperties !== undefined && size > schema.maxProperties) outputFailure(path, 'too many properties')
      return
    }
    case 'array': {
      if (!Array.isArray(value)) outputFailure(path, 'expected array')
      if (schema.minItems !== undefined && value.length < schema.minItems) outputFailure(path, 'too few items')
      if (schema.maxItems !== undefined && value.length > schema.maxItems) outputFailure(path, 'too many items')
      value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, depth + 1))
      return
    }
    case 'string':
      if (typeof value !== 'string') outputFailure(path, 'expected string')
      if (schema.minLength !== undefined && value.length < schema.minLength) outputFailure(path, 'string is too short')
      if (schema.maxLength !== undefined && value.length > schema.maxLength) outputFailure(path, 'string is too long')
      return
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) outputFailure(path, `expected ${schema.type}`)
      if (schema.minimum !== undefined && value < schema.minimum) outputFailure(path, 'number is below minimum')
      if (schema.maximum !== undefined && value > schema.maximum) outputFailure(path, 'number is above maximum')
      return
    case 'boolean': if (typeof value !== 'boolean') outputFailure(path, 'expected boolean'); return
    case 'null': if (value !== null) outputFailure(path, 'expected null'); return
    default: outputFailure(path, 'unsupported schema type')
  }
}

export function assertStructuredOutput(value: unknown, schema: StructuredJsonSchema): asserts value is Record<string, unknown> {
  let bytes: number
  try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { outputFailure('$', 'output must be JSON serializable') }
  if (bytes! > AI_HARD_LIMITS.maxOutputBytes) outputFailure('$', `output exceeds ${AI_HARD_LIMITS.maxOutputBytes} bytes`)
  validateValue(value, schema as Record<string, any>, '$', 0)
}

export function isAllowedAiModel(provider: AiConnectionProvider, model: string): boolean {
  return AI_PROVIDER_MODELS[provider].includes(model)
}

export function aiProviderForModel(model: string): AiConnectionProvider | undefined {
  return (Object.keys(AI_PROVIDER_MODELS) as AiConnectionProvider[]).find((provider) => isAllowedAiModel(provider, model))
}

export function safeAiStatePath(value: unknown): string | undefined {
  const path = String(value || '').trim()
  if (!path || path.length > 240) return undefined
  const parts = path.split('.')
  if (parts.length > 8 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(part) || UNSAFE_PROPERTY.has(part))) return undefined
  return path
}
