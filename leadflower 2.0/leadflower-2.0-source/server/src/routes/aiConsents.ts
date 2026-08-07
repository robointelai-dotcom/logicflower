import { Router } from 'express'
import { Types } from 'mongoose'
import { z } from 'zod'
import { asyncHandler, HttpError, parseBody } from '../http/problem'
import AiConnectionConsent, { AI_CONSENT_TERMS_VERSION, AiConnectionProvider } from '../models/AiConnectionConsent'
import PlatformConnection from '../models/PlatformConnection'
import { requireRole } from '../middleware/rbac'
import { AI_HARD_LIMITS, AI_PROVIDER_MODELS, isAllowedAiModel } from '../services/aiPolicy'
import { recordAudit } from '../services/audit'

const router = Router()
router.use(requireRole('owner', 'admin'))

function organizationId(req: Express.Request): string {
  if (!req.auth?.organizationId) throw new HttpError(403, 'Organization required', 'Select an organization first')
  return req.auth.organizationId
}

function safeConsent(row: any) {
  return {
    id: String(row._id),
    connectionId: String(row.connectionId),
    provider: row.provider,
    enabled: Boolean(row.enabled),
    allowedModels: row.allowedModels || [],
    maxInputTokens: row.maxInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    termsVersion: row.termsVersion,
    consentedAt: row.consentedAt || null,
    revokedAt: row.revokedAt || null,
    updatedAt: row.updatedAt,
  }
}

router.get('/catalog', (_req, res) => {
  res.json({
    providers: Object.entries(AI_PROVIDER_MODELS).map(([provider, models]) => ({ provider, models })),
    limits: AI_HARD_LIMITS,
    termsVersion: AI_CONSENT_TERMS_VERSION,
  })
})

router.get('/consents', asyncHandler(async (req, res) => {
  const rows = await AiConnectionConsent.find({ organizationId: organizationId(req) }).sort({ updatedAt: -1 }).lean()
  res.json({ items: rows.map(safeConsent) })
}))

const consentBody = z.discriminatedUnion('enabled', [
  z.object({
    enabled: z.literal(true),
    acknowledgeExternalProcessing: z.literal(true),
    allowedModels: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
    maxInputTokens: z.number().int().min(512).max(AI_HARD_LIMITS.maxInputTokens).default(8_192),
    maxOutputTokens: z.number().int().min(1).max(AI_HARD_LIMITS.maxOutputTokens).default(1_024),
  }).strict(),
  z.object({ enabled: z.literal(false) }).strict(),
])

router.put('/consents/:connectionId', asyncHandler(async (req, res) => {
  const orgId = organizationId(req)
  const connectionId = String(req.params.connectionId || '')
  if (!Types.ObjectId.isValid(connectionId)) throw new HttpError(400, 'Invalid connection', 'connectionId is invalid')
  const body = parseBody(consentBody, req)
  if (!body.enabled) {
    const row: any = await AiConnectionConsent.findOneAndUpdate({ organizationId: orgId, connectionId }, {
      $set: { enabled: false, revokedBy: req.auth!.userId, revokedAt: new Date() },
    }, { new: true })
    if (!row) throw new HttpError(404, 'AI consent not found', 'No AI consent exists for this connection')
    await recordAudit({
      action: 'ai.consent_disabled',
      req,
      entityType: 'AiConnectionConsent',
      entityId: String(row._id),
      metadata: { provider: row.provider, connectionId },
    })
    res.json({ consent: safeConsent(row) })
    return
  }
  const connection: any = await PlatformConnection.findOne({
    _id: connectionId,
    organizationId: orgId,
    provider: { $in: ['openai', 'anthropic', 'googleai'] },
    status: { $in: ['active', 'degraded', 'error'] },
  }).select('provider').lean()
  if (!connection) throw new HttpError(404, 'AI connection not found', 'An active tenant AI connection was not found')
  const provider = connection.provider as AiConnectionProvider

  const allowedModels = Array.from(new Set(body.allowedModels))
  if (allowedModels.some((model) => !isAllowedAiModel(provider, model))) {
    throw new HttpError(400, 'Model not allowed', `Every allowed model must be an approved ${provider} model`)
  }
  const row: any = await AiConnectionConsent.findOneAndUpdate({ organizationId: orgId, connectionId: connection._id }, {
    $set: {
      provider,
      enabled: true,
      allowedModels,
      maxInputTokens: body.maxInputTokens,
      maxOutputTokens: body.maxOutputTokens,
      termsVersion: AI_CONSENT_TERMS_VERSION,
      consentedBy: req.auth!.userId,
      consentedAt: new Date(),
    },
    $unset: { revokedBy: 1, revokedAt: 1 },
  }, { new: true, upsert: true, setDefaultsOnInsert: true })
  await recordAudit({
    action: 'ai.consent_enabled',
    req,
    entityType: 'AiConnectionConsent',
    entityId: String(row._id),
    metadata: {
      provider,
      connectionId: String(connection._id),
      allowedModels: row.allowedModels,
      maxInputTokens: row.maxInputTokens,
      maxOutputTokens: row.maxOutputTokens,
      termsVersion: row.termsVersion,
    },
  })
  res.json({ consent: safeConsent(row) })
}))

export default router
