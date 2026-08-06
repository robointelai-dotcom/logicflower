import { CookieOptions, Request, Response } from 'express'
import crypto from 'crypto'
import { env } from '../env'

export const ACCESS_COOKIE = 'lf_access'
export const REFRESH_COOKIE = 'lf_refresh'
export const CSRF_COOKIE = 'lf_csrf'

function cookieOptions(maxAge: number, path = '/'): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN,
    path,
    maxAge,
  }
}

export function setSessionCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(env.ACCESS_TOKEN_TTL_SECONDS * 1_000))
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(env.REFRESH_TOKEN_TTL_DAYS * 86_400_000, '/api'))
  setCsrfCookie(res)
}

export function setCsrfCookie(res: Response): string {
  const token = crypto.randomBytes(32).toString('base64url')
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN,
    path: '/',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  })
  return token
}

export function clearSessionCookies(res: Response): void {
  const base = { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax' as const, domain: env.COOKIE_DOMAIN }
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' })
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/api' })
  res.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false, path: '/' })
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const item of header.split(';')) {
    const separator = item.indexOf('=')
    if (separator < 0) continue
    const key = item.slice(0, separator).trim()
    if (key === name) return decodeURIComponent(item.slice(separator + 1).trim())
  }
  return undefined
}
