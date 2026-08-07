import SocialAccount from '../../models/SocialAccount'
import SocialPost from '../../models/SocialPost'
import Organization from '../../models/Organization'
import { decryptString, encryptString } from '../../security/encryption'
import { HttpError, problemType } from '../../http/problem'
import pino from '../../logger'
import { recordAudit } from '../audit'
import { recordActivity } from '../crm/contactActivity'
import {
  createPost,
  fetchPost,
  listSocialAccounts,
  mapPlatformStatus,
  trypostConfigured,
  TrypostUnavailableError,
} from './trypostClient'
import type { PublishRequest, PublishResult, SocialPublisher } from './composer'
import { PlatformUnavailableError, type SocialPlatform } from './platforms'

/**
 * Publishing through a self-hosted trypost instance.
 *
 * Drops into the `SocialPublisher` interface built in Phase 4 with no change to
 * the composer, the scheduler, the calendar or the media pipeline. That was the
 * point of defining the interface before any provider existed.
 *
 * WHAT THIS DOES AND DOES NOT CHANGE
 *
 * It does not grant platform access. trypost uses the operator's own approved
 * apps — its configuration expects `FACEBOOK_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET`
 * and the rest to be supplied. **App review remains the binding constraint.**
 * This integration removes the need to write and maintain the platform
 * integrations; it does not remove the need to be approved to use them.
 *
 * Consequently a platform is reported as `unverified` when trypost is
 * configured, never `available`. Availability requires a live probe confirming
 * a connected, approved account — the same rule the connector capability model
 * applies. A configured backend is evidence that publishing is *possible*, not
 * that it *works*.
 */

export function workspaceKeyAad(organizationId: string): string {
  return `trypost-workspace:${organizationId}:api-key`
}

/**
 * Resolve an organisation's own workspace credential.
 *
 * Per organisation, encrypted, and never defaulted to the admin key. trypost
 * scopes API keys to a workspace, so using the wrong key is a cross-tenant
 * write — the single worst failure available in this integration.
 */
export async function resolveWorkspaceKey(organizationId: string): Promise<string> {
  const organization: any = await Organization.findOne({ _id: organizationId })
    .select('+socialBackend.workspaceKeyCiphertext socialBackend').lean()
  const ciphertext = organization?.socialBackend?.workspaceKeyCiphertext
  if (!ciphertext) {
    throw new HttpError(
      409,
      'Social workspace not provisioned',
      'This organisation has no social publishing workspace. Provision one before composing posts.',
      problemType('social-workspace-missing'),
    )
  }
  try {
    return decryptString(ciphertext, workspaceKeyAad(organizationId))
  } catch {
    // A ciphertext that will not open under its own AAD is corrupt or belongs
    // to another record. Both are refusals, never a fallback to the admin key.
    throw new HttpError(409, 'Social workspace credential unreadable', 'The stored publishing credential could not be decrypted.', problemType('social-workspace-unreadable'))
  }
}

/**
 * Store a workspace credential for an organisation.
 *
 * Provisioning the workspace itself is an operator action performed in trypost
 * — it has no admin API for workspace creation — and the resulting API key is
 * recorded here. That manual step is documented rather than automated away,
 * because pretending it is automatic would leave an operator wondering why
 * onboarding silently produced no workspace.
 */
export async function storeWorkspaceKey(input: { organizationId: string; apiKey: string; workspaceLabel?: string; userId?: string }): Promise<void> {
  await Organization.updateOne({ _id: input.organizationId }, {
    $set: {
      'socialBackend.provider': 'trypost',
      'socialBackend.workspaceLabel': String(input.workspaceLabel || '').slice(0, 200) || undefined,
      'socialBackend.workspaceKeyCiphertext': encryptString(input.apiKey, workspaceKeyAad(input.organizationId)),
      'socialBackend.linkedAt': new Date(),
    },
  })
  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    actorType: input.userId ? 'user' : 'system',
    action: 'social.workspace_linked',
    entityType: 'Organization',
    entityId: input.organizationId,
    // The key itself is deliberately absent from the audit metadata.
    metadata: { provider: 'trypost' },
  })
}

/**
 * Mirror the accounts connected in trypost into this system.
 *
 * A mirror, not a source of truth. trypost owns the OAuth tokens and the
 * connection state; this copy exists so the composer can list destinations
 * without a synchronous call, and it is refreshed rather than edited.
 */
