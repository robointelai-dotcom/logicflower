import React from 'react'
import { ArrowLeft, Clock } from 'lucide-react'
import { Link, useParams } from '../router'
import { AppLogo } from '../components/ui'

/**
 * The public blog: index and article.
 *
 * Unauthenticated, so it calls the public API directly rather than through the
 * session-bearing client.
 *
 * Article HTML arrives already rendered and escaped by the server. It is the
 * only place in this application that sets HTML from a string, and it is safe
 * precisely because the renderer escapes everything before emitting its own
 * fixed tag set — never because this component sanitises anything.
 */

const API = '/api/v1/public/content'

interface PostSummary {
  title: string; slug: string; excerpt: string; category: string
  publishedAt: string; readingMinutes: number; authorName: string
}

interface Article {
  article: {
    title: string; excerpt: string; html: string
    headings: Array<{ level: 2 | 3; text: string; id: string }>
    readingMinutes: number; authorName: string; authorTitle?: string
    category: string; tags: string[]; publishedAt: string; modifiedAt: string
  }
  seo: { title: string; description: string; canonical: string; noindex: boolean }
  structuredData: Record<string, unknown>
  related: Array<{ title: string; slug: string; excerpt: string; readingMinutes: number }>
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'omit' })
  if (!response.ok) throw new Error(response.status === 404 ? 'That article could not be found.' : 'Could not load.')
  return await response.json() as T
}

/**
 * Apply page metadata.
 *
 * Set from the client because this is a single-page app. Search engines that
 * execute JavaScript will see it; for the rest, server rendering would be the
 * proper fix and is recorded as outstanding rather than pretended away.
 */
function useSeo(seo?: Article['seo']) {
  React.useEffect(() => {
    if (!seo) return
    document.title = seo.title
    const set = (selector: string, attrs: Record<string, string>) => {
      let tag = document.head.querySelector(selector)
      if (!tag) {
        tag = document.createElement(selector.startsWith('link') ? 'link' : 'meta')
        document.head.appendChild(tag)
      }
      for (const [key, value] of Object.entries(attrs)) tag.setAttribute(key, value)
    }
    set('meta[name="description"]', { name: 'description', content: seo.description || '' })
    set('link[rel="canonical"]', { rel: 'canonical', href: seo.canonical })
    if (seo.noindex) set('meta[name="robots"]', { name: 'robots', content: 'noindex' })
    else document.head.querySelector('meta[name="robots"]')?.remove()
  }, [seo])
}

function MarketingChrome({ children }: { children: React.ReactNode }) {
  return <div className="marketing">
    <header className="marketing-nav">
      <Link to="/" className="marketing-brand"><AppLogo /></Link>
      <nav aria-label="Main"><Link to="/">Home</Link><Link to="/blog">Blog</Link></nav>
      <div className="marketing-nav-actions"><Link to="/login">Sign in</Link><Link to="/signup" className="btn-primary-lg">Start free</Link></div>
    </header>
    {children}
    <footer className="marketing-footer">
      <div><AppLogo /><p>Follow-up, CRM, booking and reputation for small businesses.</p></div>
      <p className="marketing-copyright">© {new Date().getFullYear()} LogicFlower</p>
    </footer>
  </div>
}

