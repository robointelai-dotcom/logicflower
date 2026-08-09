import React from 'react'
import { AlertTriangle, ArrowLeft, Check, Clock, ExternalLink, Eye, Globe, Image as ImageIcon, Plus, Rss } from 'lucide-react'
import { getOne, send } from '../api/client'
import { Link, useNavigate, useParams } from '../router'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'

/**
 * The website control center: articles, global search settings and redirects.
 *
 * Corporate only. There is one public website and it belongs to the platform
 * operator, so nothing here is scoped to a workspace.
 */

interface PostRow {
  id: string; title: string; slug: string; status: string; category: string
  publishedAt: string | null; readingMinutes: number; targetKeyword?: string; noindex?: boolean
}

/**
 * Corporate-only guard for the client route.
 *
 * The server already refuses every /content write from a non-corporate user, so
 * this is not what keeps the data safe. It exists so somebody who types the URL
 * gets a clear refusal instead of a page shell that flashes up and then fills
 * with an error — which reads as a broken screen rather than a closed door.
 */
function useCorporateOnly() {
  const [state, setState] = React.useState<'checking' | 'allowed' | 'denied'>('checking')
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const context = await getOne<{ corporate: boolean }>('/hierarchy/context')
        if (!cancelled) setState(context.corporate ? 'allowed' : 'denied')
      } catch {
        // Fail closed: if we cannot establish that someone is corporate, they
        // are not treated as corporate.
        if (!cancelled) setState('denied')
      }
    })()
    return () => { cancelled = true }
  }, [])
  return state
}

function NotForYou() {
  return <Card><EmptyState
    icon={<Globe />}
    title="This is a platform area"
    description="The public website and its search settings are managed by the platform team, not from a workspace."
  /></Card>
}

