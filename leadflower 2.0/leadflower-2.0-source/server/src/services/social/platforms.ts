/**
 * Social publishing platforms, and what is actually known about each.
 *
 * Every platform in this file is `unimplemented`. That is not an oversight and
 * it is not a placeholder to be filled in later by inference — it is the
 * specification's instruction applied literally:
 *
 *   "Gate every platform behind the capability system. Each requires separate
 *    app review, and any may be refused."
 *
 * Two things follow. First, no publish call is written against a contract that
 * has not been verified against a live, approved app. Meta, TikTok, Pinterest,
 * LinkedIn and Google Business Profile each differ, each changes, and a wrong
 * implementation against a social API does not fail cleanly — it posts the
 * wrong thing to a customer's public profile, or gets their app suspended.
 *
 * Second, and more important commercially: **an approval that has not been
 * granted is not a capability.** Several of these reviews take months and some
 * are refused outright. Google Business Profile API access in particular has
 * historically been restricted and is not granted automatically. Building a
 * publish path that assumes approval produces a product that appears finished
 * and cannot post.
 *
 * The constraints recorded below (character limits, media counts) are used for
 * composer-side validation only. They are the operator's guardrails, not a
 * claim that the platform will accept a post — the platform decides that, and
 * this system does not pretend otherwise.
 */

export const SOCIAL_PLATFORMS = [
  'facebook_page', 'instagram_business', 'linkedin_page', 'tiktok', 'pinterest', 'google_business_profile',
] as const
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]

export type PublishCapabilityState = 'unimplemented' | 'unverified' | 'available'

export interface PlatformProfile {
  platform: SocialPlatform
  displayName: string
  /**
   * Publishing state. `unimplemented` means no publish call exists. It never
   * resolves to `available` without a recorded live probe against an approved
   * app, following the same rule as `services/capability/capabilityModel.ts`:
   * absence of evidence is never availability.
   */
  publishState: PublishCapabilityState
  /** Maximum caption length the composer will accept. */
  maxCaptionLength: number
  /** Maximum media items per post. */
  maxMediaItems: number
  supportsVideo: boolean
  /** True where the platform requires at least one media item. */
  mediaRequired: boolean
  /** What must be obtained before this platform can be implemented. */
  approvalRequired: string
  /** Specific documentation needed to write the publish call. */
  documentationNeeded: string
  /**
   * Published rate ceiling, where one is known. Advisory: it informs composer
   * warnings and scheduling density, and is never treated as authoritative.
   */
  rateLimitNote?: string
  /**
   * Provenance of the constraint data above.
   *
   * `secondary` means it came from an industry write-up rather than the
   * platform's own documentation. Useful for planning, not sufficient for
   * implementation, and it must be re-checked against the official reference
   * before any publish call is written against it. The distinction is recorded
   * rather than glossed because a plausible-but-stale constraint is exactly the
   * kind of thing that gets treated as verified once it has sat in a codebase
   * for a few months.
   */
  constraintSource: 'secondary' | 'official' | 'live_probe'
  /** Notable recent changes an implementer needs to know about. */
  recentChanges?: string
}

