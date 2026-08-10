import React from 'react'
import { CheckCircle2, Copy, Download, Globe, Search } from 'lucide-react'
import { getOne, send } from '../api/client'
import { Alert, Button, Card, Field, PageHeader, SkeletonRows } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'

/**
 * Connecting the customer's own website.
 *
 * Three steps with a code, because the alternative — an API key — is forty
 * characters of base64 that gets truncated when pasted and cannot be read over
 * the phone to whoever looks after the site.
 *
 * The manual fallback is not second class. Some customers will never manage a
 * plugin install: no WP-Admin experience, a locked host, or an agency built the
 * site three years ago and holds the login. For them it is the only route.
 */

interface SiteState {
  connection: { siteUrl?: string; platform?: string; pluginVersion?: string; status: string; lastSeenAt?: string } | null
  website: string | null
  currentPluginVersion: string
  downloadUrl: string
}

export default function MyWebsitePage() {
  const action = useAction()
  const [code, setCode] = React.useState<string | null>(null)
  const [manual, setManual] = React.useState<any>(null)
  const [copied, setCopied] = React.useState(false)

  const site = useApi(async () => await getOne<SiteState>('/visibility/site'), [])
  const searchConsole = useApi(async () => await getOne<{ available: boolean; connection: any }>('/visibility/search-console'), [])

  /*
   * Poll while waiting.
   *
   * The operator pastes the code into WordPress in another tab. Making them
   * come back and press refresh to find out whether it worked is the kind of
   * small friction that turns a two-minute task into an abandoned one.
   */
  React.useEffect(() => {
    if (!code || site.data?.connection?.status === 'connected') return
    const timer = window.setInterval(() => { void site.reload() }, 4_000)
    return () => window.clearInterval(timer)
  }, [code, site])

  const generate = async () => {
    const result = await action.run(() => send<{ code: string }>('post', '/visibility/site/pairing-code', {}))
    if (result) setCode(result.code)
  }

  const loadManual = async () => {
    const result = await action.run(() => getOne<any>('/visibility/site/manual'))
    if (result) setManual(result)
  }

  const connectSearchConsole = async () => {
    const result = await action.run(() => send<{ url: string }>('post', '/visibility/search-console/start', {}))
    if (result?.url) window.location.assign(result.url)
  }

  if (site.loading) return <SkeletonRows rows={4} columns={2} />

  const connection = site.data?.connection
  const connected = connection?.status === 'connected'
  const outdated = connected && connection?.pluginVersion && connection.pluginVersion !== site.data?.currentPluginVersion

  return <>
    <PageHeader
      eyebrow="Getting found"
      title="My website"
      description="Connect your site so your business details and answers appear on it, and so we can tell which enquiries became work."
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}

    {connected ? <Card>
      <div className="connected-state">
        <CheckCircle2 size={22} />
        <div>
          <strong>Connected</strong>
          <span className="muted">{connection.siteUrl}</span>
        </div>
      </div>
      <ul className="plain-list">
        <li><strong>Your business details are live</strong><span className="muted">Search engines can read your hours, area and registrations</span></li>
        <li><strong>Your answers are available</strong><span className="muted">Add <code>[logicflower_questions]</code> to any page</span></li>
        <li><strong>Enquiries are being tracked</strong><span className="muted">Calls, directions and form fills</span></li>
      </ul>

      {/*
        Distributed as a download rather than through the WordPress directory,
        so there are no automatic updates. Telling the operator is the only way
        they find out.
      */}
      {outdated && <Alert tone="warning">
        A newer version of the plugin is available ({site.data!.currentPluginVersion}, you have {connection.pluginVersion}).
        {' '}<a href={site.data!.downloadUrl}>Download it</a> and upload it over the existing one.
      </Alert>}

      <Button variant="ghost" size="sm" busy={action.loading}
        onClick={() => { void action.run(() => send('post', '/visibility/site/disconnect', {}), 'Disconnected.').then(() => site.reload()) }}>
        Disconnect
      </Button>
    </Card> : <Card title="Connect your website">
      <ol className="connect-steps">
        <li>
          <strong>Download the plugin</strong>
          <a className="btn-inline" href={site.data?.downloadUrl} download><Download size={14} /> logicflower.zip</a>
        </li>
        <li>
          <strong>Install it in WordPress</strong>
          <span className="muted">Plugins → Add New → Upload Plugin → choose the file → Install → Activate</span>
        </li>
        <li>
          <strong>Paste this code into Settings → LogicFlower</strong>
          {code ? <>
            <span className="pairing-code">{code}</span>
            <span className="muted">Expires in 15 minutes. Waiting for your website to connect…</span>
          </> : <Button size="sm" busy={action.loading} onClick={() => { void generate() }}>Show my code</Button>}
        </li>
      </ol>

      <p className="muted connect-escape">
        Not comfortable doing this? Send these steps to whoever looks after your website — they will
        recognise all of it.
      </p>
    </Card>}

    {/* The fallback, from day one. For some customers it is the only route. */}
    <Card title="Not on WordPress?" subtitle="Shopify, Wix, Squarespace, or a site somebody built for you.">
      {manual ? <>
        <Field label="Paste this into the &lt;head&gt; of every page">
          <textarea rows={6} readOnly value={manual.schemaBlock} onFocus={(event) => event.target.select()} />
        </Field>
        <Button size="sm" onClick={() => {
          void navigator.clipboard.writeText(manual.schemaBlock)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 2_000)
        }}><Copy size={14} />{copied ? 'Copied' : 'Copy'}</Button>
        <p className="muted">{manual.instructions}</p>
      </> : <Button size="sm" busy={action.loading} onClick={() => { void loadManual() }}>
        <Globe size={14} />Show me what to paste
      </Button>}
    </Card>

    <Card title="Google Search Console" subtitle="Shows which searches brought people to you. Free, and it is your own account.">
      {searchConsole.data?.available === false
        // Two different problems, two different people. "We cannot" is for the
        // platform team; "you have not" is for the customer.
        ? <p className="muted">Not set up on this deployment yet. Ask your provider to configure it.</p>
        : searchConsole.data?.connection?.status === 'connected'
          ? <p><CheckCircle2 size={15} /> Connected to {searchConsole.data.connection.siteUrl}</p>
          : <>
            <p className="muted">This is not the same as your Google Business listing — it needs no approval, and you connect it yourself.</p>
            <Button size="sm" busy={action.loading} onClick={() => { void connectSearchConsole() }}>
              <Search size={14} />Connect Search Console
            </Button>
          </>}
      {searchConsole.data?.connection?.lastError && <Alert tone="warning">{searchConsole.data.connection.lastError}</Alert>}
    </Card>
  </>
}