export function ContentListPage() {
  const access = useCorporateOnly()
  const navigate = useNavigate()
  const action = useAction()
  const [open, setOpen] = React.useState(false)
  const [title, setTitle] = React.useState('')

  const posts = useApi(async () => (await getOne<{ posts: PostRow[] }>('/content/posts')).posts, [])
  const settings = useApi(async () => (await getOne<{ settings: any }>('/content/settings')).settings, [])
  const redirects = useApi(async () => (await getOne<{ redirects: any[] }>('/content/redirects')).redirects, [])

  const [site, setSite] = React.useState<any>(null)
  React.useEffect(() => { if (settings.data && !site) setSite(settings.data) }, [settings.data, site])

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send<{ id: string }>('post', '/content/posts', { title }), 'Draft created.')
    if (result) { setOpen(false); setTitle(''); navigate(`/website/posts/${result.id}`) }
  }

  const saveSettings = async (event: React.FormEvent) => {
    event.preventDefault()
    await action.run(() => send('put', '/content/settings', site), 'Settings saved.')
  }

  const addRedirect = async (fromPath: string, toPath: string) => {
    const result = await action.run(() => send('post', '/content/redirects', { fromPath, toPath }), 'Redirect added.')
    if (result !== undefined) await redirects.reload()
  }

  if (access === 'checking') return <SkeletonRows rows={4} columns={3} />
  if (access === 'denied') return <NotForYou />

  return <>
    <PageHeader
      eyebrow="Corporate"
      title="Website"
      description="Articles, search settings and redirects for the public site."
      actions={<Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />New article</Button>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    {/*
      A forgotten site-wide noindex is the most expensive mistake available
      here, so it is stated loudly rather than sitting quietly in a form.
    */}
    {site?.robotsNoindexAll && <Alert tone="error">
      <strong>The whole site is blocked from search engines.</strong> Nothing will be indexed while this is on.
    </Alert>}
    {site && !site.canonicalDomain && <Alert tone="warning">
      No canonical domain is set, so canonical links and the sitemap are relative. Set it below before launch, or the site can end up competing with itself in search results.
    </Alert>}

    <Card title="Articles">
      {posts.loading ? <SkeletonRows rows={3} columns={4} />
        : posts.data?.length ? <table className="data-table">
          <thead><tr><th>Title</th><th>Status</th><th>Category</th><th>Keyword</th><th /></tr></thead>
          <tbody>{posts.data.map((post) => <tr key={post.id}>
            <td><Link to={`/website/posts/${post.id}`}><strong>{post.title}</strong></Link><div className="muted">/blog/{post.slug}</div></td>
            <td><StatusBadge status={post.status === 'published' ? 'active' : post.status === 'scheduled' ? 'pending' : post.status === 'archived' ? 'paused' : 'pending'} label={post.status} /></td>
            <td className="muted">{post.category}</td>
            <td className="muted">{post.targetKeyword || '—'}</td>
            <td className="row-actions">
              {post.status === 'published' && <a href={`/blog/${post.slug}`} target="_blank" rel="noopener" className="row-link">View <ExternalLink size={12} /></a>}
            </td>
          </tr>)}</tbody>
        </table> : <EmptyState icon={<Globe />} title="No articles yet" description="Write one and publish it to the public blog." action={<Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />New article</Button>} />}
    </Card>

    {site && <Card title="Search settings">
      <form className="form-stack" onSubmit={saveSettings}>
        <div className="field-row">
          <Field label="Site title"><input value={site.siteTitle ?? ''} onChange={(event) => setSite({ ...site, siteTitle: event.target.value })} /></Field>
          <Field label="Title template" hint="%s is replaced by the page title."><input value={site.titleTemplate ?? '%s'} onChange={(event) => setSite({ ...site, titleTemplate: event.target.value })} /></Field>
        </div>
        <Field label="Site description"><textarea rows={2} value={site.siteDescription ?? ''} onChange={(event) => setSite({ ...site, siteDescription: event.target.value })} /></Field>
        <Field label="Canonical domain" hint="One origin, no trailing slash, e.g. https://example.com">
          <input value={site.canonicalDomain ?? ''} onChange={(event) => setSite({ ...site, canonicalDomain: event.target.value })} placeholder="https://…" />
        </Field>
        <div className="field-row">
          <Field label="Organisation name"><input value={site.organizationName ?? ''} onChange={(event) => setSite({ ...site, organizationName: event.target.value })} /></Field>
          <Field label="Default social image URL"><input value={site.defaultSocialImageUrl ?? ''} onChange={(event) => setSite({ ...site, defaultSocialImageUrl: event.target.value })} /></Field>
        </div>
        <label className="toggle-row">
          <input type="checkbox" checked={Boolean(site.robotsNoindexAll)} onChange={(event) => setSite({ ...site, robotsNoindexAll: event.target.checked })} />
          <span>Block the entire site from search engines (staging only)</span>
        </label>
        <Button variant="primary" type="submit" busy={action.loading}>Save settings</Button>
      </form>
    </Card>}

    <Card title="Feeds" subtitle="How aggregators and email digests pick up new articles.">
      <p className="muted"><Rss size={14} /> <a href="/api/v1/public/content/rss.xml" target="_blank" rel="noopener">rss.xml</a> · <a href="/api/v1/public/content/sitemap.xml" target="_blank" rel="noopener">sitemap.xml</a> · <a href="/api/v1/public/content/robots.txt" target="_blank" rel="noopener">robots.txt</a></p>
    </Card>

    <Card title="Redirects" subtitle="Keep old links working when an address changes.">
      <form className="redirect-add" onSubmit={(event) => {
        event.preventDefault()
        const form = event.target as HTMLFormElement
        const from = (form.elements.namedItem('from') as HTMLInputElement).value
        const to = (form.elements.namedItem('to') as HTMLInputElement).value
        if (from && to) { void addRedirect(from, to); form.reset() }
      }}>
        <input name="from" placeholder="/old-path" aria-label="From path" />
        <span aria-hidden="true">→</span>
        <input name="to" placeholder="/new-path" aria-label="To path" />
        <Button type="submit" size="sm" busy={action.loading}>Add</Button>
      </form>
      {redirects.data?.length ? <table className="data-table">
        <thead><tr><th>From</th><th>To</th><th>Type</th><th>Hits</th></tr></thead>
        <tbody>{redirects.data.map((redirect) => <tr key={redirect.id}>
          <td className="muted">{redirect.fromPath}</td>
          <td className="muted">{redirect.toPath}</td>
          <td className="muted">{redirect.statusCode}</td>
          <td className="muted">{redirect.hits}</td>
        </tr>)}</tbody>
      </table> : <p className="muted">None yet.</p>}
    </Card>

    <Modal
      open={open} title="New article"
      description="Created as a draft. The address is generated from the title and can be changed until it is published."
      onClose={() => setOpen(false)}
      footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="post-create" busy={action.loading}>Create</Button></>}
    >
      <form id="post-create" className="form-stack" onSubmit={create}>
        <Field label="Title" required><input value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus /></Field>
      </form>
    </Modal>
  </>
}

