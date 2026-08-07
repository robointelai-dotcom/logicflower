export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryable?: (error: any) => boolean;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.min(10, options.attempts ?? 3));
  const base = Math.max(25, options.baseDelayMs ?? 250);
  const maximum = Math.max(base, options.maxDelayMs ?? 10_000);
  let lastError: any;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await fn(attempt); }
    catch (error: any) {
      lastError = error;
      const retryable = options.retryable ? options.retryable(error) : isRetryableHttpError(error);
      if (!retryable || attempt === attempts) break;
      const retryAfter = Number(error?.response?.headers?.['retry-after']);
      const exponential = Math.min(maximum, base * Math.pow(2, attempt - 1));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(maximum, retryAfter * 1_000) : exponential + Math.floor(Math.random() * Math.max(1, exponential / 4));
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export function isRetryableHttpError(error: any) {
  const status = Number(error?.response?.status || error?.status || 0);
  return !status || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
