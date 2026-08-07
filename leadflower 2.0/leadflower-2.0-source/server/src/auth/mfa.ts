import User from '../models/User'
import { hashOpaqueToken } from '../security/tokens'

/**
 * TOTP replay prevention.
 *
 * The previous implementation stored a single `mfaLastCodeHash`. That blocks
 * an immediate repeat but not the realistic attack: a user authenticates with
 * code A and then code B, and A remains replayable for the rest of its validity
 * window because it is no longer the value being compared against.
 *
 * A rolling ring of recently consumed codes closes that. Entries older than the
 * acceptance window are pruned on each use, so the ring stays small and a code
 * becomes reusable only once it could no longer be valid anyway.
 */

/** How long a consumed code stays in the ring. Covers the current step plus drift. */
export const TOTP_REPLAY_WINDOW_MS = 180_000
/** Hard ceiling so a hostile client cannot grow the document without bound. */
export const TOTP_RING_SIZE = 12

export function recoveryCodeHash(recoveryCode: string): string {
  return hashOpaqueToken(recoveryCode.trim().toUpperCase())
}

export async function consumeRecoveryCode(userId: string, recoveryCode: string): Promise<boolean> {
  const hash = recoveryCodeHash(recoveryCode)
  const result = await User.updateOne({ _id: userId, mfaRecoveryCodeHashes: hash }, {
    $pull: { mfaRecoveryCodeHashes: hash },
  })
  return result.modifiedCount === 1
}

export interface UsedTotpCode { hash: string; usedAt: Date }

/** Drop entries that have aged out of the replay window. */
export function pruneUsedCodes(ring: UsedTotpCode[], now = Date.now(), windowMs = TOTP_REPLAY_WINDOW_MS): UsedTotpCode[] {
  return (ring || [])
    .filter((entry) => entry && entry.hash && now - new Date(entry.usedAt).getTime() < windowMs)
    .slice(-TOTP_RING_SIZE)
}

export function ringContains(ring: UsedTotpCode[], hash: string, now = Date.now(), windowMs = TOTP_REPLAY_WINDOW_MS): boolean {
  return pruneUsedCodes(ring, now, windowMs).some((entry) => entry.hash === hash)
}

/**
 * Consume a TOTP code exactly once.
 *
 * The update is conditional on the hash being absent from the ring, so two
 * concurrent requests presenting the same code cannot both succeed: MongoDB
 * applies the filter atomically and exactly one write matches.
 */
export async function consumeTotpCode(userId: string, code: string, now = Date.now()): Promise<boolean> {
  const hash = hashOpaqueToken(`totp:${code}`)
  const cutoff = new Date(now - TOTP_REPLAY_WINDOW_MS)

  const result = await User.updateOne(
    {
      _id: userId,
      // No unexpired entry in the ring may carry this hash.
      mfaUsedCodes: { $not: { $elemMatch: { hash, usedAt: { $gt: cutoff } } } },
    },
    {
      $push: {
        mfaUsedCodes: {
          $each: [{ hash, usedAt: new Date(now) }],
          $slice: -TOTP_RING_SIZE,
        },
      },
      $set: { mfaLastCodeHash: hash, mfaLastCodeUsedAt: new Date(now) },
    },
  )
  return result.modifiedCount === 1
}
