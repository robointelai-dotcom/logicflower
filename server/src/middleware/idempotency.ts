import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'
import IdempotencyRecord from '../models/IdempotencyRecord'
import { sendProblem, problemType} from '../http/problem'

const SAFE_KEY = /^[A-Za-z0-9._:-]{8,200}$/

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
  }
  return value
}

function bodyHash(req: Request): string {
  return crypto.createHash('sha256').update(JSON.stringify(stable({ body: req.body || {}, query: req.query || {}, uploadHash: req.uploadHash || null }))).digest('hex')
}

export async function requireIdempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.idempotencyKey) { next(); return }
  const key = String(req.headers['idempotency-key'] || '')
  if (!SAFE_KEY.test(key)) {
    sendProblem(req, res, {
      status: 400,
      title: 'Idempotency key required',
      detail: 'Provide an Idempotency-Key header containing 8 to 200 safe characters',
      type: problemType('idempotency'),
    })
    return
  }
  const scope = req.auth?.organizationId || `user:${req.auth?.userId || req.ip}`
  const route = String(req.originalUrl || req.url).split('?')[0]
  const requestHash = bodyHash(req)
  const query = { scope, key }
  const existing: any = await IdempotencyRecord.findOne(query).lean()
  if (existing) {
    if (existing.requestHash !== requestHash || existing.method !== req.method || existing.route !== route) {
      sendProblem(req, res, { status: 409, title: 'Idempotency conflict', detail: 'This key was already used with a different request body' })
      return
    }
    if (existing.state === 'completed') {
      res.setHeader('Idempotent-Replayed', 'true')
      res.status(existing.responseStatus || 200).json(existing.responseBody ?? null)
      return
    }
    if (existing.processingExpiresAt && new Date(existing.processingExpiresAt) <= new Date()) {
      const reclaimed = await IdempotencyRecord.updateOne({ ...query, state: 'processing', processingExpiresAt: { $lte: new Date() } }, {
        $set: { requestHash, processingExpiresAt: new Date(Date.now() + 2 * 60_000) },
      })
      if (!reclaimed.modifiedCount) {
        sendProblem(req, res, { status: 409, title: 'Request already processing', detail: 'A request with this key is still processing', retryable: true })
        return
      }
    } else {
      sendProblem(req, res, { status: 409, title: 'Request already processing', detail: 'A request with this key is still processing', retryable: true })
      return
    }
  }
  if (!existing) {
    try {
      await IdempotencyRecord.create({
        ...query,
        method: req.method,
        route,
        requestHash,
        processingExpiresAt: new Date(Date.now() + 2 * 60_000),
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      })
    } catch (error: any) {
      if (error?.code === 11000) {
        sendProblem(req, res, { status: 409, title: 'Request already processing', detail: 'A request with this key is still processing', retryable: true })
        return
      }
      throw error
    }
  }
  req.idempotencyKey = key
  let responseBody: unknown
  const originalJson = res.json.bind(res)
  res.json = ((body: unknown) => {
    responseBody = body
    return originalJson(body)
  }) as typeof res.json
  res.once('finish', () => {
    const retryable = Boolean((responseBody as any)?.retryable)
    if (res.statusCode >= 500 || retryable) {
      void IdempotencyRecord.deleteOne({ ...query, state: 'processing' }).catch(() => undefined)
    } else {
      void IdempotencyRecord.updateOne(query, {
        $set: { state: 'completed', responseStatus: res.statusCode, responseBody },
      }).catch(() => undefined)
    }
  })
  next()
}
