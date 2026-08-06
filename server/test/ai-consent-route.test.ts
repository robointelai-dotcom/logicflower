import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const database = vi.hoisted(() => ({
  connection: { _id: '507f1f77bcf86cd799439012', provider: 'openai' } as any,
  consent: {
    _id: '507f1f77bcf86cd799439013',
    connectionId: '507f1f77bcf86cd799439012',
    provider: 'openai',
    enabled: true,
    allowedModels: ['gpt-4.1-mini'],
    maxInputTokens: 8_192,
    maxOutputTokens: 512,
    termsVersion: '2026-08-01',
    consentedAt: new Date('2026-08-05T00:00:00Z'),
  } as any,
}))
const PlatformConnectionMock = vi.hoisted(() => ({
  findOne: vi.fn((_query: any) => ({ select: () => ({ lean: async () => database.connection }) })),
}))
const ConsentMock = vi.hoisted(() => ({
  find: vi.fn((_query: any) => ({ sort: () => ({ lean: async () => [database.consent] }) })),
  findOneAndUpdate: vi.fn(async (_query: any, _update: any, _options?: any) => database.consent),
}))
const auditMock = vi.hoisted(() => vi.fn(async (_input: any) => undefined))

vi.mock('../src/models/PlatformConnection', () => ({ default: PlatformConnectionMock }))
vi.mock('../src/models/AiConnectionConsent', () => ({
  default: ConsentMock,
  AI_CONSENT_TERMS_VERSION: '2026-08-01',
  aiConnectionProviders: ['openai', 'anthropic', 'googleai'],
}))
vi.mock('../src/services/audit', () => ({ recordAudit: auditMock }))

describe('AI tenant consent API', () => {
  beforeEach(() => vi.clearAllMocks())

  async function app() {
    const [{ default: router }, { errorHandler }] = await Promise.all([
      import('../src/routes/aiConsents'),
      import('../src/http/problem'),
    ])
    const instance = express()
    instance.use(express.json())
    instance.use((req, _res, next) => {
      req.requestId = 'test-request'
      req.auth = {
        userId: '507f1f77bcf86cd799439014',
        sessionId: '507f1f77bcf86cd799439015',
        organizationId: '507f1f77bcf86cd799439011',
        role: 'owner',
        platformRole: 'user',
        mfaEnabled: false,
      }
      next()
    })
    instance.use('/ai', router)
    instance.use(errorHandler)
    return instance
  }

  it('requires an explicit external-processing acknowledgement when enabling consent', async () => {
    const response = await request(await app()).put('/ai/consents/507f1f77bcf86cd799439012').send({
      enabled: true,
      allowedModels: ['gpt-4.1-mini'],
    })
    expect(response.status).toBe(400)
    expect(response.body.detail).toMatch(/acknowledgeExternalProcessing/)
    expect(ConsentMock.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('scopes enablement to the authenticated tenant and audits only policy metadata', async () => {
    const response = await request(await app()).put('/ai/consents/507f1f77bcf86cd799439012').send({
      enabled: true,
      acknowledgeExternalProcessing: true,
      allowedModels: ['gpt-4.1-mini'],
      maxInputTokens: 8_192,
      maxOutputTokens: 512,
    })
    expect(response.status).toBe(200)
    expect(PlatformConnectionMock.findOne).toHaveBeenCalledWith(expect.objectContaining({
      _id: '507f1f77bcf86cd799439012',
      organizationId: '507f1f77bcf86cd799439011',
    }))
    expect(ConsentMock.findOneAndUpdate.mock.calls[0]![0]).toEqual({
      organizationId: '507f1f77bcf86cd799439011',
      connectionId: '507f1f77bcf86cd799439012',
    })
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai.consent_enabled' }))
    const metadata = auditMock.mock.calls[0]![0].metadata
    expect(metadata).not.toHaveProperty('apiKey')
    expect(metadata).not.toHaveProperty('prompt')
    expect(metadata).not.toHaveProperty('output')
  })
})
