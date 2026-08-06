import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import mongoose from 'mongoose'
import { env, corsOrigins } from './env'
import pino from './logger'
import { requestId } from './middleware/requestId'
import { authenticate } from './middleware/authenticate'
import { csrfProtection } from './middleware/csrf'
import { requireOrganization, requireRole } from './middleware/rbac'
import { errorHandler, HttpError, sendProblem } from './http/problem'
import { redis } from './services/redisClient'

import authRoutes from './routes/auth'
import organizationRoutes from './routes/organizations'
import connectionRoutes, { oauthCallback } from './routes/connections'
import billingRoutes, { stripeWebhook } from './routes/billing'
import usageRoutes from './routes/usage'
import adminRoutes from './routes/admin'
import workflowRoutes from './routes/workflows'
import executionRoutes from './routes/executions'
import batchRoutes from './routes/batches'
import monitoringRoutes from './routes/monitoring'
import notificationRoutes from './routes/notifications'
import reportRoutes from './routes/reports'
import vaultRoutes from './routes/vault'
import artifactRoutes from './routes/artifacts'
import webhookRoutes, { rawWebhookBodyContract } from './routes/webhooks'
import aiConsentRoutes from './routes/aiConsents'
import { tenantRateLimit } from './middleware/tenantRateLimit'
import { requireIdempotency } from './middleware/idempotency'
import { deploymentWatchDecision } from './services/watchMode'
import { keyringStatus } from './security/keyring'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const operationalViewer = requireRole('owner', 'admin', 'operator', 'viewer')
const operationalOperator = requireRole('owner', 'admin', 'operator')
const organizationManager = requireRole('owner', 'admin')
const idempotentMutation = mutationGate(requireIdempotency)

function mutationGate(guard: (req: Request, res: Response, next: NextFunction) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => SAFE_METHODS.has(req.method) ? next() : guard(req, res, next)
}

function exactCorsOrigin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void): void {
  if (!origin || corsOrigins.includes(origin)) return callback(null, true)
  callback(new HttpError(403, 'Origin rejected', 'The request origin is not allowed'))
}

function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint()
  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
    pino.info({ requestId: (req as any).requestId, method: req.method, path: req.path, statusCode: res.statusCode, durationMs }, 'request completed')
  })
  next()
}

function webhookAccess(req: Request, res: Response, next: NextFunction): void {
  const publicIngress = req.method === 'POST' && (req.path.startsWith('/inbound/') || req.path.startsWith('/provider/'))
  if (publicIngress) return next()
  authenticate(req, res, (authError?: unknown) => {
    if (authError) return next(authError)
    csrfProtection(req, res, (csrfError?: unknown) => {
      if (csrfError) return next(csrfError)
      requireOrganization(req, res, next)
    })
  })
}

function mountApi(app: express.Express, prefix: '/api/v1' | '/api'): void {
  app.use(`${prefix}/auth`, authRoutes)

  app.get(`${prefix}/connections/:provider/oauth/callback`, oauthCallback)

  app.use(`${prefix}/organizations`, authenticate, tenantRateLimit, csrfProtection, idempotentMutation, organizationRoutes)
  app.use(`${prefix}/admin`, authenticate, tenantRateLimit, csrfProtection, idempotentMutation, adminRoutes)

  app.use(`${prefix}/connections`, authenticate, csrfProtection, requireOrganization, tenantRateLimit, idempotentMutation, operationalViewer, connectionRoutes)
  app.use(`${prefix}/billing`, authenticate, csrfProtection, requireOrganization, tenantRateLimit, idempotentMutation, billingRoutes)
  app.use(`${prefix}/usage`, authenticate, csrfProtection, requireOrganization, tenantRateLimit, idempotentMutation, usageRoutes)
  app.use(`${prefix}/ai`, authenticate, csrfProtection, requireOrganization, tenantRateLimit, idempotentMutation, aiConsentRoutes)

  app.use(`${prefix}/workflows`, authenticate, csrfProtection, requireOrganization, tenantRateLimit, idempotentMutation, operationalViewer, mutationGate(operationalOperator), workflowRoutes)
  app.use(`${prefix}/executions`, authenticate, csrfProtection, requireOrganization, tenantRateLimit, idempotentMutation, operationalViewer, mutationGate(operationalOperator), executionRoutes)
  app.use(`${prefix}/batches`, authenticate, csrfProtection, requireOrganization, tenantRateLimit, operationalViewer, mutationGate(operationalOperator), batchRoutes)
  app.use(`${prefix}/monitoring`, authenticate, csrfProtection, requireOrganization, tenantRateLimit, idempotentMutation, operationalViewer, mutationGate(operationalOperator), monitoringRoutes)
  app.use(`${prefix}/notifications`, authenticate, csrfProtection, requireOrganization, tenantRateLimit, idempotentMutation, operationalViewer, mutationGate(organizationManager), notificationRoutes)
  app.use(`${prefix}/reports`, authenticate, csrfProtection, requireOrganization, tenantRateLimit, idempotentMutation, requireRole('owner', 'admin', 'operator', 'viewer', 'billing'), mutationGate(operationalOperator), reportRoutes)
  app.use(`${prefix}/vault`, authenticate, csrfProtection, requireOrganization, tenantRateLimit, idempotentMutation, operationalViewer, mutationGate(operationalOperator), vaultRoutes)
  app.use(`${prefix}/artifacts`, authenticate, csrfProtection, requireOrganization, tenantRateLimit, operationalViewer, artifactRoutes)
  app.use(`${prefix}/webhooks`, webhookAccess, webhookRoutes)
}

