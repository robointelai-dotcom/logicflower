import React from 'react'
import { PhoneCall, PhoneOff, ShieldAlert } from 'lucide-react'
import { getList, getOne, send } from '../api/client'
import { Link } from '../router'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { HelpLink } from './HelpPage'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'
import { usePermissions } from '../hooks/usePermissions'

interface VoiceStatus {
  providers: {
    telephony: { implemented: boolean; documentationNeeded: string }
    conversation: { implemented: boolean; documentationNeeded: string }
    note: string
  }
  dialer: { enabled: boolean; dryRun: boolean; note: string }
  callingPolicy: {
    label: string
    window: { startMinute: number; endMinute: number; permittedWeekdays: number[] }
    widerThanDefault: boolean
    legalReviewRecordedBy: string | null
  }
}

interface AgentRow extends UnknownRecord { id: string; name: string; status: string; latestVersion: number; publishedVersionId?: string | null }
interface CallRow extends UnknownRecord {
  id: string; status: string; blockedReason?: string; toNumberPreview?: string
  durationSeconds: number; optedOutAt?: string | null; startedAt?: string
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export default function VoicePage() {
  const { canOperate } = usePermissions()
  const action = useAction()
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState('')

  const status = useApi(async () => await getOne<VoiceStatus>('/voice/status'), [])
  const agents = useApi(async () => (await getList<AgentRow>('/voice/agents', ['agents'])).items, [])
  const calls = useApi(async () => (await getList<CallRow>('/voice/calls', ['calls'])).items, [])

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send('post', '/voice/agents', { name }), 'Agent created as a draft.')
    if (result !== undefined) { setOpen(false); setName(''); await agents.reload() }
  }

  const policy = status.data?.callingPolicy

  return <>
    <PageHeader
      eyebrow="AI voice"
      title="Calling"
      description="Every call passes suppression, consent, do-not-call and calling-window checks before it is placed."
      actions={canOperate && <Button variant="primary" onClick={() => setOpen(true)}>New agent</Button>}
    />
    <HelpLink route="/voice" />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    {/*
      The two facts an operator most needs before trusting this screen: no
      provider exists, and the dialer is in dry run. Both are stated first
      rather than inferred from an empty call list.
    */}
    {status.data && !status.data.providers.telephony.implemented && <Alert tone="warning">
      <strong>No calling provider is connected.</strong> {status.data.providers.note}
    </Alert>}
    {status.data?.dialer.dryRun && <Alert tone="info">
      <strong>Dry run is on.</strong> Every regulatory check runs and every decision is recorded to the audit trail, and no call is placed. This is the safe way to see which of your contacts would be called, and why.
    </Alert>}

    {policy && <Card title="Calling policy" subtitle="Calls outside this window are deferred, not dropped.">
      <dl className="stat-row">
        <div><dt>Window</dt><dd>{clock(policy.window.startMinute)}–{clock(policy.window.endMinute)} local</dd></div>
        <div><dt>Days</dt><dd>{policy.window.permittedWeekdays.map((day) => DAYS[day]).join(', ')}</dd></div>
        <div><dt>Jurisdiction</dt><dd>{policy.label}</dd></div>
      </dl>
      {policy.widerThanDefault && !policy.legalReviewRecordedBy && <Alert tone="error">
        <ShieldAlert size={15} /> This window is wider than the conservative default and no legal review is recorded against it. Every call will be blocked until a named reviewer is recorded.
      </Alert>}
      {policy.legalReviewRecordedBy && <p className="muted">Legal position reviewed by {policy.legalReviewRecordedBy}.</p>}
    </Card>}

    <Card title="Agents">
      {agents.loading ? <SkeletonRows rows={3} columns={3} />
        : agents.data?.length ? <table className="data-table">
          <thead><tr><th>Agent</th><th>Status</th><th>Version</th></tr></thead>
          <tbody>{agents.data.map((agent) => <tr key={agent.id}>
            <td><Link to={`/voice/agents/${agent.id}`}><strong>{agent.name}</strong></Link></td>
            <td><StatusBadge status={agent.status === 'active' ? 'active' : agent.status === 'paused' ? 'paused' : 'pending'} label={agent.status} /></td>
            <td className="muted">{agent.latestVersion ? `v${agent.latestVersion}` : 'unpublished'}</td>
          </tr>)}</tbody>
        </table> : <EmptyState icon={<PhoneCall />} title="No agents" description="An agent is a script plus the disclosures every call must open with." />}
    </Card>

    <Card title="Calls" subtitle="Blocked calls are recorded with the reason, so you can see what your configuration refuses.">
      {calls.loading ? <SkeletonRows rows={3} columns={4} />
        : calls.data?.length ? <table className="data-table">
          <thead><tr><th>To</th><th>Status</th><th>Reason</th><th>Duration</th></tr></thead>
          <tbody>{calls.data.map((call) => <tr key={call.id}>
            <td className="muted">{call.toNumberPreview ?? '—'}</td>
            <td><StatusBadge status={call.status === 'completed' ? 'completed' : call.status === 'blocked' ? 'paused' : call.status === 'failed' ? 'failed' : 'pending'} label={call.status} /></td>
            <td className="muted">{call.optedOutAt ? <><PhoneOff size={13} /> Opted out mid-call</> : call.blockedReason ?? '—'}</td>
            <td className="muted">{call.durationSeconds ? `${call.durationSeconds}s` : '—'}</td>
          </tr>)}</tbody>
        </table> : <EmptyState icon={<PhoneCall />} title="No calls" description="Queue one from a contact once an agent is active." />}
    </Card>

    <Modal
      open={open}
      title="New voice agent"
      description="Created as a draft. Publish a version with its script and disclosures before activating."
      onClose={() => setOpen(false)}
      footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="agent-form" busy={action.loading}>Create</Button></>}
    >
      <form id="agent-form" className="form-stack" onSubmit={createAgent}>
        <Field label="Agent name" required><input value={name} onChange={(event) => setName(event.target.value)} required autoFocus placeholder="Missed enquiry callback" /></Field>
      </form>
    </Modal>
  </>
}
