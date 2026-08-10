import React from 'react'
import { ArrowUpRight, Building2, KeyRound, Plus, ShieldAlert, Timer, Users } from 'lucide-react'
import { ApiError, getOne, send } from '../api/client'
import { Link } from '../router'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'

/**
 * The corporate console.
 *
 * Answers: is the business growing, and is anything on fire? Opened once a day
 * and glanced at, so it leads with counts and shows only what is genuinely the
 * platform operator's liability — a scheduler that has stopped, sends whose
 * outcome nobody can establish.
 *
 * It shows no customer data of any kind. Organisation names and counts only.
 * The moment a corporate console displays a contact name it becomes something
 * that would be hard to defend to a customer.
 */

interface Portfolio {
  totals: { agencies: number; clientsViaAgencies: number; directClients: number; allWorkspaces: number }
  estate: { overdueSteps: number; unknownOutcomes: number; unreadThreads: number }
  agencies: Array<{
    agency: { id: string; name: string; memberCount: number }
    clientCount: number
    needsAttention: number
    clients: Array<{ id: string; name: string; memberCount: number }>
  }>
  unaffiliatedClients: Array<{ id: string; name: string; memberCount: number }>
}

/**
 * The one refusal this screen handles itself.
 *
 * Platform administration demands a second factor, and that guard is correct —
 * a stolen platform password must not be enough to enumerate every tenant. But
 * the refusal was rendered straight from the API problem response, so an
 * operator saw a sentence of internal vocabulary and a bare correlation id,
 * with no instruction, no link, and no indication of what Estate would show if
 * they did enrol. They could not tell whether it was worth the trouble.
 *
 * Nothing here weakens the requirement. Only its presentation changes.
 */
function isMfaRefusal(error: unknown): error is ApiError {
  if (!(error instanceof ApiError) || error.status !== 403) return false
  const problem = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : undefined
  return typeof problem?.type === 'string' && problem.type.endsWith('/mfa-required')
}

type PortfolioResult =
  | { blocked: true; correlationId?: string }
  | { blocked: false; portfolio: Portfolio }

