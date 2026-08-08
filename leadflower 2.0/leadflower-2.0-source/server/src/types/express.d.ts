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
        /**
         * How this request came to be acting in `organizationId`. `membership`
         * for a direct member; `agency`, `corporate` or `support_grant` when
         * the authority came from elsewhere. Recorded on every audit entry so
         * "who opened this workspace, and by what right" has an answer.
         */
        accessVia?: 'membership' | 'agency' | 'support_grant' | 'corporate'
        /** When a time-limited grant lapses, for grants that have one. */
        accessExpiresAt?: Date | null
      }
      requestId?: string
      idempotencyKey?: string
      rawBody?: Buffer
      uploadHash?: string
    }
  }
}

export {}
