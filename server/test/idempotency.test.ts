import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const memory = vi.hoisted(() => new Map<string, any>())
const keyFor = (query: any) => `${query.scope}:${query.key}`

const IdempotencyRecordMock = vi.hoisted(() => ({
  findOne: vi.fn((query: any) => ({ lean: vi.fn(async () => memory.get(keyFor(query)) || null) })),
  create: vi.fn(async (document: any) => {
    const key = keyFor(document)
    if (memory.has(key)) { const error: any = new Error('duplicate'); error.code = 11000; throw error }
    memory.set(key, { ...document, state: 'processing' })
    return document
  }),
  updateOne: vi.fn(async (query: any, update: any) => {
    const key = keyFor(query)
    const current = memory.get(key)
    if (!current) return { modifiedCount: 0 }
    if (query.state && current.state !== query.state) return { modifiedCount: 0 }
    memory.set(key, { ...current, ...(update.$set || {}) })
    return { modifiedCount: 1 }
  }),
  deleteOne: vi.fn(async (query: any) => ({ deletedCount: memory.delete(keyFor(query)) ? 1 : 0 })),
}))

vi.mock('../src/models/IdempotencyRecord', () => ({ default: IdempotencyRecordMock }))

import { requireIdempotency } from '../src/middleware/idempotency'

function app(handler: express.RequestHandler) {
  const value = express()
  value.use(express.json())
  value.use((req, _res, next) => {
    req.auth = {
      userId: '507f1f77bcf86cd799439011', sessionId: '507f191e810c19729de860ea',
      organizationId: '507f1f77bcf86cd799439012', role: 'owner', platformRole: 'user', mfaEnabled: false,
    }
    next()
  })
  value.post('/resource/:id', requireIdempotency, handler)
  return value
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('idempotency middleware', () => {
  beforeEach(() => { memory.clear(); vi.clearAllMocks() })

  it('replays the same request without executing it twice', async () => {
    let executions = 0
    const server = app((_req, res) => res.status(201).json({ sequence: ++executions }))
    const first = await request(server).post('/resource/a?mode=safe').set('Idempotency-Key', 'request-key-0001').send({ value: 1 })
    await settle()
    const second = await request(server).post('/resource/a?mode=safe').set('Idempotency-Key', 'request-key-0001').send({ value: 1 })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.headers['idempotent-replayed']).toBe('true')
    expect(second.body).toEqual({ sequence: 1 })
    expect(executions).toBe(1)
  })

  it('rejects reuse with a changed body, path, or query', async () => {
    const server = app((_req, res) => res.status(201).json({ ok: true }))
    await request(server).post('/resource/a?mode=safe').set('Idempotency-Key', 'request-key-0002').send({ value: 1 })
    await settle()
    expect((await request(server).post('/resource/a?mode=safe').set('Idempotency-Key', 'request-key-0002').send({ value: 2 })).status).toBe(409)
    expect((await request(server).post('/resource/b?mode=safe').set('Idempotency-Key', 'request-key-0002').send({ value: 1 })).status).toBe(409)
    expect((await request(server).post('/resource/a?mode=live').set('Idempotency-Key', 'request-key-0002').send({ value: 1 })).status).toBe(409)
  })

  it('allows only one concurrent execution for the same key', async () => {
    let executions = 0
    const server = app(async (_req, res) => {
      executions += 1
      await new Promise((resolve) => setTimeout(resolve, 30))
      res.status(201).json({ ok: true })
    })
    const first = request(server).post('/resource/a').set('Idempotency-Key', 'request-key-0003').send({ value: 1 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = request(server).post('/resource/a').set('Idempotency-Key', 'request-key-0003').send({ value: 1 })
    const responses = await Promise.all([first, second])
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
    expect(executions).toBe(1)
  })

  it('does not replay a retryable server failure', async () => {
    let executions = 0
    const server = app((_req, res) => {
      executions += 1
      if (executions === 1) return res.status(503).json({ retryable: true, message: 'temporary' })
      return res.status(201).json({ ok: true })
    })
    expect((await request(server).post('/resource/a').set('Idempotency-Key', 'request-key-0004').send({})).status).toBe(503)
    await settle()
    expect((await request(server).post('/resource/a').set('Idempotency-Key', 'request-key-0004').send({})).status).toBe(201)
    expect(executions).toBe(2)
  })
})
