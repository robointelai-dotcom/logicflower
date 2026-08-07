import {
  PlatformUnavailableError,
  canPublish,
  platformProfile,
  type SocialPlatform,
} from './platforms'

/**
 * Composing and publishing.
 *
 * The composer is real and complete: validation, per-platform overrides,
 * scheduling. The publisher is an interface whose every implementation refuses,
 * following the `contact.merge` precedent in `services/dedupe/mergeExecutor.ts`.
 *
 * That split is the honest shape of this phase. An operator can plan a month of
 * content, see exactly what will go where, and schedule it — and the system
 * tells them plainly that nothing will leave until app review is granted. The
 * alternative, writing publish calls from memory against six platforms,
 * produces something that looks finished and posts the wrong thing to a
 * customer's public profile.
 */

export interface PostTargetInput {
  socialAccountId: string
  platform: SocialPlatform
  captionOverride?: string | null
}

export interface ComposedPost {
  caption: string
  mediaCount: number
  targets: PostTargetInput[]
  scheduledFor: Date | null
  timeZone: string
}

export const MAX_TARGETS_PER_POST = 12
export const MAX_MEDIA_ITEMS = 10
/** Beyond this a scheduled date is almost always a mistyped year. */
export const MAX_SCHEDULE_HORIZON_DAYS = 365

export class ComposerError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join('; '))
    this.name = 'ComposerError'
    this.issues = issues
  }
}

/** The caption a given target will actually publish. */
export function effectiveCaption(post: { caption: string }, target: PostTargetInput): string {
  const override = target.captionOverride
  return override !== null && override !== undefined && String(override).trim() ? String(override) : post.caption
}

/**
 * Validate a composed post against every target's constraints.
 *
 * Per target, not per post, because the constraints differ and a post that is
 * valid for LinkedIn may be impossible on Instagram. Every issue is collected
 * rather than failing on the first, so an operator fixes one thing once instead
 * of discovering problems one at a time.
 *
 * These are the composer's guardrails. They are not a promise that a platform
 * will accept the post — the platform decides that, and none of these
 * integrations are verified.
 */
export function validateComposedPost(input: {
  caption: string
  mediaCount: number
  targets: PostTargetInput[]
  scheduledFor?: Date | string | null
  timeZone?: string
}): ComposedPost {
  const issues: string[] = []
  const caption = String(input.caption ?? '')
  const mediaCount = Number(input.mediaCount ?? 0)
  const targets = Array.isArray(input.targets) ? input.targets : []

  if (!targets.length) issues.push('targets: a post needs at least one destination')
  if (targets.length > MAX_TARGETS_PER_POST) issues.push(`targets: cannot exceed ${MAX_TARGETS_PER_POST}`)
  if (!Number.isInteger(mediaCount) || mediaCount < 0) issues.push('media: count must be a whole number')
  if (mediaCount > MAX_MEDIA_ITEMS) issues.push(`media: cannot exceed ${MAX_MEDIA_ITEMS} items`)
  if (!caption.trim() && mediaCount === 0) issues.push('post: needs a caption, media, or both')

  const seen = new Set<string>()
  for (const target of targets) {
    const accountId = String(target?.socialAccountId || '')
    if (!accountId) { issues.push('targets: every destination needs an account'); continue }
    if (seen.has(accountId)) issues.push(`targets: account ${accountId} appears more than once`)
    seen.add(accountId)

    let profile
    try { profile = platformProfile(target.platform) } catch {
      issues.push(`targets: "${target.platform}" is not a supported platform`)
      continue
    }

    const text = effectiveCaption({ caption }, target)
    if (text.length > profile.maxCaptionLength) {
      issues.push(`${profile.displayName}: caption is ${text.length} characters, limit is ${profile.maxCaptionLength}`)
    }
    if (profile.mediaRequired && mediaCount === 0) {
      // Instagram and TikTok have no text-only post. Letting one be scheduled
      // produces a post that cannot publish, discovered at publish time.
      issues.push(`${profile.displayName}: requires at least one image or video`)
    }
    if (mediaCount > profile.maxMediaItems) {
      issues.push(`${profile.displayName}: accepts at most ${profile.maxMediaItems} media item(s), this post has ${mediaCount}`)
    }
  }

  let scheduledFor: Date | null = null
  if (input.scheduledFor) {
    scheduledFor = input.scheduledFor instanceof Date ? input.scheduledFor : new Date(String(input.scheduledFor))
    if (Number.isNaN(scheduledFor.getTime())) issues.push('scheduledFor: is not a valid date')
    else if (scheduledFor.getTime() > Date.now() + MAX_SCHEDULE_HORIZON_DAYS * 86_400_000) {
      issues.push(`scheduledFor: cannot be more than ${MAX_SCHEDULE_HORIZON_DAYS} days ahead`)
    }
  }

  if (issues.length) throw new ComposerError(issues)

  return {
    caption,
    mediaCount,
    targets: targets.map((target) => ({
      socialAccountId: String(target.socialAccountId),
      platform: target.platform,
      captionOverride: target.captionOverride ? String(target.captionOverride) : null,
    })),
    scheduledFor,
    timeZone: String(input.timeZone || 'UTC'),
  }
}

export interface PublishRequest {
  organizationId: string
  socialPostId: string
  platform: SocialPlatform
  socialAccountId: string
  caption: string
  mediaArtifactIds: string[]
}

export interface PublishResult {
  externalPostId: string
  externalPostUrl?: string
}

export interface SocialPublisher {
  publish(request: PublishRequest): Promise<PublishResult>
}

/**
 * The publisher.
 *
 * Every platform refuses, and the refusal carries what is needed to change
 * that: which approval is outstanding and which documentation is required. It
 * is a structured, actionable "not yet" rather than a generic failure, so an
 * operator looking at a blocked post sees the reason rather than an error code.
 *
 * When a platform IS approved and its contract verified, the change is: set
 * `publishState` in `platforms.ts`, and add a real implementation here. Nothing
 * else in the composer, scheduler or calendar changes — which is the point of
 * having built them against this interface.
 */
export class UnimplementedSocialPublisher implements SocialPublisher {
  async publish(request: PublishRequest): Promise<PublishResult> {
    if (!canPublish(request.platform)) throw new PlatformUnavailableError(request.platform)
    // Unreachable while every platform is `unimplemented`. Kept as an explicit
    // guard so that flipping a platform's state without writing an
    // implementation fails loudly here rather than silently succeeding.
    throw new Error(`Platform ${request.platform} is marked publishable but has no implementation`)
  }
}

export const socialPublisher: SocialPublisher = new UnimplementedSocialPublisher()

/** Publishing readiness for a set of targets, for display before scheduling. */
export function publishReadiness(targets: PostTargetInput[]) {
  return targets.map((target) => {
    const profile = platformProfile(target.platform)
    return {
      socialAccountId: target.socialAccountId,
      platform: target.platform,
      displayName: profile.displayName,
      publishState: profile.publishState,
      willPublish: profile.publishState === 'available',
      blockedReason: profile.publishState === 'available' ? null : profile.approvalRequired,
      documentationNeeded: profile.publishState === 'available' ? null : profile.documentationNeeded,
    }
  })
}