export async function syncSocialAccounts(organizationId: string): Promise<{ synced: number }> {
  const apiKey = await resolveWorkspaceKey(organizationId)
  const accounts = await listSocialAccounts(apiKey)

  for (const account of accounts) {
    await SocialAccount.updateOne(
      { organizationId, platform: account.platform, externalAccountId: account.id },
      {
        $set: {
          displayName: account.name || account.platform,
          status: account.status === 'active' || account.status === 'connected' ? 'connected' : 'error',
          // Unverified, never available. A connected account is not proof that
          // a publish will succeed — app review may still be outstanding.
          publishState: 'unverified',
          lastProbeAt: new Date(),
          lastProbeDetail: `Mirrored from the publishing backend (status=${account.status})`,
        },
        $setOnInsert: { organizationId, platform: account.platform, externalAccountId: account.id },
      },
      { upsert: true },
    )
  }
  return { synced: accounts.length }
}

export class TrypostSocialPublisher implements SocialPublisher {
  async publish(request: PublishRequest): Promise<PublishResult> {
    if (!trypostConfigured()) {
      // Falls back to the Phase 4 behaviour: a structured, actionable refusal
      // naming the outstanding approval, rather than a generic error.
      throw new PlatformUnavailableError(request.platform as SocialPlatform)
    }

    const apiKey = await resolveWorkspaceKey(request.organizationId)
    const account: any = await SocialAccount.findOne({
      _id: request.socialAccountId,
      organizationId: request.organizationId,
    }).select('externalAccountId platform').lean()
    if (!account?.externalAccountId) {
      throw new HttpError(409, 'Account not linked', 'This destination has no linked account in the publishing backend.', problemType('social-account-not-linked'))
    }

    const post = await createPost(apiKey, {
      content: request.caption,
      socialAccountIds: [String(account.externalAccountId)],
      mediaUrls: [],
    })

    return { externalPostId: post.id, externalPostUrl: post.platforms?.[0]?.url || undefined }
  }
}

export const trypostSocialPublisher = new TrypostSocialPublisher()

/**
 * Reconcile publish status.
 *
 * trypost exposes no outbound webhook, so status is pulled. This runs as
 * recurring maintenance over posts that are still in flight, and it is the
 * mechanism by which a post ever leaves `publishing`.
 *
 * The unified timeline is assembled here: when a post publishes, an activity
 * record is written into THIS database against any contact the post referenced.
 * There is no shared database and no cross-system join; the single-platform
 * experience is composed in the application layer, and it is none the less real
 * for that.
 */
export async function reconcileSocialPosts(limit = 50): Promise<{ checked: number; updated: number }> {
  if (!trypostConfigured()) return { checked: 0, updated: 0 }

  // tenant-safe: cross-tenant reconciliation sweep; each post carries its own organisation and its credential is resolved from it
  const inFlight: any[] = await SocialPost.find({ status: { $in: ['scheduled', 'publishing'] } })
    .sort({ updatedAt: 1 })
    .limit(Math.max(1, Math.min(limit, 200)))
    .lean()

  let updated = 0
  for (const post of inFlight) {
    const organizationId = String(post.organizationId)
    const externalIds = (post.targets || []).map((target: any) => target.externalPostId).filter(Boolean)
    if (!externalIds.length) continue

    let apiKey: string
    try { apiKey = await resolveWorkspaceKey(organizationId) } catch { continue }

    try {
      const remote = await fetchPost(apiKey, String(externalIds[0]))
      if (!remote) continue

      const targets = (post.targets || []).map((target: any) => {
        const match = (remote.platforms || []).find((entry) => entry.platform === target.platform)
        if (!match) return target
        return {
          ...target,
          status: mapPlatformStatus(match.status),
          externalPostUrl: match.url || target.externalPostUrl,
          publishedAt: mapPlatformStatus(match.status) === 'published' ? (target.publishedAt || new Date()) : target.publishedAt,
          lastError: match.error ? { code: 'PLATFORM_REJECTED', message: String(match.error).slice(0, 500), at: new Date() } : target.lastError,
        }
      })

      const statuses = targets.map((target: any) => target.status)
      const overall = statuses.every((status: string) => status === 'published') ? 'completed'
        : statuses.every((status: string) => status === 'failed' || status === 'blocked') ? 'failed'
          : statuses.some((status: string) => status === 'published') && statuses.some((status: string) => status === 'failed') ? 'partially_failed'
            : 'publishing'

      if (overall !== post.status) {
        await SocialPost.updateOne({ _id: post._id, organizationId }, {
          $set: { targets, status: overall, ...(overall === 'completed' ? { publishedAt: new Date() } : {}) },
        })
        updated += 1

        if (overall === 'completed' && post.contactId) {
          await recordActivity({
            organizationId,
            contactId: String(post.contactId),
            type: 'social.published',
            summary: `Social post published to ${targets.map((target: any) => target.platform).join(', ')}`,
            entityType: 'SocialPost',
            entityId: String(post._id),
            metadata: { platforms: targets.length },
          })
        }
      }
    } catch (error) {
      if (error instanceof TrypostUnavailableError && error.retryable) continue
      pino.warn({ err: error, socialPostId: String(post._id) }, 'social post reconciliation failed')
    }
  }
  return { checked: inFlight.length, updated }
}
