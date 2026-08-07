/**
 * Media variant geometry.
 *
 * A single uploaded image has to become a square for a feed post, a tall frame
 * for a story, and a wide frame for a page header. This module computes the
 * crop or pad for each, and does nothing else — no image processing, no I/O.
 * Keeping the geometry separate is what makes it provable, and the geometry is
 * where the errors live: an off-by-one in a crop offset is invisible in code
 * review and obvious in a published post with someone's head cut off.
 *
 * Two strategies, and the default matters:
 *
 *  - **cover** crops to fill the frame. Nothing is letterboxed, but content at
 *    the edges is lost.
 *  - **contain** pads to fit. Nothing is lost, but bars appear.
 *
 * `cover` is the default because a padded feed post looks like a mistake, while
 * a slightly tight crop looks intentional. `contain` is offered because for a
 * poster, a price list or anything with text near the edge, losing content is
 * the worse failure.
 */

export const ASPECT_RATIOS = ['1:1', '9:16', '16:9', '4:5'] as const
export type AspectRatioName = (typeof ASPECT_RATIOS)[number]

export type FitStrategy = 'cover' | 'contain'

/** Target pixel dimensions per ratio, sized for the largest common surface. */
const TARGET_DIMENSIONS: Readonly<Record<AspectRatioName, { width: number; height: number }>> = Object.freeze({
  '1:1': { width: 1_080, height: 1_080 },
  '9:16': { width: 1_080, height: 1_920 },
  '16:9': { width: 1_920, height: 1_080 },
  '4:5': { width: 1_080, height: 1_350 },
})

export interface SourceImage {
  width: number
  height: number
}

export interface MediaVariant {
  ratio: AspectRatioName
  fit: FitStrategy
  /** Output canvas. */
  targetWidth: number
  targetHeight: number
  /** Region of the SOURCE to read, in source pixels. */
  sourceX: number
  sourceY: number
  sourceWidth: number
  sourceHeight: number
  /** Where the scaled region lands on the target canvas. */
  destinationX: number
  destinationY: number
  destinationWidth: number
  destinationHeight: number
  /** True when `cover` discarded part of the source. */
  cropped: boolean
  /** True when `contain` left bars. */
  padded: boolean
  /** Set when the source is smaller than the target and would be upscaled. */
  upscaled: boolean
}

export class MediaError extends Error {}

export function targetFor(ratio: AspectRatioName): { width: number; height: number } {
  const target = TARGET_DIMENSIONS[ratio]
  if (!target) throw new MediaError(`Unsupported aspect ratio: ${ratio}`)
  return target
}

function assertSource(source: SourceImage): void {
  if (!Number.isFinite(source?.width) || !Number.isFinite(source?.height)) throw new MediaError('Source dimensions must be numbers')
  if (source.width <= 0 || source.height <= 0) throw new MediaError('Source dimensions must be positive')
  if (!Number.isInteger(source.width) || !Number.isInteger(source.height)) throw new MediaError('Source dimensions must be whole pixels')
}

/**
 * Compute one variant.
 *
 * Crop is centred. Off-centre cropping needs a subject-detection step this
 * system does not have, and guessing at it produces worse results than the
 * middle — which is where people put the subject anyway.
 *
 * All outputs are rounded to whole pixels, and rounding happens once at the
 * end rather than at each intermediate step, so a chain of roundings cannot
 * accumulate into a visible one-pixel border.
 */
export function computeVariant(source: SourceImage, ratio: AspectRatioName, fit: FitStrategy = 'cover'): MediaVariant {
  assertSource(source)
  const target = targetFor(ratio)
  const targetAspect = target.width / target.height
  const sourceAspect = source.width / source.height

  let sourceX = 0
  let sourceY = 0
  let sourceWidth = source.width
  let sourceHeight = source.height
  let destinationX = 0
  let destinationY = 0
  let destinationWidth = target.width
  let destinationHeight = target.height
  let cropped = false
  let padded = false

  if (fit === 'cover') {
    if (sourceAspect > targetAspect) {
      // Source is wider than the frame: take a full-height centre column.
      sourceWidth = source.height * targetAspect
      sourceX = (source.width - sourceWidth) / 2
      cropped = true
    } else if (sourceAspect < targetAspect) {
      // Source is taller than the frame: take a full-width centre band.
      sourceHeight = source.width / targetAspect
      sourceY = (source.height - sourceHeight) / 2
      cropped = true
    }
  } else {
    if (sourceAspect > targetAspect) {
      // Wider than the frame: fit to width, bars top and bottom.
      destinationHeight = target.width / sourceAspect
      destinationY = (target.height - destinationHeight) / 2
      padded = true
    } else if (sourceAspect < targetAspect) {
      destinationWidth = target.height * sourceAspect
      destinationX = (target.width - destinationWidth) / 2
      padded = true
    }
  }

  return {
    ratio,
    fit,
    targetWidth: target.width,
    targetHeight: target.height,
    sourceX: Math.round(sourceX),
    sourceY: Math.round(sourceY),
    sourceWidth: Math.round(sourceWidth),
    sourceHeight: Math.round(sourceHeight),
    destinationX: Math.round(destinationX),
    destinationY: Math.round(destinationY),
    destinationWidth: Math.round(destinationWidth),
    destinationHeight: Math.round(destinationHeight),
    cropped,
    padded,
    // Surfaced rather than prevented: the operator may knowingly accept a soft
    // image, but they should not discover it after publishing.
    upscaled: source.width < target.width || source.height < target.height,
  }
}

export function computeVariants(source: SourceImage, ratios: readonly AspectRatioName[] = ASPECT_RATIOS, fit: FitStrategy = 'cover'): MediaVariant[] {
  return ratios.map((ratio) => computeVariant(source, ratio, fit))
}

/**
 * Which ratios a platform actually wants.
 *
 * Advisory. It tells the composer which variants are worth generating; it does
 * not assert that a platform will accept them, because the platform decides
 * that and none of these integrations are verified.
 */
export function suggestedRatios(platform: string): AspectRatioName[] {
  switch (platform) {
    case 'instagram_business': return ['1:1', '4:5', '9:16']
    case 'tiktok': return ['9:16']
    case 'pinterest': return ['4:5', '9:16']
    case 'linkedin_page': return ['1:1', '16:9']
    case 'facebook_page': return ['1:1', '16:9', '9:16']
    case 'google_business_profile': return ['1:1', '16:9']
    default: return ['1:1']
  }
}
