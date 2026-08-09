import React from 'react'
import { Activity, ArrowLeft, BookOpen, CheckCircle2, Home, LifeBuoy, LockKeyhole, RefreshCw, SearchX, ShieldCheck } from 'lucide-react'
import { Link } from '../router'
import { Alert, AppLogo, Button, Card } from '../components/ui'

function SystemPage({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return <div className="system-page"><AppLogo /><span>{icon}</span><h1>{title}</h1><p>{description}</p><div><Link className="button button-primary" to="/"><Home size={16} />Go to overview</Link><button className="button button-secondary" onClick={() => history.back()}><ArrowLeft size={16} />Go back</button></div></div>
}
export function ForbiddenPage() { return <SystemPage icon={<LockKeyhole />} title="You don’t have access" description="Your current workspace role does not permit this page. Ask a workspace owner if your responsibilities have changed." /> }
/**
 * The 404 page.
 *
 * nginx serves index.html for every unmatched path, so this page is delivered
 * with a 200 status — a "soft 404". Google treats those badly: junk URLs get
 * indexed and dilute the site.
 *
 * A real 404 status needs the server to know which paths exist, which means
 * prerendering or server rendering. Until then this at least tells crawlers not
 * to index the page, which removes most of the harm.
 */
export function NotFoundPage() {
  React.useEffect(() => {
    const tag = document.createElement('meta')
    tag.setAttribute('name', 'robots')
    tag.setAttribute('content', 'noindex, follow')
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, [])

  return <SystemPage
    icon={<SearchX />}
    title="Page not found"
    description="The page may have moved, or the link may be incomplete. Try the blog or the help centre."
  />
}

const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL || 'support@logicflower.com'

export function HelpCenterPage() {
  return <div className="public-info-page"><header><AppLogo /><div><Link to="/status">Service status</Link><Link to="/login">Sign in</Link></div></header><main><div className="public-hero"><BookOpen /><p>LogicFlower help centre</p><h1>From first connection to a safely approved run</h1><span>Short, operational guidance for workspace owners and operators.</span></div><div className="info-card-grid"><Card title="1. Secure the workspace" subtitle="Identity and access"><p>Invite each person with the smallest role they need. Owners and administrators should enable MFA before configuring production credentials.</p><Link className="button button-secondary" to="/settings">Open security settings</Link></Card><Card title="2. Connect and scan" subtitle="Provider access"><p>Authorize a provider, verify its health, then wait for the automatic read-only inventory scan. The scan reports duplicates and invalid contact identifiers without writing data.</p><Link className="button button-secondary" to="/connections">Open connections</Link></Card><Card title="3. Preview every change" subtitle="Workflow and batch safety"><p>Build only with approved structured nodes. Run the dry preview, review the impact hash, and type the explicit confirmation only when the exact plan is correct.</p><Link className="button button-secondary" to="/workflows">Open workflows</Link></Card><Card title="4. Monitor and recover" subtitle="Operations"><p>Configure at least one verified alert channel. Use incidents, execution history, failed-record exports and checkpoints to investigate without repeating uncertain writes.</p><Link className="button button-secondary" to="/monitoring">Open monitoring</Link></Card></div><Card title="Need human help?" subtitle="Include the correlation reference shown with any API error; never email passwords, tokens, raw customer exports or MFA codes."><div className="setting-row"><span className="setting-icon"><LifeBuoy /></span><div><strong>{supportEmail}</strong><p>Security issues should be marked “Security” in the subject so they enter the incident process.</p></div><a className="button button-primary" href={`mailto:${supportEmail}?subject=LogicFlower%20support`}>Email support</a></div></Card></main></div>
}

export function StatusPage() {
  const [state, setState] = React.useState<{ loading: boolean; ready?: boolean; dependencies?: Record<string, boolean>; error?: string }>({ loading: true })
  const load = React.useCallback(async () => {
    setState({ loading: true })
    try {
      const response = await fetch('/readyz', { credentials: 'same-origin', cache: 'no-store' })
      const body = await response.json() as { ready?: boolean; dependencies?: Record<string, boolean> }
      setState({ loading: false, ready: response.ok && Boolean(body.ready), dependencies: body.dependencies || {} })
    } catch { setState({ loading: false, ready: false, error: 'Status telemetry is currently unreachable.' }) }
  }, [])
  React.useEffect(() => { void load() }, [load])
  return <div className="public-info-page"><header><AppLogo /><div><Link to="/help">Help centre</Link><Link to="/login">Sign in</Link></div></header><main><div className="public-hero"><Activity /><p>Service status</p><h1>{state.loading ? 'Checking service dependencies…' : state.ready ? 'All core systems operational' : 'Service degradation detected'}</h1><span>Live readiness from the LogicFlower API. Provider-specific health is available inside each workspace.</span></div>{state.error && <Alert>{state.error}</Alert>}<Card title="Core platform" actions={<Button onClick={() => { void load() }} busy={state.loading}><RefreshCw size={15} />Refresh</Button>}><div className="status-dependency-list">{Object.entries(state.dependencies || { api: Boolean(state.ready) }).map(([name, ready]) => <div key={name}><span className="setting-icon">{ready ? <CheckCircle2 /> : <Activity />}</span><div><strong>{name}</strong><p>{ready ? 'Operational' : 'Unavailable or degraded'}</p></div><span className={ready ? 'success-text' : 'danger-text'}>{ready ? 'Operational' : 'Degraded'}</span></div>)}</div></Card><Card title="Security and incident reporting"><div className="setting-row"><span className="setting-icon"><ShieldCheck /></span><div><strong>Responsible disclosure</strong><p>Do not include customer data or credentials. Send a concise reproduction and impact summary.</p></div><a className="button button-secondary" href={`mailto:${supportEmail}?subject=Security%20report`}>Report an issue</a></div></Card></main></div>
}