const PROFILES: Readonly<Record<SocialPlatform, PlatformProfile>> = Object.freeze({
  facebook_page: {
    platform: 'facebook_page',
    displayName: 'Facebook Page',
    publishState: 'unimplemented',
    maxCaptionLength: 63_206,
    maxMediaItems: 10,
    supportsVideo: true,
    mediaRequired: false,
    approvalRequired: 'Meta App Review with pages_manage_posts, plus Business Verification. Weeks to months.',
    documentationNeeded: 'Current Graph API version, the Page publishing endpoint and its media upload flow, and the current permission names — these have been renamed more than once.',
    rateLimitNote: 'Governed by Meta\'s Business Use Case rate limits, layered over app-level and page-level caps and scaled by app usage history. A brand-new app gets a low ceiling, which matters most during onboarding.',
    recentChanges: 'Publishing is PAGES ONLY. Personal profile publishing was removed from the Graph API and is not returning — any product design assuming it will not work.',
    constraintSource: 'secondary',
  },
  instagram_business: {
    platform: 'instagram_business',
    displayName: 'Instagram Business',
    publishState: 'unimplemented',
    maxCaptionLength: 2_200,
    maxMediaItems: 10,
    supportsVideo: true,
    // Instagram has no text-only post. A composer that lets one be scheduled
    // produces a post that cannot publish, discovered at publish time.
    mediaRequired: true,
    approvalRequired: 'Meta App Review with instagram_content_publish and pages_show_list, a linked Business or Creator account, plus Business Verification. Weeks to months.',
    documentationNeeded: 'Current Content Publishing API: the two-step container-then-publish flow, the exact media container parameters, and the current carousel, Reels and Stories constraints.',
    rateLimitNote: 'Approximately 100 API-published posts per account per rolling 24 hours, with a carousel counting as one post. The published count is queryable per account before queueing a batch.',
    recentChanges: 'Instagram Basic Display API was sunset in December 2024. Personal account access is gone entirely; everything routes through the Graph API with a Business or Creator account.',
    constraintSource: 'secondary',
  },
  linkedin_page: {
    platform: 'linkedin_page',
    displayName: 'LinkedIn Page',
    publishState: 'unimplemented',
    maxCaptionLength: 3_000,
    maxMediaItems: 9,
    supportsVideo: true,
    mediaRequired: false,
    approvalRequired: 'LinkedIn Marketing Developer Platform access, then the Community Management API specifically — that is the product that permits posting to organisation pages. Reported to have the highest approval bar of any platform here, and may be refused.',
    documentationNeeded: 'Current Posts API contract, the organisation URN format, and the asset registration and upload flow.',
    rateLimitNote: 'Community Management development tier defaults to roughly 500 requests per app and 100 per member daily, resetting at midnight UTC — enough to build and test against, not to operate. Production quota is negotiated with a LinkedIn partner manager rather than self-served.',
    recentChanges: 'Development-tier quotas are now published explicitly rather than discovered by hitting them.',
    constraintSource: 'secondary',
  },
  tiktok: {
    platform: 'tiktok',
    displayName: 'TikTok',
    publishState: 'unimplemented',
    maxCaptionLength: 2_200,
    maxMediaItems: 1,
    supportsVideo: true,
    mediaRequired: true,
    approvalRequired: 'TikTok for Developers app review with Content Posting API access. A separate audit applies to unaudited direct posting; may be refused.',
    documentationNeeded: 'Current Content Posting API, whether direct post or upload-to-inbox is granted, and the audit requirements attached to each. The distinction matters to the product: upload-to-inbox requires the account holder to finish the post manually in the app, which is a materially different user experience from scheduled publishing.',
    constraintSource: 'secondary',
  },
  pinterest: {
    platform: 'pinterest',
    displayName: 'Pinterest',
    publishState: 'unimplemented',
    maxCaptionLength: 800,
    maxMediaItems: 1,
    supportsVideo: true,
    mediaRequired: true,
    approvalRequired: 'Pinterest developer app review with write access, moving from Trial to Standard tier. Weeks.',
    documentationNeeded: 'Current Pins API create contract and the board identifier format.',
    rateLimitNote: 'Per-category rate limits are now published. Trial tier is materially more restricted than Standard, so early testing will not predict production throughput.',
    constraintSource: 'secondary',
  },
  google_business_profile: {
    platform: 'google_business_profile',
    displayName: 'Google Business Profile',
    publishState: 'unimplemented',
    maxCaptionLength: 1_500,
    maxMediaItems: 1,
    supportsVideo: false,
    mediaRequired: false,
    approvalRequired: 'Google Business Profile API access request. HISTORICALLY RESTRICTED and not granted automatically — this may be refused, and the product must work without it.',
    documentationNeeded: 'Confirmation that API access has been granted at all, then the current Local Post contract including CTA button types, the media endpoint, the Q&A surface and the holiday-hours representation. This surface has changed repeatedly and must not be written from memory.',
    constraintSource: 'secondary',
  },
})

export function platformProfile(platform: SocialPlatform): PlatformProfile {
  const profile = PROFILES[platform]
  if (!profile) throw new Error(`Unknown social platform: ${platform}`)
  return profile
}

export function listPlatformProfiles(): PlatformProfile[] {
  return SOCIAL_PLATFORMS.map((platform) => PROFILES[platform])
}

/** Is this platform publishable right now? Currently: none of them. */
export function canPublish(platform: SocialPlatform): boolean {
  return platformProfile(platform).publishState === 'available'
}

export class PlatformUnavailableError extends Error {
  readonly platform: SocialPlatform
  readonly state: PublishCapabilityState
  readonly approvalRequired: string
  readonly documentationNeeded: string
  constructor(platform: SocialPlatform) {
    const profile = platformProfile(platform)
    super(
      `Publishing to ${profile.displayName} is not implemented. ${profile.approvalRequired} `
      + 'A post can be composed, scheduled and reviewed, but it will not be published until access is granted and the integration is built against verified documentation.',
    )
    this.name = 'PlatformUnavailableError'
    this.platform = platform
    this.state = profile.publishState
    this.approvalRequired = profile.approvalRequired
    this.documentationNeeded = profile.documentationNeeded
  }
}