export function BlogIndexPage() {
  const [posts, setPosts] = React.useState<PostSummary[] | null>(null)
  const [category, setCategory] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    document.title = 'Blog — LogicFlower'
    void (async () => {
      try {
        const data = await getJson<{ posts: PostSummary[] }>(`${API}/posts${category ? `?category=${encodeURIComponent(category)}` : ''}`)
        setPosts(data.posts)
      } catch (loadError) { setError((loadError as Error).message) }
    })()
  }, [category])

  const categories = [...new Set((posts ?? []).map((post) => post.category).filter(Boolean))]
  const [featured, ...rest] = posts ?? []

  return <MarketingChrome>
    <section className="section blog-head">
      <p className="eyebrow">Insights</p>
      <h1>Getting more work, and losing less of it</h1>
      <p className="section-sub">Practical writing about follow-up, booking and reputation for small businesses.</p>
    </section>

    {error && <section className="section"><p className="muted">{error}</p></section>}

    {posts && posts.length > 0 && <section className="section">
      {categories.length > 1 && <div className="blog-filters">
        <button type="button" className={!category ? 'chip chip-button selected' : 'chip chip-button'} onClick={() => setCategory(null)}>All</button>
        {categories.map((name) => <button type="button" key={name}
          className={category === name ? 'chip chip-button selected' : 'chip chip-button'}
          onClick={() => setCategory(name)}>{name}</button>)}
      </div>}

      {featured && <Link to={`/blog/${featured.slug}`} className="blog-featured">
        <span className="eyebrow">{featured.category}</span>
        <h2>{featured.title}</h2>
        <p>{featured.excerpt}</p>
        <span className="muted"><Clock size={13} /> {featured.readingMinutes} min read</span>
      </Link>}

      <div className="blog-grid">
        {rest.map((post) => <Link key={post.slug} to={`/blog/${post.slug}`} className="blog-card">
          <span className="eyebrow">{post.category}</span>
          <strong>{post.title}</strong>
          <p>{post.excerpt}</p>
          <span className="muted"><Clock size={13} /> {post.readingMinutes} min read</span>
        </Link>)}
      </div>
    </section>}

    {posts && !posts.length && <section className="section"><p className="muted">Nothing published yet.</p></section>}
  </MarketingChrome>
}

export default function BlogArticlePage() {
  const params = useParams()
  const slug = params.slug ?? ''
  const [data, setData] = React.useState<Article | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!slug) return
    void (async () => {
      try { setData(await getJson<Article>(`${API}/posts/${encodeURIComponent(slug)}`)) }
      catch (loadError) { setError((loadError as Error).message) }
    })()
  }, [slug])

  useSeo(data?.seo)

  if (error) return <MarketingChrome><section className="section"><h1>Not found</h1><p className="muted">{error}</p><Link to="/blog">Back to the blog</Link></section></MarketingChrome>
  if (!data) return <MarketingChrome><section className="section"><p className="muted">Loading…</p></section></MarketingChrome>

  const { article } = data
  const showContents = article.headings.length >= 3

  return <MarketingChrome>
    {/* Assembled server-side so the shape lives with the data. */}
    <script type="application/ld+json" dangerouslySetInnerHTML={{
      __html: JSON.stringify(data.structuredData).replace(/</g, '\\u003c'),
    }} />

    <article className="section article">
      <p className="back-link"><Link to="/blog"><ArrowLeft size={13} /> All articles</Link></p>
      <header className="article-head">
        <span className="eyebrow">{article.category}</span>
        <h1>{article.title}</h1>
        {article.excerpt && <p className="article-standfirst">{article.excerpt}</p>}
        <p className="article-meta">
          {article.authorName && <span>{article.authorName}{article.authorTitle ? `, ${article.authorTitle}` : ''}</span>}
          <time dateTime={article.publishedAt}>{new Date(article.publishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</time>
          <span><Clock size={13} /> {article.readingMinutes} min read</span>
        </p>
      </header>

      {showContents && <nav className="article-contents" aria-label="On this page">
        <p className="eyebrow">On this page</p>
        <ol>{article.headings.filter((heading) => heading.level === 2).map((heading) => <li key={heading.id}><a href={`#${heading.id}`}>{heading.text}</a></li>)}</ol>
      </nav>}

      {/* Server-rendered and server-escaped. See the note at the top of this file. */}
      <div className="article-body" dangerouslySetInnerHTML={{ __html: article.html }} />

      {Boolean(article.tags.length) && <div className="chip-row">{article.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}</div>}
    </article>

    {data.related.length > 0 && <section className="section section-tint">
      <div className="section-head"><h2>Related reading</h2></div>
      <div className="blog-grid">
        {data.related.map((post) => <Link key={post.slug} to={`/blog/${post.slug}`} className="blog-card">
          <strong>{post.title}</strong><p>{post.excerpt}</p>
          <span className="muted"><Clock size={13} /> {post.readingMinutes} min read</span>
        </Link>)}
      </div>
    </section>}

    <section className="final-cta">
      <h2>Stop losing work to a slow reply.</h2>
      <Link to="/signup" className="btn-primary-lg">Start free</Link>
    </section>
  </MarketingChrome>
}
