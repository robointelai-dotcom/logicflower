import { Router } from 'express'
import { z } from 'zod'
import PlatformConnection, { platformProviders, PlatformProvider } from '../models/PlatformConnection'
import { asyncHandler, HttpError, parseBody, problemType} from '../http/problem'
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor'
import { requireRole } from '../middleware/rbac'
import { requireIdempotency } from '../middleware/idempotency'
import { createPlatformConnection, updateConnectionCredential } from '../services/connectionCredentials'
import { validateOutboundUrl } from '../services/ssrfGuard'
import { recordAudit } from '../services/audit'
import { disconnectConnection } from '../services/connectionLifecycle'
import { env } from '../env'
import Destination from '../models/Destination'
import { decryptJson, encryptJson } from '../security/encryption'
import { Types } from 'mongoose'
import { buildAuthorizationUrl, connectorHealth, exchangeAuthorizationCode, OAuthProvider, oauthPkce, registerConnectorRevokers } from '../services/oauthProviders'
import { consumeOAuthState, createOAuthState } from '../services/oauthState'
import ConnectionScan from '../models/ConnectionScan'
import { queueConnectionScan, serializeConnectionScan } from '../services/connectionScan'
import { canCreateConnection, connectorReleaseReason, connectorReleaseSummary } from '../services/connectors/releaseState'
import { connectionCapabilityMatrix, isProbeable, runCapabilityProbe } from '../services/capability/capabilityService'
import { CAPABILITIES, CapabilityKey } from '../services/capability/capabilityModel'

registerConnectorRevokers()

const router = Router()
const manage = requireRole('owner', 'admin')

const credentialSchema = z.record(z.unknown()).refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 32_768, {
  message: 'credentials payload is too large',
})
const createSchema = z.object({
  provider: z.enum(platformProviders),
  name: z.string().trim().min(2).max(160).refine((value) => !/[\r\n]/.test(value)),
  externalAccountId: z.string().trim().max(240).optional(),
  credentials: credentialSchema,
  scopes: z.array(z.string().min(1).max(160)).max(100).default([]),
  tokenExpiresAt: z.coerce.date().optional(),
}).strict()

function organizationId(req: Express.Request): string {
  if (!req.auth?.organizationId) throw new HttpError(403, 'Organization required', 'Select an organization first')
  return req.auth.organizationId
}

function connectionObjectId(value: unknown): string {
  const id = String(value || '')
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid connection', 'The connection identifier is invalid')
  return id
}