export function createApp(): express.Express {
  const app = express()
  app.disable('x-powered-by')
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY)

  app.use(requestId)
  app.use(requestLogger)
  // Explicit header policy rather than helmet defaults.
  //
  // The API returns JSON and never renders HTML, so the CSP below is
  // deliberately close to "deny everything": there is no legitimate reason for
  // a response from this origin to load a script, embed a frame, or be framed.
  // Locking it here means an XSS introduced through a future error page or
  // documentation route has nothing to execute with.
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'same-site' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'none'"],
        connectSrc: ["'self'"],
        imgSrc: ["'none'"],
        styleSrc: ["'none'"],
        upgradeInsecureRequests: env.COOKIE_SECURE ? [] : null,
      },
    },
    // HSTS is only meaningful over TLS, and asserting it from a plaintext dev
    // server would pin developers' browsers to https://localhost.
    hsts: env.COOKIE_SECURE
      ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
      : false,
  }))
  app.use((_req, res, next) => {
    // Not covered by helmet. Prevents a browser or intermediary from caching an
    // authenticated JSON response into shared storage.
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()')
    next()
  })
  app.use(cors({ origin: exactCorsOrigin, credentials: true, maxAge: 600 }))

  app.get('/healthz', (_req, res) => res.json({ ok: true }))
  app.get('/readyz', async (_req, res) => {
    const mongoReady = mongoose.connection.readyState === 1
    let redisReady = false
    try { redisReady = await redis.ping() === 'PONG' } catch { redisReady = false }
    const watch = deploymentWatchDecision()
    res.status(mongoReady && redisReady ? 200 : 503).json({
      ready: mongoReady && redisReady,
      dependencies: { mongo: mongoReady, redis: redisReady },
      // Which product mode is live, so an operator never has to guess whether
      // workflow monitoring is running.
      mode: { watch: watch.mode, workflowMonitoringEnabled: watch.workflowMonitoringEnabled },
      encryption: keyringStatus(),
    })
  })

  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.path === '/healthz' || req.path === '/readyz',
  })
  app.use('/api', apiLimiter)

  // Stripe requires its exact raw request bytes. These mounts must precede all
  // JSON parsing and are intentionally the only public billing endpoints.
  app.post('/api/v1/billing/webhook', express.raw({ type: 'application/json', limit: '2mb' }), stripeWebhook)
  app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '2mb' }), stripeWebhook)

  app.use(express.json({
    limit: '2mb',
    strict: true,
    verify: rawWebhookBodyContract.verify,
  }))
  app.use(express.urlencoded({
    extended: false,
    limit: '64kb',
    verify: rawWebhookBodyContract.verify,
  }))

  mountApi(app, '/api/v1')
  mountApi(app, '/api')

  app.use((req, res) => sendProblem(req, res, { status: 404, title: 'Not found', detail: 'The requested endpoint does not exist' }))
  app.use(errorHandler)
  return app
}
