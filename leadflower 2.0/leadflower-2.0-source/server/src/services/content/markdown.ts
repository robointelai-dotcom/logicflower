/**
 * Markdown rendering for the public blog.
 *
 * WHY THIS IS HAND-WRITTEN RATHER THAN A LIBRARY
 *
 * This output goes onto a public page, unauthenticated, indexed by search
 * engines. The safe approach is a small, total renderer that escapes first and
 * only then emits a fixed set of tags — rather than a general markdown library
 * plus a sanitiser, where a gap between what one produces and the other strips
 * is exactly where cross-site scripting lives.
 *
 * The rule throughout: EVERY input is HTML-escaped before any tag is emitted.
 * Raw HTML in the source is not passed through, it is escaped and shown as
 * text. An author who genuinely needs a table can have one added here; an
 * author who pastes a script tag gets to look at it rather than run it.
 */

export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Is this link safe to emit?
 *
 * Only http, https, mailto and same-site paths. `javascript:` is the obvious
 * one; `data:` is the one people forget, and it will happily carry an SVG
 * containing a script.
 */
function safeHref(url: string): string | null {
  const trimmed = String(url ?? '').trim()
  if (!trimmed) return null
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed
  return null
}

/** Inline formatting, applied to already-escaped text. */
function renderInline(escaped: string): string {
  let output = escaped

  // Images before links, since the syntax differs only by a leading bang.
  output = output.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt: string, url: string) => {
    const href = safeHref(url)
    if (!href) return match
    return `<img src="${href}" alt="${alt}" loading="lazy" decoding="async">`
  })

  output = output.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, url: string) => {
    const href = safeHref(url)
    if (!href) return match
    // External links get noopener: without it the opened page can navigate the
    // opener, which is a phishing vector on any site that accepts links.
    const external = /^https?:\/\//i.test(href)
    return `<a href="${href}"${external ? ' rel="noopener nofollow" target="_blank"' : ''}>${text}</a>`
  })

  output = output.replace(/`([^`]+)`/g, '<code>$1</code>')
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  output = output.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  return output
}

export interface RenderedArticle {
  html: string
  /** Headings, for a table of contents on a long article. */
  headings: Array<{ level: 2 | 3; text: string; id: string }>
  readingMinutes: number
}

export function slugifyHeading(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

export function renderMarkdown(source: string): RenderedArticle {
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  const headings: RenderedArticle['headings'] = []
  const usedIds = new Set<string>()

  let inCode = false
  let listType: 'ul' | 'ol' | null = null
  let paragraph: string[] = []

  const closeParagraph = () => {
    if (!paragraph.length) return
    out.push(`<p>${renderInline(escapeHtml(paragraph.join(' ')))}</p>`)
    paragraph = []
  }
  const closeList = () => {
    if (!listType) return
    out.push(`</${listType}>`)
    listType = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    if (line.trim().startsWith('```')) {
      closeParagraph(); closeList()
      out.push(inCode ? '</code></pre>' : '<pre><code>')
      inCode = !inCode
      continue
    }
    if (inCode) {
      // Escaped, never rendered. A code block is the most likely place for
      // someone to paste markup they expect to see rather than execute.
      out.push(escapeHtml(raw))
      continue
    }

    if (!line.trim()) { closeParagraph(); closeList(); continue }

    const heading = /^(#{2,3})\s+(.*)$/.exec(line)
    if (heading) {
      closeParagraph(); closeList()
      const level = heading[1]!.length === 2 ? 2 : 3
      const text = heading[2]!.trim()
      let id = slugifyHeading(text) || `section-${headings.length + 1}`
      // Duplicate headings would otherwise produce duplicate ids, and every
      // anchor after the first would jump to the wrong place.
      let suffix = 2
      while (usedIds.has(id)) id = `${slugifyHeading(text)}-${suffix++}`
      usedIds.add(id)
      headings.push({ level: level as 2 | 3, text, id })
      out.push(`<h${level} id="${id}">${renderInline(escapeHtml(text))}</h${level}>`)
      continue
    }

    if (/^>\s?/.test(line)) {
      closeParagraph(); closeList()
      out.push(`<blockquote><p>${renderInline(escapeHtml(line.replace(/^>\s?/, '')))}</p></blockquote>`)
      continue
    }

    if (/^[-*]\s+/.test(line)) {
      closeParagraph()
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul' }
      out.push(`<li>${renderInline(escapeHtml(line.replace(/^[-*]\s+/, '')))}</li>`)
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      closeParagraph()
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol' }
      out.push(`<li>${renderInline(escapeHtml(line.replace(/^\d+\.\s+/, '')))}</li>`)
      continue
    }

    if (/^(---|\*\*\*)$/.test(line.trim())) { closeParagraph(); closeList(); out.push('<hr>'); continue }

    paragraph.push(line.trim())
  }

  closeParagraph()
  closeList()
  if (inCode) out.push('</code></pre>')

  const words = String(source ?? '').split(/\s+/).filter(Boolean).length
  return {
    html: out.join('\n'),
    headings,
    // 200 words a minute, rounded up, never zero.
    readingMinutes: Math.max(1, Math.round(words / 200)),
  }
}

/** URL-safe slug from a title. */
export function slugify(title: string): string {
  return String(title ?? '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}
