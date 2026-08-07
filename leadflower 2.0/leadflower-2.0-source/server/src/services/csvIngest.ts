import { createReadStream } from 'fs'
import { parse } from 'csv-parse'

/**
 * Streaming CSV ingestion.
 *
 * The previous implementation stream-*parsed* but memory-*buffered*: it pushed
 * every row into an array and returned it, after which the batch builder
 * materialised 50,000 record objects each carrying two AES-GCM ciphertexts
 * before a single insert. Peak memory was bounded only by the row cap times the
 * 1 MiB per-record ceiling, which is not a bound worth having.
 *
 * This version yields fixed-size chunks, so the caller can normalise, encrypt
 * and insert one chunk at a time and hold only that chunk in memory. Peak
 * memory becomes a function of chunk size rather than file size.
 */

const FORBIDDEN_COLUMNS = new Set(['__proto__', 'prototype', 'constructor'])

export const DEFAULT_CSV_CHUNK_SIZE = 1_000

export interface CsvStreamOptions {
  maxRows?: number
  chunkSize?: number
}

function buildParser(filePath: string) {
  let headerSeen = false
  const parser = createReadStream(filePath).pipe(parse({
    bom: true,
    columns: (headers: string[]) => {
      if (!Array.isArray(headers) || headers.length === 0 || headers.length > 200) throw new Error('CSV must contain between 1 and 200 columns')
      const normalized = headers.map((header) => String(header).trim())
      if (normalized.some((header) => !header || header.length > 128)) throw new Error('CSV column names must be non-empty and at most 128 characters')
      if (normalized.some((header) => FORBIDDEN_COLUMNS.has(header.toLowerCase()))) throw new Error('CSV contains a reserved column name')
      if (new Set(normalized).size !== normalized.length) throw new Error('CSV column names must be unique')
      headerSeen = true
      return normalized
    },
    skip_empty_lines: true,
    trim: true,
    max_record_size: 1_048_576,
  }))
  return { parser, sawHeader: () => headerSeen }
}

function safeRow(record: unknown): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) safe[key] = String(value ?? '')
  return safe
}

/**
 * Yield rows in fixed-size chunks.
 *
 * Back-pressure is preserved: `for await` on the parser pauses the underlying
 * read stream while the consumer awaits its insert, so a slow database throttles
 * the file read rather than letting rows accumulate in memory.
 */
export async function* streamCsvChunks(
  filePath: string,
  options: CsvStreamOptions = {},
): AsyncGenerator<Record<string, string>[], void, undefined> {
  const maxRows = options.maxRows ?? 50_000
  const chunkSize = Math.max(1, Math.min(10_000, options.chunkSize ?? DEFAULT_CSV_CHUNK_SIZE))
  const { parser, sawHeader } = buildParser(filePath)

  let chunk: Record<string, string>[] = []
  let total = 0
  for await (const record of parser) {
    if (total >= maxRows) throw new Error(`CSV exceeds the ${maxRows} row limit`)
    chunk.push(safeRow(record))
    total += 1
    if (chunk.length >= chunkSize) {
      yield chunk
      chunk = []
    }
  }
  if (chunk.length) yield chunk
  if (!sawHeader()) throw new Error('CSV header row is required')
  if (!total) throw new Error('CSV must contain at least one data row')
}

/**
 * Buffered read, retained for small inputs and for callers that genuinely need
 * the whole set at once. Guarded by a lower default cap than the streaming
 * path, because a caller that materialises everything should be doing so only
 * for modest files.
 */
export async function parseCsvFile(filePath: string, maxRows = 5_000): Promise<Record<string, string>[]> {
  const rows: Record<string, string>[] = []
  for await (const chunk of streamCsvChunks(filePath, { maxRows })) rows.push(...chunk)
  return rows
}
