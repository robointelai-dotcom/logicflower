import { describe, expect, it } from 'vitest'
import { computeVariant, computeVariants, MediaError, suggestedRatios, targetFor } from '../src/services/social/mediaVariants'
import {
  ComposerError,
  effectiveCaption,
  publishReadiness,
  UnimplementedSocialPublisher,
  validateComposedPost,
} from '../src/services/social/composer'
import { canPublish, listPlatformProfiles, PlatformUnavailableError, platformProfile, SOCIAL_PLATFORMS } from '../src/services/social/platforms'
import { aggregateRatingJsonLd, renderWidgetHtml, safeAccentColor, widgetScript } from '../src/services/reviews/reviewWidget'

describe('media variant geometry', () => {
  const landscape = { width: 4_000, height: 3_000 }
  const portrait = { width: 1_080, height: 1_920 }

  it('crops a wide source to a square by taking a centred column', () => {
    const variant = computeVariant(landscape, '1:1', 'cover')
    expect(variant.targetWidth).toBe(1_080)
    expect(variant.sourceHeight).toBe(3_000)
    expect(variant.sourceWidth).toBe(3_000)
    // Centred: equal amounts discarded from each side.
    expect(variant.sourceX).toBe(500)
    expect(variant.sourceX + variant.sourceWidth).toBe(landscape.width - 500)
    expect(variant.cropped).toBe(true)
    expect(variant.padded).toBe(false)
  })

  it('crops a tall source to a wide frame by taking a centred band', () => {
    const variant = computeVariant(portrait, '16:9', 'cover')
    expect(variant.sourceWidth).toBe(1_080)
    expect(variant.sourceHeight).toBe(608)
    expect(variant.sourceY).toBe(Math.round((1_920 - 1_080 / (16 / 9)) / 2))
    expect(variant.cropped).toBe(true)
  })

  it('pads rather than crops under contain', () => {
    const variant = computeVariant(landscape, '1:1', 'contain')
    // The whole source is kept.
    expect(variant.sourceWidth).toBe(landscape.width)
    expect(variant.sourceHeight).toBe(landscape.height)
    expect(variant.padded).toBe(true)
    expect(variant.cropped).toBe(false)
    // Bars top and bottom, centred.
    expect(variant.destinationHeight).toBe(810)
    expect(variant.destinationY).toBe(135)
    expect(variant.destinationY * 2 + variant.destinationHeight).toBe(variant.targetHeight)
  })

  it('does nothing when the source already matches the ratio', () => {
    const variant = computeVariant({ width: 2_000, height: 2_000 }, '1:1', 'cover')
    expect(variant.cropped).toBe(false)
    expect(variant.padded).toBe(false)
    expect(variant.sourceX).toBe(0)
    expect(variant.sourceY).toBe(0)
  })

  it('flags an upscale rather than preventing it', () => {
    // The operator may knowingly accept a soft image; they should not discover
    // it after publishing.
    expect(computeVariant({ width: 400, height: 400 }, '1:1').upscaled).toBe(true)
    expect(computeVariant({ width: 3_000, height: 3_000 }, '1:1').upscaled).toBe(false)
  })

  it('rejects unusable source dimensions', () => {
    expect(() => computeVariant({ width: 0, height: 100 }, '1:1')).toThrow(MediaError)
    expect(() => computeVariant({ width: -10, height: 100 }, '1:1')).toThrow(/positive/)
    expect(() => computeVariant({ width: 10.5, height: 100 }, '1:1')).toThrow(/whole pixels/)
    expect(() => computeVariant({ width: Number.NaN, height: 100 }, '1:1')).toThrow(/numbers/)
    expect(() => targetFor('3:2' as any)).toThrow(/Unsupported aspect ratio/)
  })

  it('produces every requested ratio', () => {
    const variants = computeVariants(landscape, ['1:1', '9:16', '16:9'])
    expect(variants.map((variant) => variant.ratio)).toEqual(['1:1', '9:16', '16:9'])
    for (const variant of variants) {
      expect(variant.sourceWidth).toBeGreaterThan(0)
      expect(variant.sourceHeight).toBeGreaterThan(0)
      expect(variant.sourceX + variant.sourceWidth).toBeLessThanOrEqual(landscape.width)
      expect(variant.sourceY + variant.sourceHeight).toBeLessThanOrEqual(landscape.height)
    }
  })

  it('suggests ratios that suit each surface', () => {
    expect(suggestedRatios('tiktok')).toEqual(['9:16'])
    expect(suggestedRatios('linkedin_page')).toContain('16:9')
    expect(suggestedRatios('unknown')).toEqual(['1:1'])
  })
})

