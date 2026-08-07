import type { MembershipRole } from '../models/Membership'

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string
        sessionId: string
        organizationId?: string
        role?: MembershipRole
        platformRole: 'user' | 'support' | 'admin' | 'owner'
        mfaEnabled: boolean
      }
      requestId?: string
      idempotencyKey?: string
      rawBody?: Buffer
      uploadHash?: string
    }
  }
}

export {}
