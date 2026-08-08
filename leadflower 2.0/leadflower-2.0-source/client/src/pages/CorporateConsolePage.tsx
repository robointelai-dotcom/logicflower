import React from 'react'
import { ArrowUpRight, Building2, Plus, ShieldAlert, Timer, Users } from 'lucide-react'
import { getOne, send } from '../api/client'
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

export default function CorporateConsolePage() {
  const action = useAction()
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState('')
  const [expanded, setExpanded] = React.useState<string | null>(null)

  const query = useApi(async () => await getOne<Portfolio>('/hierarchy/corporate/portfolio'), [])

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

  const data = query.data
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
