import React from 'react'
import { Clock, Eye, ShieldCheck } from 'lucide-react'
import { getOne, send } from '../api/client'
import { Alert, Button, Card, EmptyState, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { HelpLink } from './HelpPage'
import { useAction, useApi } from '../hooks/useApi'

/**
 * Who can see this workspace's data, right now.
 *
 * Written for the customer, not for us. It answers the question a cautious buyer
 * actually asks — "who outside my business can read my contacts?" — and lets
 * them end it in one click.
 *
 * Readable by any member rather than administrators only. Everybody in a
 * business is entitled to know who from outside can reach their data; gating
 * that behind a role would undercut the point of showing it.
 */

interface AccessRequest {
  id: string
  requestedBy: string
  reason: string
  status: string
  dataAccessEnabled: boolean
  expiresAt: string
  revokedAt: string | null
  useCount: number
  lastUsedAt: string | null
  createdAt: string
}

function remaining(expiresAt: string): string {
  const minutes = Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000)
  if (minutes <= 0) return 'expired'
  if (minutes < 60) return `${minutes} minutes left`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m left`
}

export default function AccessLedgerPage() {
  const action = useAction()
  const query = useApi(async () => await getOne<{ requests: AccessRequest[]; note: string }>('/hierarchy/support-access'), [])

  const decide = async (request: AccessRequest, decision: 'approved' | 'rejected') => {
    const result = await action.run(() => send('post', `/hierarchy/support-access/${request.id}/decision`, { decision, hours: 4 }),
      decision === 'approved' ? 'Access granted for four hours.' : 'Request declined.')
    if (result !== undefined) await query.reload()
  }

  const revoke = async (request: AccessRequest) => {
    const result = await action.run(() => send('post', `/hierarchy/support-access/${request.id}/revoke`, {}), 'Access withdrawn.')
    if (result !== undefined) await query.reload()
  }

  if (query.loading) return <SkeletonRows rows={4} columns={3} />
  if (query.error) return <Alert>{query.error}</Alert>

  const requests = query.data?.requests ?? []
  const live = requests.filter((request) => request.status === 'approved' && request.dataAccessEnabled && new Date(request.expiresAt) > new Date())
  const pending = requests.filter((request) => request.status === 'pending')
  const past = requests.filter((request) => !live.includes(request) && !pending.includes(request))

  return <>
    <PageHeader
      eyebrow="Privacy"
      title="Who can see your data"
      description="Nobody outside your business can open this workspace unless you allow it, and every approval expires on its own."
    />
    <HelpLink route="/access-ledger" />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    {pending.length > 0 && <Card title="Waiting for your decision">
      <div className="client-list">
        {pending.map((request) => <div key={request.id} className="client-row">
          <div className="client-name">
            <strong>{request.requestedBy}</strong>
            <span className="muted">{request.reason}</span>
          </div>
          <div className="row-actions">
            <Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void decide(request, 'rejected') }}>Decline</Button>
            <Button size="sm" variant="primary" busy={action.loading} onClick={() => { void decide(request, 'approved') }}>Allow for 4 hours</Button>
          </div>
        </div>)}
      </div>
    </Card>}

    <Card title="Access right now">
      {!live.length ? <div className="all-clear">
        <ShieldCheck size={28} />
        <p>Nobody outside your business has access</p>
        <span className="muted">If someone needs to look at your workspace to help you, they have to ask, and you decide.</span>
      </div> : <div className="client-list">
        {live.map((request) => <div key={request.id} className="client-row">
          <div className="client-name">
            <strong>{request.requestedBy}</strong>
            <span className="muted">{request.reason}</span>
          </div>
          <div className="client-signals">
            <span className="signal signal-amber"><Clock size={13} />{remaining(request.expiresAt)}</span>
            {/*
              A count of requests made, not just "logged in once". It lets a
              customer compare what was done against the reason given.
            */}
            <span className="signal"><Eye size={13} />{request.useCount} request{request.useCount === 1 ? '' : 's'}</span>
          </div>
          <Button size="sm" busy={action.loading} onClick={() => { void revoke(request) }}>Withdraw</Button>
        </div>)}
      </div>}
    </Card>

    {past.length > 0 && <Card title="Earlier" subtitle="Kept so you can check what happened and when.">
      <table className="data-table">
        <thead><tr><th>Who</th><th>Reason</th><th>Outcome</th><th>Used</th><th>When</th></tr></thead>
        <tbody>{past.map((request) => <tr key={request.id}>
          <td>{request.requestedBy}</td>
          <td className="muted">{request.reason}</td>
          <td><StatusBadge status={request.status === 'revoked' ? 'failed' : request.status === 'rejected' ? 'paused' : 'completed'} label={request.status} /></td>
          <td className="muted">{request.useCount}</td>
          <td className="muted">{new Date(request.createdAt).toLocaleDateString()}</td>
        </tr>)}</tbody>
      </table>
    </Card>}

    {!requests.length && <Card><EmptyState
      icon={<ShieldCheck />}
      title="No one has ever requested access"
      description="Requests appear here for you to allow or decline. Nothing is granted without you."
    /></Card>}

    <p className="muted ledger-note">{query.data?.note}</p>
  </>
}
