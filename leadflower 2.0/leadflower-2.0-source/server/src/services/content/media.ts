/**
 * Responsive image variants, and the markup that serves them.
 *
 * ON AVIF
 *
 * The prompt asked for AVIF. This build of sharp reports `avif output: false` —
 * the encoder is not compiled in. Rather than emit `<source type="image/avif">`
 * pointing at files that do not exist, which would leave browsers falling
 * through to the fallback on every request while looking correct in the markup,
 * variant generation reports what it actually produced.
 *
 * The `<picture>` element is built from that report, so the day the platform
 * ships a sharp with AVIF support, the sources appear with no change here.
 * `supportsAvif()` says plainly whether it does.
 */

export const VARIANT_WIDTHS = [480, 960, 1440] as const

export interface Variant {
  width: number
  format: 'avif' | 'webp' | 'jpeg' | 'png'
  bytes: Buffer
  contentType: string
}

export interface VariantReport {
  variants: Variant[]
  /** Intrinsic size, so the markup can reserve space and avoid layout shift. */
  originalWidth: number
  originalHeight: number
  avifGenerated: boolean
  note?: string
}

/**
 * The image processor, if this deployment has one.
 *
 * `sharp` is a large native dependency and is deliberately NOT declared as a
 * requirement: the blog works without it, serving the uploaded original. When
 * it is present, variants are generated.
 *
 * Loaded through a runtime resolve rather than a static import so the build
 * does not depend on it being installed, and so a deployment without it fails
 * by producing fewer variants rather than by refusing to start.
 */
type SharpLike = any

let sharpCache: SharpLike | null | undefined
async function loadSharp(): Promise<SharpLike | null> {
  if (sharpCache !== undefined) return sharpCache
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, security/detect-non-literal-require -- fixed module name; resolved at runtime because sharp is an optional native dependency
    sharpCache = require('sharp')
  } catch {
    sharpCache = null
  }
  return sharpCache
}

/** Whether this deployment can encode AVIF at all. */
export async function supportsAvif(): Promise<boolean> {
  const sharp = await loadSharp()
  return Boolean(sharp?.format?.avif?.output?.buffer)
}

/**
 * Produce the variants this deployment can actually produce.
 *
 * Never upscales. Generating a 1440px variant from a 600px original makes a
 * larger file that looks worse, and `srcset` would then serve it to exactly the
 * screens least able to afford the bytes.
 */
export async function generateVariants(input: { body: Buffer; sourceFormat: string }): Promise<VariantReport> {
  const sharp = await loadSharp()
  if (!sharp) {
    return {
      variants: [],
      originalWidth: 0,
      originalHeight: 0,
      avifGenerated: false,
      note: 'No image processor available; the original is served unchanged.',
    }
  }

  const image = sharp(input.body)
  const metadata = await image.metadata()
  const originalWidth = metadata.width ?? 0
  const originalHeight = metadata.height ?? 0

  const avif = Boolean(sharp.format?.avif?.output?.buffer)
  const widths = VARIANT_WIDTHS.filter((width) => width <= originalWidth || width === VARIANT_WIDTHS[0])
  const variants: Variant[] = []

  for (const width of widths) {
    if (originalWidth && width > originalWidth) continue

    if (avif) {
      variants.push({
        width, format: 'avif', contentType: 'image/avif',
        bytes: await sharp(input.body).resize({ width, withoutEnlargement: true }).avif({ quality: 55 }).toBuffer(),
      })
    }
    variants.push({
      width, format: 'webp', contentType: 'image/webp',
      bytes: await sharp(input.body).resize({ width, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(),
    })
    // A fallback in the original family, for anything that reads neither.
    const fallback = input.sourceFormat === 'image/png' ? 'png' : 'jpeg'
    variants.push({
      width, format: fallback as 'jpeg' | 'png',
      contentType: fallback === 'png' ? 'image/png' : 'image/jpeg',
      bytes: fallback === 'png'
        ? await sharp(input.body).resize({ width, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer()
        : await sharp(input.body).resize({ width, withoutEnlargement: true }).jpeg({ quality: 82, progressive: true }).toBuffer(),
    })
  }

  return {
    variants,
    originalWidth,
    originalHeight,
    avifGenerated: avif,
    note: avif ? undefined : 'AVIF is not supported by this build of the image processor; WebP and the original format were generated.',
  }
}

export interface FigureInput {
  /** Map of `${format}-${width}` to public URL. */
  urls: Record<string, string>
  widths: number[]
  formats: string[]
  fallbackUrl: string
  alt: string
  /** Visible caption. Distinct from alt — see below. */
  caption?: string
  credit?: string
  originalWidth?: number
  originalHeight?: number
}

function escapeAttribute(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Build the figure markup.
 *
 * ALT AND CAPTION ARE NOT THE SAME THING, and conflating them is the most
 * common accessibility mistake in a CMS. `alt` replaces the image for somebody
 * who cannot see it and should describe what it shows. A caption is read by
 * everybody and adds something the image does not already say. Duplicating one
 * into the other makes a screen reader announce the same sentence twice.
 *
 * `width` and `height` are emitted so the browser reserves the space before the
 * bytes arrive, which is what stops the text jumping as the page loads.
 */
export function renderFigure(input: FigureInput): string {
  const sources: string[] = []
  // AVIF first, then WebP: a browser takes the first source it understands, so
  // the order is the preference order.
  for (const format of ['avif', 'webp'] as const) {
    if (!input.formats.includes(format)) continue
    const srcset = input.widths
      .map((width) => input.urls[`${format}-${width}`] ? `${input.urls[`${format}-${width}`]} ${width}w` : null)
      .filter(Boolean)
      .join(', ')
    if (srcset) {
      sources.push(`<source type="image/${format}" srcset="${escapeAttribute(srcset)}" sizes="(max-width: 700px) 100vw, 700px">`)
    }
  }

  const dimensions = input.originalWidth && input.originalHeight
    ? ` width="${input.originalWidth}" height="${input.originalHeight}"`
    : ''

  const caption = input.caption?.trim()
  const credit = input.credit?.trim()

  return [
    '<figure class="article-figure">',
    '  <picture>',
    ...sources.map((source) => `    ${source}`),
    `    <img src="${escapeAttribute(input.fallbackUrl)}" alt="${escapeAttribute(input.alt)}"${dimensions} loading="lazy" decoding="async">`,
    '  </picture>',
    ...(caption || credit ? [
      '  <figcaption>',
      caption ? `    <span class="figure-caption">${escapeAttribute(caption)}</span>` : '',
      credit ? `    <span class="figure-credit">${escapeAttribute(credit)}</span>` : '',
      '  </figcaption>',
    ].filter(Boolean) : []),
    '</figure>',
  ].join('\n')
}
