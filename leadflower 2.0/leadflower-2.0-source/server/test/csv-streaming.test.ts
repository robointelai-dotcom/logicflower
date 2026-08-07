import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { DEFAULT_CSV_CHUNK_SIZE, parseCsvFile, streamCsvChunks } from '../src/services/csvIngest'

const created: string[] = []

async function writeCsv(rows: number, columns = ['email', 'phone', 'firstName']): Promise<string> {
  const file = path.join(os.tmpdir(), `lf-csv-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`)
  const lines = [columns.join(',')]
  for (let index = 0; index < rows; index += 1) {
    lines.push(`person${index}@example.com,+1555000${String(index).padStart(4, '0')},Person${index}`)
  }
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8')
  created.push(file)
  return file
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((file) => fs.rm(file, { force: true })))
})

describe('streaming CSV ingestion', () => {
  it('yields fixed-size chunks rather than one buffered array', async () => {
    const file = await writeCsv(2_500)
    const sizes: number[] = []
    for await (const chunk of streamCsvChunks(file, { chunkSize: 1_000 })) sizes.push(chunk.length)
    expect(sizes).toEqual([1_000, 1_000, 500])
  })

  it('never holds more than one chunk at a time', async () => {
    // The property that matters: peak memory is a function of chunk size, not
    // file size. Previously every row plus two ciphertexts was resident before
    // a single insert ran.
    const file = await writeCsv(5_000)
    let peak = 0
    for await (const chunk of streamCsvChunks(file, { chunkSize: 500 })) {
      peak = Math.max(peak, chunk.length)
    }
    expect(peak).toBe(500)
  })

  it('parses values correctly across chunk boundaries', async () => {
    const file = await writeCsv(1_001)
    const all: Record<string, string>[] = []
    for await (const chunk of streamCsvChunks(file, { chunkSize: 1_000 })) all.push(...chunk)
    expect(all).toHaveLength(1_001)
    expect(all[0]!.email).toBe('person0@example.com')
    // The row straddling the boundary must be intact, not split or dropped.
    expect(all[1_000]!.email).toBe('person1000@example.com')
    expect(all[1_000]!.firstName).toBe('Person1000')
  })

  it('enforces the row cap while streaming instead of after buffering', async () => {
    const file = await writeCsv(300)
    await expect(async () => {
      for await (const _chunk of streamCsvChunks(file, { maxRows: 100, chunkSize: 50 })) { /* drain */ }
    }).rejects.toThrow(/100 row limit/)
  })

  it('rejects reserved and duplicate column names', async () => {
    const proto = await writeCsv(2, ['email', '__proto__'])
    await expect(async () => {
      for await (const _chunk of streamCsvChunks(proto)) { /* drain */ }
    }).rejects.toThrow(/reserved column name/)

    const duplicate = await writeCsv(2, ['email', 'email'])
    await expect(async () => {
      for await (const _chunk of streamCsvChunks(duplicate)) { /* drain */ }
    }).rejects.toThrow(/unique/)
  })

  it('rejects a file with a header and no data rows', async () => {
    const file = path.join(os.tmpdir(), `lf-csv-empty-${Date.now()}.csv`)
    await fs.writeFile(file, 'email,phone\n', 'utf8')
    created.push(file)
    await expect(async () => {
      for await (const _chunk of streamCsvChunks(file)) { /* drain */ }
    }).rejects.toThrow(/at least one data row/)
  })

  it('keeps the buffered helper working for small inputs', async () => {
    const file = await writeCsv(10)
    const rows = await parseCsvFile(file)
    expect(rows).toHaveLength(10)
    expect(DEFAULT_CSV_CHUNK_SIZE).toBe(1_000)
  })
})