export default function ContentEditorPage() {
  const access = useCorporateOnly()
  const params = useParams()
  const postId = params.id ?? ''
  const action = useAction()
  const [post, setPost] = React.useState<any>(null)
  const [loaded, setLoaded] = React.useState(false)

  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null)
  const [scheduleAt, setScheduleAt] = React.useState('')
  const query = useApi(async () => postId
    ? await getOne<{ post: any; guidance: any; freshness: any; wordCount: number }>(`/content/posts/${postId}`)
    : null, [postId])
  React.useEffect(() => { if (!loaded && !query.loading && query.data?.post) { setPost(query.data.post); setLoaded(true) } }, [query.loading, query.data, loaded])

  const set = (key: string, value: unknown) => setPost((current: any) => ({ ...current, [key]: value }))

  const save = async () => {
    await action.run(() => send('patch', `/content/posts/${postId}`, {
      title: post.title, slug: post.slug, excerpt: post.excerpt, body: post.body,
      authorName: post.authorName, authorTitle: post.authorTitle, category: post.category, tags: post.tags,
      featuredImageAlt: post.featuredImageAlt,
      seoTitle: post.seoTitle, metaDescription: post.metaDescription, canonicalUrl: post.canonicalUrl,
      ogTitle: post.ogTitle, ogDescription: post.ogDescription, noindex: post.noindex,
      targetKeyword: post.targetKeyword, secondaryKeywords: post.secondaryKeywords, searchIntent: post.searchIntent,
      informationGainSource: post.informationGainSource,
      dateReviewed: post.dateReviewed, reviewedByName: post.reviewedByName, reviewedByTitle: post.reviewedByTitle,
      authorBio: post.authorBio, authorKnowsAbout: post.authorKnowsAbout, authorSameAs: post.authorSameAs,
    }), 'Saved.')
  }

  const setStatus = async (status: string, publishAt?: string) => {
    const result = await action.run(() => send('post', `/content/posts/${postId}/status`, { status, publishAt }),
      status === 'published' ? 'Published.' : status === 'scheduled' ? 'Scheduled. It will publish itself.' : 'Updated.')
    if (result !== undefined) await query.reload()
  }

  /**
   * Upload a featured image.
   *
   * Read as base64 in the browser and validated on its bytes by the server —
   * the content type the browser reports is supplied by whoever chose the file
   * and is not trusted.
   */
  const uploadImage = async (file: File) => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
      reader.onerror = () => reject(new Error('Could not read that file'))
      reader.readAsDataURL(file)
    })
    const result = await action.run(() => send<{ url: string }>('post', `/content/posts/${postId}/image`, {
      contentBase64: base64, contentType: file.type, alt: post?.featuredImageAlt ?? '',
    }), 'Image attached.')
    if (result) await query.reload()
  }

  const makePreviewLink = async () => {
    const result = await action.run(() => send<{ url: string }>('post', `/content/posts/${postId}/preview-token`, {}),
      'Preview link created.')
    if (result) setPreviewUrl(`${window.location.origin}${result.url}`)
  }

  if (access === 'checking') return <SkeletonRows rows={5} columns={2} />
  if (access === 'denied') return <NotForYou />
  if (query.loading && !loaded) return <SkeletonRows rows={5} columns={2} />
  if (!post) return <Alert>{query.error ?? 'Not found.'}</Alert>

  const guidance = query.data?.guidance
  const freshness = query.data?.freshness

  const descriptionLength = String(post.metaDescription ?? '').length

  return <>
    <p className="back-link"><Link to="/website"><ArrowLeft size={13} /> Website</Link></p>
    <PageHeader
      eyebrow="Article"
      title={post.title}
      description={`/blog/${post.slug}`}
      actions={<>
        <Button busy={action.loading} onClick={() => { void save() }}>Save</Button>
        {post.status === 'published'
          ? <Button variant="ghost" busy={action.loading} onClick={() => { void setStatus('draft') }}>Unpublish</Button>
          : <Button variant="primary" busy={action.loading} onClick={() => { void save().then(() => setStatus('published')) }}>Publish</Button>}
      </>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    <div className="editor-layout">
      <div className="editor-steps">
        <Card>
          <Field label="Title" required><input value={post.title ?? ''} onChange={(event) => set('title', event.target.value)} /></Field>
          <Field label="Address" hint={post.status === 'published' ? 'Fixed once published — every existing link points here.' : 'Generated from the title. Changeable until published.'}>
            <input value={post.slug ?? ''} disabled={post.status === 'published'} onChange={(event) => set('slug', event.target.value)} />
          </Field>
          <Field label="Standfirst" hint="One or two sentences, shown in listings and search results.">
            <textarea rows={2} value={post.excerpt ?? ''} onChange={(event) => set('excerpt', event.target.value)} />
          </Field>
        </Card>

        <Card title="Article" subtitle="Markdown. Headings become anchors and a contents list.">
          <Field label="">
            <textarea rows={22} className="markdown-editor" value={post.body ?? ''} onChange={(event) => set('body', event.target.value)}
              placeholder={'## Why speed matters\n\nMost inquiries go to whoever replies first...\n\n- One\n- Two\n\n> A quote.'} />
          </Field>
        </Card>
      </div>

      <aside className="editor-side">
        <Card title="Publishing">
          <p><StatusBadge status={post.status === 'published' ? 'active' : 'pending'} label={post.status} /></p>
          <div className="field-row">
            <Field label="Author"><input value={post.authorName ?? ''} onChange={(event) => set('authorName', event.target.value)} /></Field>
            <Field label="Category"><input value={post.category ?? ''} onChange={(event) => set('category', event.target.value)} /></Field>
          </div>
          <Field label="Tags" hint="Comma separated.">
            <input value={(post.tags ?? []).join(', ')} onChange={(event) => set('tags', event.target.value.split(',').map((tag: string) => tag.trim()).filter(Boolean))} />
          </Field>

          {post.status !== 'published' && <>
            <Field label="Or schedule it" hint="It will publish itself at this time.">
              <input type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} />
            </Field>
            <Button size="sm" disabled={!scheduleAt} busy={action.loading}
              onClick={() => { void save().then(() => setStatus('scheduled', new Date(scheduleAt).toISOString())) }}>
              <Clock size={14} />Schedule
            </Button>
          </>}
        </Card>

        <Card title="Featured image" subtitle="Used as the card preview when the article is shared.">
          {post.featuredImageUrl
            ? <img src={post.featuredImageUrl} alt={post.featuredImageAlt ?? ''} className="featured-preview" />
            : <p className="muted"><ImageIcon size={14} /> None yet.</p>}
          <Field label="Choose an image" hint="JPEG, PNG, WebP or GIF. SVG is refused — it can carry script.">
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(file) }} />
          </Field>
          <Field label="Describe the image" hint="Read aloud by screen readers, and shown if the image fails to load.">
            <input value={post.featuredImageAlt ?? ''} onChange={(event) => set('featuredImageAlt', event.target.value)} />
          </Field>
        </Card>

        <Card title="Share a draft" subtitle="A link that lets somebody read this before it is published.">
          <Button size="sm" busy={action.loading} onClick={() => { void makePreviewLink() }}><Eye size={14} />Create preview link</Button>
          {previewUrl && <>
            <p className="preview-link">{previewUrl}</p>
            {/* Rotating revokes any link already handed out. */}
            <p className="muted">Anyone with this link can read the draft. Creating a new one revokes this.</p>
          </>}
        </Card>

        <Card title="Search" subtitle="How this appears in a result.">
          <Field label="SEO title" hint="Defaults to the article title."><input value={post.seoTitle ?? ''} onChange={(event) => set('seoTitle', event.target.value)} /></Field>
          <Field label="Meta description" hint={`${descriptionLength} characters — around 150 to 160 shows in full.`}>
            <textarea rows={3} value={post.metaDescription ?? ''} onChange={(event) => set('metaDescription', event.target.value)} />
          </Field>
          <Field label="Canonical URL" hint="Only if this article was published elsewhere first.">
            <input value={post.canonicalUrl ?? ''} onChange={(event) => set('canonicalUrl', event.target.value)} />
          </Field>
          <Field label="Social title" hint="Shown when shared. Defaults to the SEO title.">
            <input value={post.ogTitle ?? ''} onChange={(event) => set('ogTitle', event.target.value)} />
          </Field>
          <Field label="Social description">
            <textarea rows={2} value={post.ogDescription ?? ''} onChange={(event) => set('ogDescription', event.target.value)} />
          </Field>
          <label className="toggle-row">
            <input type="checkbox" checked={Boolean(post.noindex)} onChange={(event) => set('noindex', event.target.checked)} />
            <span>Hide from search engines</span>
          </label>
        </Card>

        {/*
          Editorial only. These guide whoever writes the next article and are
          never emitted as markup — the meta keywords tag has been ignored by
          search engines for well over a decade.
        */}
        {/*
          The intent, made useful. It was previously a label nobody acted on;
          these are the checks that intent implies. Prompts, not gates —
          publishing is never blocked on them.
        */}
        {guidance && <Card title="For this kind of article" subtitle={guidance.goal}>
          <ul className="guidance-list">
            {guidance.checks.map((check: any) => <li key={check.label} className={check.met ? 'met' : 'unmet'}>
              {check.met ? <Check size={14} /> : <AlertTriangle size={14} />}
              <div>
                <strong>{check.label}</strong>
                {!check.met && <span>{check.advice}</span>}
              </div>
            </li>)}
          </ul>
        </Card>}

        {freshness?.needsReview && <Alert tone="warning">
          {freshness.reason} Set a review date once you have checked the advice still holds — editing a typo is not a review.
        </Alert>}

        <Card title="Editorial notes" subtitle="For whoever writes next. Not published anywhere.">
          <Field label="Target keyword"><input value={post.targetKeyword ?? ''} onChange={(event) => set('targetKeyword', event.target.value)} /></Field>
          <Field label="What this is based on" hint="A benchmark you ran, data you hold, an incident you handled. Not published as markup.">
            <textarea rows={2} value={post.informationGainSource ?? ''} onChange={(event) => set('informationGainSource', event.target.value)} />
          </Field>
          <Field label="Search intent">
            <select value={post.searchIntent ?? ''} onChange={(event) => set('searchIntent', event.target.value || null)}>
              <option value="">Not set</option>
              <option value="informational">Informational</option>
              <option value="commercial">Commercial</option>
              <option value="transactional">Transactional</option>
              <option value="navigational">Navigational</option>
            </select>
          </Field>
        </Card>

        <Card title="Editorial review" subtitle="Recorded separately from edits, because fixing a typo is not a review.">
          <Field label="Last reviewed">
            <input type="date"
              value={post.dateReviewed ? String(post.dateReviewed).slice(0, 10) : ''}
              onChange={(event) => set('dateReviewed', event.target.value || null)} />
          </Field>
          <div className="field-row">
            <Field label="Reviewed by"><input value={post.reviewedByName ?? ''} onChange={(event) => set('reviewedByName', event.target.value)} /></Field>
            <Field label="Their role"><input value={post.reviewedByTitle ?? ''} onChange={(event) => set('reviewedByTitle', event.target.value)} /></Field>
          </div>
          {/* Both are needed, or nothing is claimed. Half a claim is still a
              claim about editorial process. */}
          <p className="muted">A name and a date are both required before the article claims it was reviewed.</p>
        </Card>

        <Card title="Author credentials" subtitle="What makes the byline worth trusting. Becomes the Person entity.">
          <Field label="Bio"><textarea rows={2} value={post.authorBio ?? ''} onChange={(event) => set('authorBio', event.target.value)} /></Field>
          <Field label="Writes about" hint="Comma separated.">
            <input value={(post.authorKnowsAbout ?? []).join(', ')}
              onChange={(event) => set('authorKnowsAbout', event.target.value.split(',').map((entry: string) => entry.trim()).filter(Boolean))} />
          </Field>
          <Field label="Verified profiles" hint="Full URLs, comma separated. Real ones only — these are published as claims.">
            <input value={(post.authorSameAs ?? []).join(', ')}
              onChange={(event) => set('authorSameAs', event.target.value.split(',').map((entry: string) => entry.trim()).filter(Boolean))} />
          </Field>
        </Card>
      </aside>
    </div>
  </>
}
