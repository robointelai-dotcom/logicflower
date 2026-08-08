import React from 'react'
import { ArrowLeft, ExternalLink, Globe, Plus } from 'lucide-react'
import { getOne, send } from '../api/client'
import { Link, useNavigate, useParams } from '../router'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'

/**
 * The website control centre: articles, global search settings and redirects.
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

  const query = useApi(async () => postId ? (await getOne<{ post: any }>(`/content/posts/${postId}`)).post : null, [postId])
  React.useEffect(() => { if (!loaded && !query.loading && query.data) { setPost(query.data); setLoaded(true) } }, [query.loading, query.data, loaded])

  const set = (key: string, value: unknown) => setPost((current: any) => ({ ...current, [key]: value }))

  const save = async () => {
    await action.run(() => send('patch', `/content/posts/${postId}`, {
      title: post.title, slug: post.slug, excerpt: post.excerpt, body: post.body,
      authorName: post.authorName, authorTitle: post.authorTitle, category: post.category, tags: post.tags,
      seoTitle: post.seoTitle, metaDescription: post.metaDescription, canonicalUrl: post.canonicalUrl,
      ogTitle: post.ogTitle, ogDescription: post.ogDescription, noindex: post.noindex,
      targetKeyword: post.targetKeyword, secondaryKeywords: post.secondaryKeywords, searchIntent: post.searchIntent,
    }), 'Saved.')
  }

  const setStatus = async (status: string) => {
    const result = await action.run(() => send('post', `/content/posts/${postId}/status`, { status }),
      status === 'published' ? 'Published.' : 'Updated.')
    if (result !== undefined) await query.reload()
  }

  if (access === 'checking') return <SkeletonRows rows={5} columns={2} />
  if (access === 'denied') return <NotForYou />
  if (query.loading && !loaded) return <SkeletonRows rows={5} columns={2} />
  if (!post) return <Alert>{query.error ?? 'Not found.'}</Alert>

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
              placeholder={'## Why speed matters\n\nMost enquiries go to whoever replies first...\n\n- One\n- Two\n\n> A quote.'} />
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
        </Card>

        <Card title="Search" subtitle="How this appears in a result.">
          <Field label="SEO title" hint="Defaults to the article title."><input value={post.seoTitle ?? ''} onChange={(event) => set('seoTitle', event.target.value)} /></Field>
          <Field label="Meta description" hint={`${descriptionLength} characters — around 150 to 160 shows in full.`}>
            <textarea rows={3} value={post.metaDescription ?? ''} onChange={(event) => set('metaDescription', event.target.value)} />
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
        <Card title="Editorial notes" subtitle="For whoever writes next. Not published anywhere.">
          <Field label="Target keyword"><input value={post.targetKeyword ?? ''} onChange={(event) => set('targetKeyword', event.target.value)} /></Field>
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
      </aside>
    </div>
  </>
}
