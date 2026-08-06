import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { redis } from '../services/redisClient';
import { sendProblem, problemType} from '../http/problem';

const WINDOW_MS = 60_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

function endpoint(req: Request) {
  const normalized = `${req.baseUrl}${req.path}`
    .replace(/[0-9a-f]{24}/gi, ':id')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
  return crypto.createHash('sha256').update(`${req.method}:${normalized}`).digest('hex').slice(0, 24);
}

export async function tenantRateLimit(req: Request, res: Response, next: NextFunction) {
  const safe = SAFE_METHODS.has(req.method);
  const limit = safe ? 300 : 120;
  const scope = req.auth?.organizationId ? `org:${req.auth.organizationId}` : `user:${req.auth?.userId || req.ip}`;
  const bucket = Math.floor(Date.now() / WINDOW_MS);
  const key = `lf:rate:${scope}:${endpoint(req)}:${bucket}`;
  try {
    const result = await redis.eval(LUA, 1, key, WINDOW_MS) as [number, number];
    const count = Number(result[0]); const ttl = Math.max(1, Number(result[1]));
    const remaining = Math.max(0, limit - count); const resetSeconds = Math.max(1, Math.ceil(ttl / 1_000));
    res.setHeader('RateLimit-Limit', String(limit)); res.setHeader('RateLimit-Remaining', String(remaining)); res.setHeader('RateLimit-Reset', String(resetSeconds));
    if (count > limit) {
      res.setHeader('Retry-After', String(resetSeconds));
      sendProblem(req, res, { status: 429, title: 'Rate limit exceeded', detail: 'This organization exceeded the per-endpoint request limit. Retry after the indicated delay.', type: problemType('rate-limit'), retryable: true });
      return;
    }
    next();
  } catch {
    if (safe) { next(); return; }
    sendProblem(req, res, { status: 503, title: 'Request safety service unavailable', detail: 'Mutation rate enforcement is temporarily unavailable. No mutation was performed.', type: problemType('rate-limit-unavailable'), retryable: true });
  }
}
