const SENSITIVE_KEY = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|cookie|set-cookie|signature|private[-_]?key)/i;
const PII_KEY = /^(email|phone|mobile|firstName|lastName|name|address|postalCode)$/i;

export interface RedactionOptions {
  redactPii?: boolean;
  maxDepth?: number;
  maxStringLength?: number;
}

export function redact(value: any, options: RedactionOptions = {}, depth = 0): any {
  const maxDepth = options.maxDepth ?? 8;
  const maxStringLength = options.maxStringLength ?? 16_384;
  if (depth > maxDepth) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return `[BUFFER:${value.length}]`;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}[TRUNCATED]` : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 1_000).map(item => redact(item, options, depth + 1));
  const output: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || (options.redactPii && PII_KEY.test(key))) output[key] = '[REDACTED]';
    else output[key] = redact(item, options, depth + 1);
  }
  return output;
}

export function redactedError(error: any) {
  return redact({
    name: String(error?.name || 'Error'),
    code: error?.code ? String(error.code) : undefined,
    message: String(error?.message || error || 'Unknown error'),
    status: error?.response?.status,
    response: error?.response?.data,
  });
}

export function redactHeaders(headers: Record<string, any> | undefined) {
  return redact(headers || {});
}
