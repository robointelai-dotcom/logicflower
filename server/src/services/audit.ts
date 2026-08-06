import { Request } from 'express'
import AuditEvent from '../models/AuditEvent'
import pino from '../logger'

const SECRET_KEY_PATTERN = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential/i

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[MAX_DEPTH]'
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitize(item, depth + 1),
    ]))
  }
  if (typeof value === 'string') return value.slice(0, 2_000)
  return value
}

export async function recordAudit(input: {
  action: string
  req?: Request
  organizationId?: string
  actorUserId?: string
  actorType?: 'user' | 'system' | 'webhook'
  entityType?: string
  entityId?: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  try {
    await AuditEvent.create({
      organizationId: input.organizationId || input.req?.auth?.organizationId,
      actorUserId: input.actorUserId || input.req?.auth?.userId,
      actorType: input.actorType || (input.req?.auth?.userId ? 'user' : 'system'),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      ipAddress: input.req?.ip || input.req?.socket.remoteAddress,
      userAgent: String(input.req?.headers['user-agent'] || '').slice(0, 512) || undefined,
      requestId: input.req?.requestId,
      metadata: sanitize(input.metadata || {}),
    })
  } catch (error) {
    // Audit storage failure must trigger an operational incident without turning a
    // successfully committed customer mutation into a misleading HTTP failure.
    pino.error({ err: error, action: input.action, requestId: input.req?.requestId }, 'audit event persistence failed')
  }
}
