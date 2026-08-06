import { Types } from 'mongoose'
import { HttpError } from './problem'

export function decodeCursor(cursor?: unknown): Types.ObjectId | undefined {
  if (!cursor) return undefined
  try {
    const value = Buffer.from(String(cursor), 'base64url').toString('utf8')
    if (!Types.ObjectId.isValid(value)) throw new Error('invalid')
    return new Types.ObjectId(value)
  } catch {
    throw new HttpError(400, 'Invalid cursor', 'Pagination cursor is invalid')
  }
}

export function encodeCursor(id: unknown): string {
  return Buffer.from(String(id), 'utf8').toString('base64url')
}

export function pageLimit(value: unknown, fallback = 25): number {
  const parsed = Number(value || fallback)
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, 'Invalid limit', 'limit must be a positive integer')
  return Math.min(parsed, 100)
}