export default function CorporateConsolePage() {
  const action = useAction()
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState('')
  const [expanded, setExpanded] = React.useState<string | null>(null)

  const query = useApi(async (): Promise<PortfolioResult> => {
    try {
      return { blocked: false, portfolio: await getOne<Portfolio>('/hierarchy/corporate/portfolio') }
    } catch (error) {
      if (isMfaRefusal(error)) return { blocked: true, correlationId: error.correlationId }
      throw error
    }
  }, [])

  const createAgency = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send('post', '/hierarchy/corporate/agencies', { name }), 'Agency created.')
    if (result !== undefined) { setOpen(false); setName(''); await query.reload() }
  }

  const enter = async (organizationId: string) => {
    const result = await action.run(() => send('post', '/hierarchy/switch', { organizationId }))
    if (result !== undefined) window.location.assign('/dashboard')
  }

  if (query.loading) return <SkeletonRows rows={5} columns={4} />
  if (query.error) return <Alert>{query.error}</Alert>

  if (query.data?.blocked) return <>
    <PageHeader
      eyebrow="Corporate"
      title="Estate"
      description="Every agency and workspace on the platform. Counts and health only — never customer data."
    />
    <Card className="mfa-wall">
      <span className="mfa-wall-icon"><KeyRound size={22} /></span>
      <h2>Turn on two-step sign-in to open Estate</h2>
      <p>
        Estate is the platform view: how many agencies and workspaces exist, how many users each
        has, and whether anything across the estate needs attention — a scheduler that has stopped,
        or sends whose outcome nobody can establish. It shows no customer data of any kind.
      </p>
      <p>
        Because it lists every business on the platform, a password on its own is not enough to
        open it. With two-step sign-in a stolen password cannot be used to enumerate your customers.
      </p>
      <p className="mfa-wall-actions">
        <Link className="button button-primary" to="/mfa-setup">Set up two-step sign-in</Link>
      </p>
      {query.data.correlationId && <small className="mfa-wall-reference">Reference: {query.data.correlationId}</small>}
    </Card>
  </>

  const data = query.data?.portfolio
  const estate = data?.estate
  const onFire = (estate?.overdueSteps ?? 0) + (estate?.unknownOutcomes ?? 0)

  return <>
    <PageHeader
      eyebrow="Corporate"
      title="Estate"
      description="Every agency and workspace on the platform. Counts and health only — never customer data."
      actions={<Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />New agency</Button>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    <div className="console-split">
      <Card>
        <header className="card-head"><span className="eyebrow">Estate</span></header>
        <dl className="stat-row">
          <div><dt>Agencies</dt><dd>{data?.totals.agencies ?? 0}</dd></div>
          <div><dt>Clients via agencies</dt><dd>{data?.totals.clientsViaAgencies ?? 0}</dd></div>
          <div><dt>Direct clients</dt><dd>{data?.totals.directClients ?? 0}</dd></div>
          <div><dt>All workspaces</dt><dd>{data?.totals.allWorkspaces ?? 0}</dd></div>
        </dl>
      </Card>

      <Card>
        <header className="card-head"><span className="eyebrow">Needs attention</span>{onFire > 0 && <span className="head-count">{onFire}</span>}</header>
        {/*
          Only what is the platform operator's own liability. Unread replies are
          a customer's problem to handle; a stopped scheduler is ours.
        */}
        {onFire === 0
          ? <p className="muted">Nothing across the estate needs platform attention.</p>
          : <dl className="running-list">
            {Boolean(estate?.overdueSteps) && <div><dt><Timer size={15} />Steps overdue</dt><dd className="stat-warn">{estate!.overdueSteps}</dd></div>}
            {Boolean(estate?.unknownOutcomes) && <div><dt><ShieldAlert size={15} />Unknown send outcomes</dt><dd className="stat-warn">{estate!.unknownOutcomes}</dd></div>}
          </dl>}
        <p className="muted" style={{ marginTop: '.75rem' }}>
          <Link to="/access-ledger">Who has access to customer data →</Link>
        </p>
      </Card>
    </div>

    <Card title="Agencies">
      {!data?.agencies.length ? <EmptyState icon={<Building2 />} title="No agencies yet" description="Create one, then it can provision its own client workspaces." />
        : <div className="client-list">
          {data.agencies.map((entry) => <div key={entry.agency.id}>
            <div className="client-row">
              <div className="client-name">
                <strong>{entry.agency.name}</strong>
                <span className="muted">{entry.clientCount} client{entry.clientCount === 1 ? '' : 's'} · {entry.agency.memberCount} user{entry.agency.memberCount === 1 ? '' : 's'}</span>
              </div>
              <div className="client-signals">
                {entry.needsAttention > 0
                  ? <span className="signal signal-amber">{entry.needsAttention} need help</span>
                  : <span className="signal signal-green">All running</span>}
              </div>
              <Button size="sm" variant="ghost" onClick={() => setExpanded((current) => current === entry.agency.id ? null : entry.agency.id)}>
                {expanded === entry.agency.id ? 'Hide clients' : 'Show clients'}
              </Button>
              <Button size="sm" busy={action.loading} onClick={() => { void enter(entry.agency.id) }}>Open<ArrowUpRight size={14} /></Button>
            </div>
            {expanded === entry.agency.id && <div className="client-list quiet-list">
              {entry.clients.map((client) => <div key={client.id} className="client-row">
                <div className="client-name"><strong>{client.name}</strong><span className="muted">{client.memberCount} user{client.memberCount === 1 ? '' : 's'}</span></div>
                <Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void enter(client.id) }}>Open<ArrowUpRight size={14} /></Button>
              </div>)}
              {!entry.clients.length && <p className="muted">No clients yet.</p>}
            </div>}
          </div>)}
        </div>}
    </Card>

    {/* Direct signups belong to no agency and would otherwise be invisible. */}
    <Card title="Direct signups" subtitle="Businesses that joined without an agency.">
      {!data?.unaffiliatedClients.length ? <p className="muted">None yet.</p>
        : <div className="client-list">
          {data.unaffiliatedClients.map((client) => <div key={client.id} className="client-row">
            <div className="client-name"><strong>{client.name}</strong><span className="muted"><Users size={13} /> {client.memberCount} user{client.memberCount === 1 ? '' : 's'}</span></div>
            <Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void enter(client.id) }}>Open<ArrowUpRight size={14} /></Button>
          </div>)}
        </div>}
    </Card>

    <Modal
      open={open}
      title="New agency"
      description="An agency provisions and manages its own client workspaces."
      onClose={() => setOpen(false)}
      footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="agency-form" busy={action.loading}>Create</Button></>}
    >
      <form id="agency-form" className="form-stack" onSubmit={createAgency}>
        <Field label="Agency name" required><input value={name} onChange={(event) => setName(event.target.value)} required autoFocus placeholder="Robointech" /></Field>
      </form>
    </Modal>
  </>
}
