import React from 'react'
import { ArrowUpRight, Building2, ChevronDown, Inbox, Plus, ShieldAlert, Timer } from 'lucide-react'
import { getOne, send } from '../api/client'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows } from '../components/ui'
import { HelpLink } from './HelpPage'
import { useAction, useApi } from '../hooks/useApi'

/**
 * The agency console.
 *
 * A triage board, not a portfolio. The instinct is a grid of client cards, all
 * equal weight, alphabetical — and with eighteen clients that means scanning
 * eighteen cards to find the two that matter, every single time.
 *
 * So clients that need attention rise to the top and say why; the rest collapse
 * into one line. The visual language is the same amber-and-green as the client
 * console one level down, because somebody working in both all day should not
 * have to learn two of them.
 */

interface ClientRow {
  id: string
  name: string
  memberCount: number
  accessMode: 'standing' | 'on_request'
  health: { contacts: number; unreadThreads: number; overdueSteps: number; unknownOutcomes: number }
}

export default function AgencyConsolePage() {
  const action = useAction()
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState('')
  const [ownerEmail, setOwnerEmail] = React.useState('')
  const [showQuiet, setShowQuiet] = React.useState(false)

  const query = useApi(async () => await getOne<{ agencyOrganizationId: string; clients: ClientRow[] }>('/hierarchy/agency/clients'), [])

  const createClient = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send('post', '/hierarchy/agency/clients', { name, ownerEmail }), 'Client workspace created.')
    if (result !== undefined) { setOpen(false); setName(''); setOwnerEmail(''); await query.reload() }
  }

  const enter = async (client: ClientRow) => {
    const result = await action.run(() => send<{ organizationId: string }>('post', '/hierarchy/switch', { organizationId: client.id }))
    // A successful switch reloads into that workspace: every request after this
    // is scoped to the client exactly as one of their own staff would be.
    if (result) window.location.assign('/dashboard')
  }

  if (query.loading) return <SkeletonRows rows={5} columns={3} />
  if (query.error) return <Alert>{query.error}</Alert>

  const clients = query.data?.clients ?? []
  const needsAttention = clients.filter((client) => client.health.overdueSteps || client.health.unknownOutcomes || client.health.unreadThreads)
  const quiet = clients.filter((client) => !needsAttention.includes(client))

  const totals = clients.reduce((sum, client) => ({
    unread: sum.unread + client.health.unreadThreads,
    overdue: sum.overdue + client.health.overdueSteps,
    unknown: sum.unknown + client.health.unknownOutcomes,
  }), { unread: 0, overdue: 0, unknown: 0 })

  return <>
    <PageHeader
      eyebrow="Agency"
      title="Your clients"
      description="Sorted by what needs you, not alphabetically."
      actions={<Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />
    <HelpLink route="/clients" />New client</Button>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    {/*
      One line across the top. The agency's equivalent of the day strip: a single
      glance decides whether to open the laptop.
    */}
    {clients.length > 0 && <Card className="agency-summary">
      <p className="eyebrow">Across your {clients.length} client{clients.length === 1 ? '' : 's'}</p>
      <p className="agency-summary-line">
        {totals.unread === 0 && totals.overdue === 0 && totals.unknown === 0
          ? 'Everything is running on its own.'
          : [
            totals.unread ? `${totals.unread} repl${totals.unread === 1 ? 'y' : 'ies'} waiting` : null,
            totals.overdue ? `${totals.overdue} step${totals.overdue === 1 ? '' : 's'} overdue` : null,
            totals.unknown ? `${totals.unknown} unknown outcome${totals.unknown === 1 ? '' : 's'}` : null,
          ].filter(Boolean).join(' · ')}
      </p>
    </Card>}

    {!clients.length ? <Card><EmptyState
      icon={<Building2 />}
      title="No clients yet"
      description="Create a client workspace and set it up for them. They never see a signup form or a card."
      action={<Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />New client</Button>}
    /></Card> : <>
      {needsAttention.length > 0 && <Card title="Needs you">
        <div className="client-list">
          {needsAttention.map((client) => <div key={client.id} className="client-row">
            <div className="client-name">
              <strong>{client.name}</strong>
              <span className="muted">{client.health.contacts} contacts · {client.memberCount} user{client.memberCount === 1 ? '' : 's'}</span>
            </div>
            {/* Each card says WHY. A red dot is not actionable; this is. */}
            <div className="client-signals">
              {client.health.unreadThreads > 0 && <span className="signal signal-amber"><Inbox size={13} />{client.health.unreadThreads} unread</span>}
              {client.health.overdueSteps > 0 && <span className="signal signal-amber"><Timer size={13} />{client.health.overdueSteps} overdue</span>}
              {client.health.unknownOutcomes > 0 && <span className="signal signal-red"><ShieldAlert size={13} />{client.health.unknownOutcomes} unknown</span>}
            </div>
            <Button size="sm" busy={action.loading} onClick={() => { void enter(client) }}>
              {client.accessMode === 'on_request' ? 'Request access' : 'Open'}<ArrowUpRight size={14} />
            </Button>
          </div>)}
        </div>
      </Card>}

      {quiet.length > 0 && <Card>
        <button type="button" className="quiet-toggle" onClick={() => setShowQuiet((current) => !current)}>
          <ChevronDown size={15} style={{ transform: showQuiet ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
          {quiet.length} client{quiet.length === 1 ? '' : 's'} running normally
        </button>
        {showQuiet && <div className="client-list quiet-list">
          {quiet.map((client) => <div key={client.id} className="client-row">
            <div className="client-name">
              <strong>{client.name}</strong>
              <span className="muted">{client.health.contacts} contacts</span>
            </div>
            <Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void enter(client) }}>
              {client.accessMode === 'on_request' ? 'Request access' : 'Open'}<ArrowUpRight size={14} />
            </Button>
          </div>)}
        </div>}
      </Card>}
    </>}

    <Modal
      open={open}
      title="New client workspace"
      description="You provision it, so they never see a signup form. Apply a starter pack afterwards to configure it in about a minute."
      onClose={() => setOpen(false)}
      footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="client-form" busy={action.loading}>Create</Button></>}
    >
      <form id="client-form" className="form-stack" onSubmit={createClient}>
        <Field label="Business name" required><input value={name} onChange={(event) => setName(event.target.value)} required autoFocus placeholder="Acme Plumbing" /></Field>
        <Field label="Owner email" hint="They will receive an invitation to sign in." required><input type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} required placeholder="owner@acme.com" /></Field>
      </form>
    </Modal>
  </>
}