describe('platform capability gating', () => {
  it('reports every platform as unimplemented', () => {
    // An approval that has not been granted is not a capability. If this test
    // ever fails, a platform was marked publishable and must have a real,
    // documentation-verified implementation behind it.
    for (const platform of SOCIAL_PLATFORMS) {
      expect(platformProfile(platform).publishState).toBe('unimplemented')
      expect(canPublish(platform)).toBe(false)
    }
  })

  it('states the outstanding approval and required documentation for each', () => {
    for (const profile of listPlatformProfiles()) {
      expect(profile.approvalRequired.length).toBeGreaterThan(20)
      expect(profile.documentationNeeded.length).toBeGreaterThan(20)
    }
  })

  it('records that every published constraint is secondary-sourced', () => {
    // Constraint data came from industry write-ups, not from the platforms' own
    // references. That is enough to plan against and not enough to implement
    // against, and the distinction has to survive in the codebase — a
    // plausible-but-stale limit gets treated as verified once it has sat here
    // for a few months. When a platform's official docs are consulted, this
    // moves to 'official'; when a live probe confirms it, to 'live_probe'.
    for (const profile of listPlatformProfiles()) {
      expect(profile.constraintSource).toBe('secondary')
    }
  })

  it('records the platform changes that invalidate older integrations', () => {
    // Both of these break any integration written against pre-2025 assumptions,
    // and both are silent failures rather than clear errors.
    expect(platformProfile('instagram_business').recentChanges).toMatch(/Basic Display/i)
    expect(platformProfile('facebook_page').recentChanges).toMatch(/PAGES ONLY/i)
  })

  it('singles out Google Business Profile as possibly refusable', () => {
    const gbp = platformProfile('google_business_profile')
    expect(gbp.approvalRequired.toLowerCase()).toMatch(/restricted|refused/)
  })

  it('refuses to publish, with an actionable reason', async () => {
    const publisher = new UnimplementedSocialPublisher()
    await expect(publisher.publish({
      organizationId: 'org-1', socialPostId: 'post-1', platform: 'instagram_business',
      socialAccountId: 'acc-1', caption: 'hello', mediaArtifactIds: [],
    })).rejects.toBeInstanceOf(PlatformUnavailableError)

    try {
      await publisher.publish({
        organizationId: 'org-1', socialPostId: 'post-1', platform: 'tiktok',
        socialAccountId: 'acc-1', caption: 'hello', mediaArtifactIds: [],
      })
    } catch (error: any) {
      expect(error.documentationNeeded).toBeTruthy()
      expect(error.approvalRequired).toBeTruthy()
    }
  })

  it('reports readiness per target rather than per post', () => {
    const readiness = publishReadiness([
      { socialAccountId: 'a', platform: 'facebook_page' },
      { socialAccountId: 'b', platform: 'google_business_profile' },
    ])
    expect(readiness).toHaveLength(2)
    expect(readiness.every((entry) => entry.willPublish === false)).toBe(true)
    expect(readiness[0]?.blockedReason).toBeTruthy()
  })
})

