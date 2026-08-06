import jwt, { JwtPayload } from 'jsonwebtoken'
import { env } from '../env'

const ISSUER = 'logicflower-api'
const AUDIENCE = 'logicflower-web'

export interface AccessTokenClaims extends JwtPayload {
  sub: string
  sid: string
  org?: string
  type: 'access'
}

export function signAccessToken(input: { userId: string; sessionId: string; organizationId?: string }): string {
  return jwt.sign(
    { sid: input.sessionId, org: input.organizationId, type: 'access' },
    env.JWT_ACCESS_SECRET,
    {
      algorithm: 'HS256',
      subject: input.userId,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    },
  )
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const claims = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  }) as AccessTokenClaims
  if (claims.type !== 'access' || !claims.sub || !claims.sid) throw new Error('Invalid access token')
  return claims
}