function safeConnection(row: any) {
  return {
    id: String(row._id),
    provider: row.provider,
    name: row.name,
    externalAccountId: row.externalAccountId || null,
    status: row.status,
    scopes: row.scopes || [],
    tokenExpiresAt: row.tokenExpiresAt || null,
    lastHealthyAt: row.lastHealthyAt || null,
    lastError: row.lastError || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function validateCredentials(provider: PlatformProvider, source: Record<string, unknown>, allowMetadataOnly = false): Promise<Record<string, unknown>> {
  const credentials = { ...source }
  const metadata = credentials.metadata && typeof credentials.metadata === 'object' && !Array.isArray(credentials.metadata) ? { ...(credentials.metadata as Record<string, unknown>) } : undefined
  if (metadata) {
    const allowed = new Set(['webhookSecret', 'webhookHeaderName'])
    if (Object.keys(metadata).some((key) => !allowed.has(key))) throw new HttpError(400, 'Invalid credential metadata', 'Only approved webhook verification metadata is accepted')
    const webhookSecret = String(metadata.webhookSecret || '')
    if (webhookSecret && (webhookSecret.length < 16 || webhookSecret.length > 512)) throw new HttpError(400, 'Invalid webhook secret', 'Webhook signing secret must be 16 to 512 characters')
    if (metadata.webhookHeaderName && !/^x-[a-z0-9-]{2,80}$/i.test(String(metadata.webhookHeaderName))) throw new HttpError(400, 'Invalid webhook header', 'Webhook signature header must be a safe X- header name')
    credentials.metadata = metadata
  }
  const metadataOnly = allowMetadataOnly && Object.keys(credentials).every((key) => key === 'metadata') && Boolean(metadata?.webhookSecret)
  if (metadataOnly && !['activecampaign', 'klaviyo', 'hubspot'].includes(provider)) throw new HttpError(400, 'Webhook metadata unavailable', `Webhook verification metadata is not accepted for ${provider}`)
  if (metadataOnly) return credentials
  if (provider === 'activecampaign') {
    const apiKey = String(credentials.apiKey || '').trim()
    const rawUrl = String(credentials.accountBaseUrl || credentials.baseUrl || '').trim()
    if (apiKey.length < 8 || !rawUrl) throw new HttpError(400, 'Invalid ActiveCampaign credentials', 'apiKey and accountBaseUrl are required')
    try {
      const url = (await validateOutboundUrl(rawUrl)).url
      url.search = ''
      url.hash = ''
      credentials.baseUrl = url.toString().replace(/\/$/, '')
      delete credentials.accountBaseUrl
    } catch (error: any) {
      throw new HttpError(400, 'Invalid ActiveCampaign URL', error.message)
    }
  } else if (['openai', 'anthropic', 'googleai'].includes(provider)) {
    const apiKey = String(credentials.apiKey || '').trim()
    if (apiKey.length < 8) throw new HttpError(400, 'API key required', `An API key is required for ${provider}`)
    if (Object.keys(credentials).some((key) => key !== 'apiKey')) {
      throw new HttpError(400, 'Invalid AI credential', 'AI connections accept only an API key; provider endpoints and inline configuration are fixed by policy')
    }
    return { apiKey }
  } else if (provider === 'generic') {
    const rawUrl = String(credentials.baseUrl || '').trim()
    if (!rawUrl) throw new HttpError(400, 'Base URL required', 'A public HTTPS baseUrl is required')
    try { credentials.baseUrl = (await validateOutboundUrl(rawUrl)).url.toString().replace(/\/$/, '') }
    catch (error: any) { throw new HttpError(400, 'Invalid base URL', error.message) }
  } else if (!credentials.accessToken && !credentials.apiKey) {
    throw new HttpError(400, 'Credential required', 'An OAuth access token or approved API key is required')
  }
  return credentials
}

router.get('/catalog', (_req, res) => {
  res.json({ items: [
    { provider: 'ghl', auth: 'oauth2', enabled: Boolean(env.GHL_CLIENT_ID && env.GHL_CLIENT_SECRET && env.GHL_REDIRECT_URI) },
    { provider: 'hubspot', auth: 'oauth2', enabled: Boolean(env.HUBSPOT_CLIENT_ID && env.HUBSPOT_CLIENT_SECRET && env.HUBSPOT_REDIRECT_URI) },
    { provider: 'klaviyo', auth: 'oauth2_or_api_key', enabled: Boolean(env.KLAVIYO_CLIENT_ID && env.KLAVIYO_CLIENT_SECRET && env.KLAVIYO_REDIRECT_URI) },
    { provider: 'activecampaign', auth: 'api_token', enabled: true },
    { provider: 'google', auth: 'oauth2', enabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI) },
    { provider: 'openai', auth: 'api_key', enabled: true },
    { provider: 'anthropic', auth: 'api_key', enabled: true },
    { provider: 'googleai', auth: 'api_key', enabled: true },
    { provider: 'generic', auth: 'credential', enabled: true },
  ] })
})

router.get('/', asyncHandler(async (req, res) => {
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  const query: Record<string, unknown> = { organizationId: organizationId(req) }
  if (req.query.provider) query.provider = z.enum(platformProviders).parse(req.query.provider)
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await PlatformConnection.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({ items: rows.slice(0, limit).map(safeConnection), nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null })
}))

router.get('/destinations', asyncHandler(async (req, res) => {
  const limit = pageLimit(req.query.limit); const cursor = decodeCursor(req.query.cursor); const query: any = { organizationId: organizationId(req) }; if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await Destination.find(query).sort({ _id: -1 }).limit(limit + 1).lean(); const hasMore = rows.length > limit
  res.json({ items: rows.slice(0, limit).map((row: any) => ({
    id: String(row._id), name: row.name, hostname: row.hostname,
    allowedMethods: row.allowedMethods, status: row.status, verifiedAt: row.verifiedAt,
  })), nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null })
}))

router.post('/destinations', manage, requireIdempotency, asyncHandler(async (req, res) => {
  const body = parseBody(z.object({
    name: z.string().trim().min(2).max(160),
    exactUrl: z.string().url().max(2_048),
    allowedMethods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH'])).min(1).max(4).default(['POST']),
    headers: z.record(z.string().max(4_096)).default({}),
  }).strict(), req)
  const validated = await validateOutboundUrl(body.exactUrl).catch((error: any) => {
    throw new HttpError(400, 'Invalid destination', error.message)
  })
  if (validated.url.username || validated.url.password) throw new HttpError(400, 'Invalid destination', 'Embedded URL credentials are not allowed')
  const id = new Types.ObjectId()
  const row = await Destination.create({
    _id: id,
    organizationId: organizationId(req),
    name: body.name,
    hostname: validated.url.hostname,
    pinnedAddresses: validated.addresses,
    allowedMethods: Array.from(new Set(body.allowedMethods)),
    encryptedConfig: encryptJson({ url: validated.url.toString(), headers: body.headers }, `destination:${organizationId(req)}:${String(id)}`),
    status: 'verified',
    verifiedAt: new Date(),
    createdBy: req.auth!.userId,
  })
  await recordAudit({ action: 'destination.created', req, entityType: 'Destination', entityId: String(row._id), metadata: { hostname: row.hostname } })
  res.status(201).json({ destination: {
    id: String(row._id), name: row.name, hostname: row.hostname,
    allowedMethods: row.allowedMethods, status: row.status, verifiedAt: row.verifiedAt,
  } })
}))

router.patch('/destinations/:destinationId', manage, asyncHandler(async (req, res) => {
  const body = parseBody(z.object({
    name: z.string().trim().min(2).max(160).optional(),
    exactUrl: z.string().url().max(2_048).optional(),
    allowedMethods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH'])).min(1).max(4).optional(),
    headers: z.record(z.string().max(4_096)).optional(),
    status: z.enum(['verified', 'disabled']).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' }), req)
  const row: any = await Destination.findOne({
    _id: req.params.destinationId, organizationId: organizationId(req),
  }).select('+encryptedConfig')
  if (!row) throw new HttpError(404, 'Destination not found', 'Destination not found')
  const aad = `destination:${organizationId(req)}:${String(row._id)}`
  const existing = decryptJson<{ url: string; headers: Record<string, string> }>(row.encryptedConfig, aad)
  let url = new URL(existing.url)
  let addresses = row.pinnedAddresses || []
  if (body.exactUrl) {
    const validated = await validateOutboundUrl(body.exactUrl).catch((error: any) => {
      throw new HttpError(400, 'Invalid destination', error.message)
    })
    url = validated.url
    addresses = validated.addresses
  }
  row.encryptedConfig = encryptJson({ url: url.toString(), headers: body.headers || existing.headers }, aad)
  row.hostname = url.hostname
  row.pinnedAddresses = addresses
  if (body.name) row.name = body.name
  if (body.allowedMethods) row.allowedMethods = Array.from(new Set(body.allowedMethods))
  if (body.status) row.status = body.status
  row.verifiedAt = new Date()
  await row.save()
  await recordAudit({ action: 'destination.updated', req, entityType: 'Destination', entityId: String(row._id), metadata: { hostname: row.hostname, status: row.status } })
  res.json({ destination: {
    id: String(row._id), name: row.name, hostname: row.hostname,
    allowedMethods: row.allowedMethods, status: row.status, verifiedAt: row.verifiedAt,
  } })
}))

router.delete('/destinations/:destinationId', manage, asyncHandler(async (req, res) => {
  const row = await Destination.findOneAndUpdate({
    _id: req.params.destinationId, organizationId: organizationId(req), status: { $ne: 'disabled' },
  }, { $set: { status: 'disabled' } }, { new: true })
  if (!row) throw new HttpError(404, 'Destination not found', 'Active destination not found')
  await recordAudit({ action: 'destination.disabled', req, entityType: 'Destination', entityId: String(row._id), metadata: { hostname: row.hostname } })
  res.status(204).end()
}))

router.post('/', manage, requireIdempotency, asyncHandler(async (req, res) => {
  const body = parseBody(createSchema, req)
  if (!canCreateConnection(body.provider)) {
    throw new HttpError(451, 'Connector unavailable', connectorReleaseReason(body.provider) || `The ${body.provider} connector cannot accept new connections in this deployment.`, problemType('connector-quarantined'))
  }
  const credentials = await validateCredentials(body.provider, body.credentials)
  const row = await createPlatformConnection({
    organizationId: organizationId(req), provider: body.provider, name: body.name,
    externalAccountId: body.externalAccountId, credentials, scopes: body.scopes,
    // A scope list typed into a form is an assertion by the operator, not a
    // grant by the provider. It is recorded as such so that capability
    // resolution can refuse to treat it as evidence.
    grantedScopes: [], requestedScopes: body.scopes, scopeSource: 'operator_claimed',
    scopeObservedAt: new Date(),
    tokenExpiresAt: body.tokenExpiresAt, createdBy: req.auth!.userId,
  })
  await recordAudit({ action: 'connection.created', req, entityType: 'PlatformConnection', entityId: String(row._id), metadata: { provider: row.provider } })
  const scan = await queueConnectionScan({ organizationId: organizationId(req), connectionId: String(row._id), provider: row.provider, reason: 'connection' })
  res.status(201).json({ connection: safeConnection(row), scan })
}))

router.post('/:provider/oauth/start', manage, requireIdempotency, asyncHandler(async (req, res) => {
  const provider = z.enum(platformProviders).parse(req.params.provider)
  if (['activecampaign', 'openai', 'anthropic', 'googleai', 'generic'].includes(provider)) {
    throw new HttpError(501, 'OAuth unavailable', `${provider} is configured using an API credential, not OAuth in LogicFlower`)
  }
  const parsed = parseBody(z.object({
    redirectTo: z.string().max(500).default('/settings/connections'),
    connectionId: z.string().refine((value) => Types.ObjectId.isValid(value), 'connectionId is invalid').optional(),
  }).strict(), req)
  const redirectTo = parsed.redirectTo || '/settings/connections'
  if (!redirectTo.startsWith('/') || redirectTo.startsWith('//') || redirectTo.includes('\\')) {
    throw new HttpError(400, 'Invalid redirect', 'redirectTo must be a same-origin relative path')
  }
  const pkce = oauthPkce()
  if (parsed.connectionId && !await PlatformConnection.exists({
    _id: parsed.connectionId,
    organizationId: organizationId(req),
    provider,
    status: { $in: ['active', 'degraded', 'error'] },
  })) throw new HttpError(404, 'Connection not found', 'A reconnectable provider connection was not found')
  try {
    buildAuthorizationUrl({ provider: provider as OAuthProvider, state: 'configuration-check', codeChallenge: pkce.challenge })
  } catch (error: any) {
    throw new HttpError(503, 'OAuth connector unavailable', String(error?.message || 'OAuth is not configured'), 'about:blank', true)
  }
  const { state, expiresAt } = await createOAuthState({
    organizationId: organizationId(req), userId: req.auth!.userId, provider,
    connectionId: parsed.connectionId, redirectTo, codeVerifier: pkce.verifier,
  })
  const authorization = buildAuthorizationUrl({ provider: provider as OAuthProvider, state, codeChallenge: pkce.challenge })
  res.status(201).json({ ...authorization, expiresAt })
}))

router.get('/:connectionId', asyncHandler(async (req, res) => {
  const row = await PlatformConnection.findOne({ _id: req.params.connectionId, organizationId: organizationId(req) }).lean()
  if (!row) throw new HttpError(404, 'Connection not found', 'Connection not found')
  res.json({ connection: safeConnection(row) })
}))

router.get('/:connectionId/scans', asyncHandler(async (req, res) => {
  const connection = await PlatformConnection.exists({ _id: req.params.connectionId, organizationId: organizationId(req) })
  if (!connection) throw new HttpError(404, 'Connection not found', 'Connection not found')
  const limit = pageLimit(req.query.limit); const cursor = decodeCursor(req.query.cursor); const query: any = { organizationId: organizationId(req), connectionId: req.params.connectionId }; if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await ConnectionScan.find(query).sort({ _id: -1 }).limit(limit + 1).lean(); const hasMore = rows.length > limit
  res.json({ items: rows.slice(0, limit).map(serializeConnectionScan), nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null })
}))

router.post('/:connectionId/scan', manage, requireIdempotency, asyncHandler(async (req, res) => {
  const row: any = await PlatformConnection.findOne({ _id: req.params.connectionId, organizationId: organizationId(req), status: { $in: ['active', 'degraded'] } }).select('provider')
  if (!row) throw new HttpError(404, 'Connection not found', 'An active connection was not found')
  const scan = await queueConnectionScan({ organizationId: organizationId(req), connectionId: String(row._id), provider: row.provider, reason: 'manual' })
  if (!scan) throw new HttpError(422, 'Scan unavailable', `${row.provider} does not expose a contact inventory for the onboarding scan`)
  await recordAudit({ action: 'connection.scan_queued', req, entityType: 'ConnectionScan', entityId: String(scan.id), metadata: { connectionId: String(row._id), provider: row.provider } })
  res.status(202).json({ scan })
}))

router.patch('/:connectionId', manage, asyncHandler(async (req, res) => {
  const body = parseBody(z.object({
    name: z.string().trim().min(2).max(160).optional(),
    credentials: credentialSchema.optional(),
  }).strict(), req)
  const row: any = await PlatformConnection.findOne({ _id: req.params.connectionId, organizationId: organizationId(req), status: { $ne: 'revoked' } })
  if (!row) throw new HttpError(404, 'Connection not found', 'Connection not found')
  if (body.credentials) {
    await updateConnectionCredential({
      organizationId: organizationId(req), connectionId: String(row._id), provider: row.provider,
      credentials: await validateCredentials(row.provider, body.credentials, true),
      merge: !['openai', 'anthropic', 'googleai'].includes(row.provider),
    })
  }
  if (body.name) { row.name = body.name; await row.save() }
  await recordAudit({ action: 'connection.updated', req, entityType: 'PlatformConnection', entityId: String(row._id), metadata: { credentialsChanged: Boolean(body.credentials) } })
  if (body.credentials) await queueConnectionScan({ organizationId: organizationId(req), connectionId: String(row._id), provider: row.provider, reason: 'reauthorization' })
  const refreshed = await PlatformConnection.findOne({ _id: row._id, organizationId: organizationId(req) }).lean()
  res.json({ connection: safeConnection(refreshed) })
}))

router.post('/:connectionId/disconnect', manage, requireIdempotency, asyncHandler(async (req, res) => {
  const row: any = await PlatformConnection.findOne({ _id: req.params.connectionId, organizationId: organizationId(req), status: { $ne: 'revoked' } })
  if (!row) throw new HttpError(404, 'Connection not found', 'Active connection not found')
  try {
    const result = await disconnectConnection({ organizationId: organizationId(req), connectionId: String(row._id), provider: row.provider })
    await recordAudit({ action: 'connection.disconnected', req, entityType: 'PlatformConnection', entityId: String(row._id), metadata: { provider: row.provider, ...result } })
    res.json({ status: 'revoked', ...result })
  } catch (error: any) {
    await recordAudit({ action: 'connection.disconnect_failed', req, entityType: 'PlatformConnection', entityId: String(row._id), metadata: { provider: row.provider, reason: error.message } })
    res.status(202).json({
      status: 'disconnecting',
      deletionScheduled: true,
      remoteRevocationPending: true,
      message: 'New use is blocked immediately. Remote revocation and credential deletion remain queued.',
    })
  }
}))

router.post('/:connectionId/health-check', manage, asyncHandler(async (req, res) => {
  const row: any = await PlatformConnection.findOne({
    _id: req.params.connectionId,
    organizationId: organizationId(req),
    status: { $in: ['active', 'degraded', 'error'] },
  })
  if (!row) throw new HttpError(404, 'Connection not found', 'Active connection not found')
  if (!['ghl', 'hubspot', 'klaviyo', 'activecampaign', 'google'].includes(row.provider)) {
    throw new HttpError(501, 'Health check unavailable', `Health checks are not available for ${row.provider}`)
  }
  try {
    const health = await connectorHealth({
      organizationId: organizationId(req), provider: row.provider, connectionId: String(row._id),
    })
    row.status = health.ok ? 'active' : 'degraded'
    row.lastHealthyAt = health.ok ? new Date() : row.lastHealthyAt
    row.lastError = health.ok ? undefined : 'Provider health check returned an unhealthy result'
    await row.save()
    await recordAudit({ action: 'connection.health_checked', req, entityType: 'PlatformConnection', entityId: String(row._id), metadata: { ok: health.ok } })
    res.json({ ok: health.ok, account: health.account || null, checkedAt: new Date() })
  } catch (error: any) {
    row.status = 'degraded'
    row.lastError = String(error?.message || 'Health check failed').slice(0, 1_000)
    await row.save()
    throw new HttpError(502, 'Provider health check failed', 'The provider rejected or did not answer the health check', 'about:blank', true)
  }
}))

export const oauthCallback = asyncHandler(async (req, res) => {
  const provider = z.enum(['ghl', 'hubspot', 'klaviyo', 'google']).parse(req.params.provider) as OAuthProvider
  if (req.query.error) throw new HttpError(400, 'OAuth authorization denied', 'The provider did not authorize this connection')
  const code = String(req.query.code || '')
  const state = String(req.query.state || '')
  if (!code || !state) throw new HttpError(400, 'Invalid OAuth callback', 'code and state are required')
  const consumed = await consumeOAuthState({ state, provider })
  const token = await exchangeAuthorizationCode({ provider, code, codeVerifier: consumed.codeVerifier })
  const label = provider === 'ghl' ? 'HighLevel' : provider === 'google' ? 'Google Sheets' : provider[0]!.toUpperCase() + provider.slice(1)
  let row: any
  if (consumed.connectionId) {
    row = await PlatformConnection.findOne({
      _id: consumed.connectionId,
      organizationId: consumed.organizationId,
      provider,
      status: { $in: ['active', 'degraded', 'error'] },
    })
    if (!row) throw new HttpError(404, 'Connection not found', 'The connection selected for reauthorization is unavailable')
    await updateConnectionCredential({
      organizationId: consumed.organizationId,
      connectionId: String(row._id),
      provider,
      credentials: token.credentials,
      merge: true,
      tokenExpiresAt: token.tokenExpiresAt,
      status: 'active',
    })
    row.scopes = token.grantedScopes
    row.grantedScopes = token.grantedScopes
    row.requestedScopes = token.requestedScopes
    row.scopeSource = token.scopeSource
    row.scopeObservedAt = new Date()
    row.tokenExpiresAt = token.tokenExpiresAt
    row.status = 'active'
    row.lastError = undefined
    await row.save()
  } else {
    row = await createPlatformConnection({
      organizationId: consumed.organizationId,
      provider,
      name: `${label} connection`,
      credentials: token.credentials,
      createdBy: consumed.userId,
      externalAccountId: String((token.credentials as any).locationId || (token.credentials as any).metadata?.accountId || '') || undefined,
      scopes: token.grantedScopes,
      grantedScopes: token.grantedScopes,
      requestedScopes: token.requestedScopes,
      scopeSource: token.scopeSource,
      scopeObservedAt: new Date(),
      tokenExpiresAt: token.tokenExpiresAt,
      status: 'active',
    })
  }
  try {
    const health: any = await connectorHealth({ organizationId: consumed.organizationId, provider, connectionId: String(row._id) })
    if (health?.account?.id && !row.externalAccountId) row.externalAccountId = String(health.account.id)
    row.status = health?.ok ? 'active' : 'degraded'
    if (health?.ok) row.lastHealthyAt = new Date()
    await row.save()
  } catch (error: any) {
    row.status = 'degraded'
    row.lastError = String(error?.message || 'Initial health check failed').slice(0, 1_000)
    await row.save()
  }
  await recordAudit({
    action: consumed.connectionId ? 'connection.oauth_reauthorized' : 'connection.oauth_completed', organizationId: consumed.organizationId, actorUserId: consumed.userId,
    entityType: 'PlatformConnection', entityId: String(row._id), metadata: { provider },
  })
  await queueConnectionScan({ organizationId: consumed.organizationId, connectionId: String(row._id), provider, reason: consumed.connectionId ? 'reauthorization' : 'connection' })
  const redirect = new URL(consumed.redirectTo || '/settings/connections', env.APP_URL)
  redirect.searchParams.set('connection', String(row._id))
  redirect.searchParams.set('status', row.status)
  res.redirect(303, redirect.toString())
})

/**
 * Capability matrix for one connection, with the evidence behind each answer.
 * The UI renders this directly so an operator sees `unverified` rather than an
 * empty list, and knows which action closes the gap.
 */
router.get('/:id/capabilities', asyncHandler(async (req, res) => {
  const matrix = await connectionCapabilityMatrix(organizationId(req), connectionObjectId(req.params.id))
  if (!matrix) throw new HttpError(404, 'Connection not found', 'A connection with that identifier was not found in this organization')
  res.json(matrix)
}))

/**
 * Run a live, read-only probe and durably record the observation. This is the
 * only operator action that can move a capability to `available` when the
 * provider does not return an explicit scope grant, and it is how [V3] is
 * answered per connection with evidence rather than assumption.
 */
router.post('/:id/capabilities/:capability/probe', manage, requireIdempotency, asyncHandler(async (req, res) => {
  const capability = String(req.params.capability) as CapabilityKey
  if (!(CAPABILITIES as readonly string[]).includes(capability)) throw new HttpError(400, 'Unknown capability', 'The requested capability is not modelled')
  if (!isProbeable(capability)) throw new HttpError(422, 'Capability is not probeable', 'Only read-only capabilities can be probed; destructive capabilities are confirmed through live acceptance')
  const resolution = await runCapabilityProbe({
    organizationId: organizationId(req),
    connectionId: connectionObjectId(req.params.id),
    capability,
    userId: req.auth?.userId,
    correlationId: String(req.requestId || ''),
  })
  await recordAudit({ action: 'connection.capability_probed', req, entityType: 'PlatformConnection', entityId: String(req.params.id), metadata: { capability, state: resolution.state } })
  res.json(resolution)
}))

/** Connector release states, so the UI can label quarantined providers. */
router.get('/meta/release-states', asyncHandler(async (_req, res) => {
  res.json({ connectors: connectorReleaseSummary() })
}))

export default router