describe('post composer validation', () => {
  const account = (platform: any, id = 'acc-1') => ({ socialAccountId: id, platform })

  it('accepts a valid multi-target post', () => {
    const post = validateComposedPost({
      caption: 'New roof finished in Chennai today.',
      mediaCount: 1,
      targets: [account('facebook_page', 'a'), account('instagram_business', 'b')],
    })
    expect(post.targets).toHaveLength(2)
    expect(post.scheduledFor).toBeNull()
  })

  it('requires media where the platform has no text-only post', () => {
    // Instagram and TikTok reject text-only posts. Letting one be scheduled
    // produces a failure discovered at publish time.
    expect(() => validateComposedPost({ caption: 'hello', mediaCount: 0, targets: [account('instagram_business')] }))
      .toThrow(/requires at least one image or video/)
    expect(() => validateComposedPost({ caption: 'hello', mediaCount: 0, targets: [account('tiktok')] }))
      .toThrow(/requires at least one image or video/)
    // Facebook and LinkedIn are fine with text alone.
    expect(() => validateComposedPost({ caption: 'hello', mediaCount: 0, targets: [account('facebook_page')] })).not.toThrow()
  })

  it('enforces per-platform caption limits against the effective caption', () => {
    const long = 'x'.repeat(2_500)
    // Under Facebook's limit, over Instagram's.
    expect(() => validateComposedPost({ caption: long, mediaCount: 1, targets: [account('facebook_page')] })).not.toThrow()
    expect(() => validateComposedPost({ caption: long, mediaCount: 1, targets: [account('instagram_business')] }))
      .toThrow(/limit is 2200/)
    // An override that fits is respected.
    expect(() => validateComposedPost({
      caption: long, mediaCount: 1,
      targets: [{ socialAccountId: 'a', platform: 'instagram_business', captionOverride: 'short' }],
    })).not.toThrow()
  })

  it('resolves the effective caption from the override when present', () => {
    expect(effectiveCaption({ caption: 'shared' }, { socialAccountId: 'a', platform: 'facebook_page' })).toBe('shared')
    expect(effectiveCaption({ caption: 'shared' }, { socialAccountId: 'a', platform: 'facebook_page', captionOverride: 'specific' })).toBe('specific')
    // A blank override is not an override.
    expect(effectiveCaption({ caption: 'shared' }, { socialAccountId: 'a', platform: 'facebook_page', captionOverride: '   ' })).toBe('shared')
  })

  it('enforces per-platform media counts', () => {
    expect(() => validateComposedPost({ caption: 'x', mediaCount: 3, targets: [account('pinterest')] }))
      .toThrow(/at most 1 media item/)
    expect(() => validateComposedPost({ caption: 'x', mediaCount: 3, targets: [account('facebook_page')] })).not.toThrow()
  })

  it('rejects an empty post, duplicate targets and an implausible schedule', () => {
    expect(() => validateComposedPost({ caption: '', mediaCount: 0, targets: [account('facebook_page')] }))
      .toThrow(/needs a caption, media, or both/)
    expect(() => validateComposedPost({ caption: 'x', mediaCount: 0, targets: [] })).toThrow(/at least one destination/)
    expect(() => validateComposedPost({ caption: 'x', mediaCount: 0, targets: [account('facebook_page', 'a'), account('linkedin_page', 'a')] }))
      .toThrow(/appears more than once/)
    expect(() => validateComposedPost({
      caption: 'x', mediaCount: 0, targets: [account('facebook_page')],
      scheduledFor: new Date(Date.now() + 400 * 86_400_000),
    })).toThrow(/days ahead/)
  })

  it('collects every issue rather than failing on the first', () => {
    try {
      validateComposedPost({ caption: 'x'.repeat(3_000), mediaCount: 0, targets: [account('instagram_business'), account('tiktok', 'b')] })
      throw new Error('should have thrown')
    } catch (error: any) {
      expect(error).toBeInstanceOf(ComposerError)
      expect(error.issues.length).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('review widget rendering', () => {
  const payload = {
    layout: 'carousel',
    theme: { accentColor: '#2563eb', darkMode: false },
    aggregate: { ratingValue: 4.7, reviewCount: 3 },
    reviews: [
      { id: '1', rating: 5, body: 'Excellent work', authorName: 'Priya', submittedAt: new Date('2026-01-01') },
    ],
  }

  it('escapes review content in server-rendered markup', () => {
    // A review body is attacker-influenced: anyone with a submission link can
    // put text in one, and it lands on a business's public homepage.
    const hostile = {
      ...payload,
      reviews: [{
        id: '1', rating: 5,
        body: '<script>alert(1)</script>',
        authorName: '"><img src=x onerror=alert(1)>',
        submittedAt: new Date('2026-01-01'),
      }],
    }
    const html = renderWidgetHtml({ businessName: 'Acme', payload: hostile as any })

    // The precise property: no character from the review content survives as
    // markup. "onerror=alert(1)" may appear as literal text — it is inert once
    // the surrounding angle brackets are entities — so the assertion is about
    // tag and attribute boundaries, not about scary-looking substrings.
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;&gt;&lt;img')

    // Every element in the output is one this renderer opened itself.
    const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((match) => match[1]?.toLowerCase())
    expect([...new Set(tags)].sort()).toEqual(['div', 'li', 'p', 'script', 'span', 'strong', 'ul'])
  })

  it('escapes the business name too', () => {
    const html = renderWidgetHtml({ businessName: '</div><script>x</script>', payload: payload as any })
    expect(html).not.toContain('</div><script>x')
  })

  it('emits AggregateRating JSON-LD that cannot break out of a script block', () => {
    const jsonLd = aggregateRatingJsonLd({ businessName: 'Acme </script><script>alert(1)</script>', aggregate: payload.aggregate })
    expect(jsonLd).toBeTruthy()
    expect(jsonLd).not.toContain('</script>')
    expect(jsonLd).toContain('\\u003c')
    const parsed = JSON.parse(jsonLd!.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'))
    expect(parsed.aggregateRating['@type']).toBe('AggregateRating')
    expect(parsed.aggregateRating.ratingValue).toBe(4.7)
    expect(parsed.aggregateRating.bestRating).toBe(5)
  })

  it('emits no aggregate when there is nothing to aggregate', () => {
    expect(aggregateRatingJsonLd({ businessName: 'Acme', aggregate: null })).toBeNull()
  })

  it('escapes a reply, which is operator text on a public page', () => {
    // A reply is written by the business rather than a stranger, but it still
    // lands in the DOM of a public website and an operator can paste anything
    // into a textarea.
    const withReply = {
      ...payload,
      reviews: [{
        id: '1', rating: 5, body: 'Great work', authorName: 'Priya',
        submittedAt: new Date('2026-01-01'),
        reply: { body: '<img src=x onerror=alert(1)>Thanks!', repliedAt: new Date('2026-01-02') },
      }],
    }
    const html = renderWidgetHtml({ businessName: 'Acme', payload: withReply as any })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).toContain('Thanks!')
  })

  it('builds the embed script without innerHTML for content', () => {
    const script = widgetScript({ publicKey: 'abc123', apiBaseUrl: 'https://api.example.com', businessName: 'Acme' })
    // Comments are stripped first: the rule is about executable assignments,
    // and a comment explaining why innerHTML is avoided is evidence of the
    // invariant holding rather than of it being broken.
    const executable = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(executable).not.toMatch(/\.innerHTML\s*=/)
    expect(executable).not.toMatch(/\.outerHTML\s*=/)
    expect(executable).not.toContain('document.write')
    expect(executable).toContain('textContent')
    expect(script).toContain('https://api.example.com/api/v1/public/reviews/widget/abc123')
    // No framework is pulled onto the host page.
    expect(script).not.toMatch(/require\(|import\s+/)
  })

  it('constrains the accent colour to a hex literal', () => {
    // The colour is interpolated into a stylesheet; anything else is an
    // injection point.
    expect(safeAccentColor('#ff0000')).toBe('#ff0000')
    expect(safeAccentColor('red')).toBe('#2563eb')
    expect(safeAccentColor('#fff')).toBe('#2563eb')
    expect(safeAccentColor('}</style><script>alert(1)</script>')).toBe('#2563eb')
    expect(safeAccentColor(undefined)).toBe('#2563eb')
  })
})
