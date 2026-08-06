import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const supplied = `${req.headers['x-request-id'] || ''}`;
  (req as any).requestId = SAFE_REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
  res.setHeader('X-Request-Id', (req as any).requestId);
  next()
}
