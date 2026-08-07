import { NextFunction, Request, Response } from 'express'
import { ZodError, ZodType } from 'zod'
import pino from '../logger'
import { env } from '../env'

/**
 * Problem type URIs form part of the public API contract: once a client
 * switches on `type`, changing the string is a breaking change. Binding them to
 * a domain before that domain and mark are cleared ([V43], [V44]) commits the
 * brand into the contract and makes a later rename an API break.
 *
 * The default is a URN, which is a permanent identifier that resolves to
 * nothing and asserts ownership of no domain. Deployments that have completed
 * clearance may set PROBLEM_TYPE_BASE_URI to an HTTPS namespace serving human
 * documentation, without altering any call site.
 */
export function problemType(slug: string): string {
  const safe = String(slug).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!safe) return env.PROBLEM_TYPE_BASE_URI
  const base = env.PROBLEM_TYPE_BASE_URI
  return base.startsWith('urn:') ? `${base}:${safe}` : `${base.replace(/\/+$/, '')}/${safe}`
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public title: string,
    public detail: string,
    public type = 'about:blank',
    public retryable = false,
  ) {
    super(detail)
  }
}

export function sendProblem(req: Request, res: Response, input: {
  status: number
  title: string
  detail: string
  type?: string
  retryable?: boolean
}): void {
  res.status(input.status).type('application/problem+json').json({
    type: input.type || 'about:blank',
    title: input.title,
    status: input.status,
    detail: input.detail,
    correlationId: (req as any).requestId || 'unknown',
    retryable: input.retryable || false,
  })
}

export function parseBody<T>(schema: ZodType<T>, req: Request): T {
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')
    throw new HttpError(400, 'Invalid request', detail, problemType('validation'))
  }
  return parsed.data
}

export function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    _next(error)
    return
  }
  if (error instanceof HttpError) {
    sendProblem(req, res, error)
    return
  }
  if (error instanceof ZodError) {
    sendProblem(req, res, {
      status: 400,
      title: 'Invalid request',
      detail: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      type: problemType('validation'),
    })
    return
  }
  const candidate = error as { code?: number | string; message?: string; status?: number; statusCode?: number; type?: string; name?: string }
  if (candidate?.type === 'entity.parse.failed') {
    sendProblem(req, res, { status: 400, title: 'Invalid JSON', detail: 'The request body is not valid JSON' })
    return
  }
  if (candidate?.type === 'entity.too.large') {
    sendProblem(req, res, { status: 413, title: 'Request too large', detail: 'The request body exceeds the allowed size' })
    return
  }
  if (candidate?.name === 'CastError' || candidate?.name === 'ValidationError') {
    sendProblem(req, res, { status: 400, title: 'Invalid request', detail: 'A supplied identifier or value is invalid' })
    return
  }
  if (candidate?.code === 11000) {
    sendProblem(req, res, { status: 409, title: 'Conflict', detail: 'A record with those unique fields already exists' })
    return
  }
  const explicitStatus = Number(candidate?.statusCode || candidate?.status || 0)
  if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus < 500) {
    sendProblem(req, res, {
      status: explicitStatus,
      title: explicitStatus === 404 ? 'Not found' : explicitStatus === 401 ? 'Authentication required' : 'Request rejected',
      detail: String(candidate.message || 'The request was rejected').slice(0, 1_000),
    })
    return
  }
  pino.error({ err: error, requestId: (req as any).requestId }, 'unhandled request error')
  sendProblem(req, res, {
    status: 500,
    title: 'Internal server error',
    detail: 'The request could not be completed',
    type: problemType('internal'),
    retryable: true,
  })
}
