import React from 'react'
import { AlertTriangle, HelpCircle, Pause, Play, Plus, Send } from 'lucide-react'
import { getList, getOne, send } from '../api/client'
import { Link } from '../router'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { HelpLink } from './HelpPage'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'
import { usePermissions } from '../hooks/usePermissions'

interface SequenceRow extends UnknownRecord {
  id: string
  name: string
  description?: string
  status: string
  latestVersion: number
  publishedVersionId?: string | null
}

interface OperationsHealth {
  scheduledSteps: { pending: number; overdue: number; outcomeUnknown: number; failed: number }
  sends: { suppressed: number }
  note: string
}

export default function SequencesPage() {
  const { canOperate } = usePermissions()
  const action = useAction()
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState({ name: '', description: '' })

  const query = useApi(async () => (await getList<SequenceRow>('/sequences', ['sequences'])).items, [])
  const health = useApi(async () => await getOne<OperationsHealth>('/sequences/operations/health'), [])

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send('post', '/sequences', form), 'Sequence created as a draft.')
    if (result !== undefined) { setOpen(false); setForm({ name: '', description: '' }); await query.reload() }
  }

  const setStatus = async (sequence: SequenceRow, status: string) => {
    const result = await action.run(() => send('post', `/sequences/${sequence.id}/status`, { status }),
      status === 'active' ? `${sequence.name} is now sending.` : `${sequence.name} paused. Enrolments will exit rather than resume.`)
    if (result !== undefined) await query.reload()
  }

  return <>
    <PageHeader
      eyebrow="Follow-up engine"
      title="Sequences"
      description="Multi-step follow-up that waits reliably, respects quiet hours and stops the moment someone replies."
      actions={canOperate && <Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />New sequence</Button>}
      help={<HelpLink route="/sequences" />}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    {/*
      Steps whose outcome cannot be established are surfaced separately from
      failures and never folded into them. A failure can be retried; an unknown
      outcome means a message may already have reached a real person, and it
      needs a human rather than a retry.
    */}
    {Boolean(health.data?.scheduledSteps.outcomeUnknown) && <Alert tone="warning">
      <strong>{health.data!.scheduledSteps.outcomeUnknown} step(s) have an unknown send outcome.</strong> A message may already have been delivered. Resolve each one against the provider before re-sending — these are not failures and must not be retried blindly.
    </Alert>}

    {/*
      Hidden until a sequence exists.

      Five zeros above an empty state that already says there is nothing reads
      as a fault rather than as an absence, and it arrives before the operator
      has had any chance to learn what the five counts mean.
    */}
    {health.data && Boolean(query.data?.length) && <Card title="Scheduler health">
      <dl className="stat-row">
        <div><dt>Pending</dt><dd>{health.data.scheduledSteps.pending}</dd></div>
        <div><dt>Overdue</dt><dd className={health.data.scheduledSteps.overdue ? 'stat-warn' : ''}>{health.data.scheduledSteps.overdue}</dd></div>
        <div>
          {/*
            The one count an operator must never answer by retrying: the
            message may already have reached a real person.
          */}
          <dt title="We could not establish whether these were delivered. The message may already have arrived, so check with your provider before sending again — never simply retry.">
            Unknown outcome <HelpCircle size={12} aria-hidden="true" />
            <span className="sr-only">We could not establish whether these were delivered. The message may already have arrived, so check with your provider before sending again — never simply retry.</span>
          </dt>
          <dd className={health.data.scheduledSteps.outcomeUnknown ? 'stat-warn' : ''}>{health.data.scheduledSteps.outcomeUnknown}</dd>
        </div>
        <div><dt>Failed</dt><dd>{health.data.scheduledSteps.failed}</dd></div>
        <div><dt>Suppressed sends</dt><dd>{health.data.sends.suppressed}</dd></div>
      </dl>
    </Card>}

    {query.loading ? <SkeletonRows rows={4} columns={4} />
      : query.error ? <Alert>{query.error}</Alert>
        : query.data?.length ? <Card>
          <table className="data-table">
            <thead><tr><th>Sequence</th><th>Status</th><th>Version</th><th /></tr></thead>
            <tbody>{query.data.map((sequence) => <tr key={sequence.id}>
              <td><Link to={`/sequences/${sequence.id}`}><strong>{sequence.name}</strong></Link>{sequence.description && <div className="muted">{sequence.description}</div>}</td>
              <td><StatusBadge status={sequence.status === 'active' ? 'active' : sequence.status === 'paused' ? 'paused' : 'pending'} label={sequence.status} /></td>
              <td className="muted">{sequence.latestVersion ? `v${sequence.latestVersion}` : 'unpublished'}</td>
              <td className="row-actions">
                {sequence.status === 'active'
                  ? <Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void setStatus(sequence, 'paused') }}><Pause size={14} />Pause</Button>
                  : <Button size="sm" variant="ghost" busy={action.loading} disabled={!sequence.publishedVersionId} onClick={() => { void setStatus(sequence, 'active') }}><Play size={14} />Activate</Button>}
                <Link to={`/sequences/${sequence.id}`} className="row-link">Edit steps</Link>
              </td>
            </tr>)}</tbody>
          </table>
        </Card>
          : <Card><EmptyState icon={<Send />} title="No sequences yet" description="A sequence is a series of timed messages that stops automatically when someone replies." action={canOperate ? <Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />New sequence</Button> : undefined} /></Card>}

    {query.data?.some((sequence) => sequence.status !== 'active' && !sequence.publishedVersionId) && <Card>
      <p className="muted"><AlertTriangle size={14} /> A sequence needs published steps before it can be activated. Open it to add them.</p>
    </Card>}

    <Modal
      open={open}
      title="New sequence"
      description="Created as a draft. Nothing sends until you publish steps and activate it."
      onClose={() => setOpen(false)}
      footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="sequence-form" busy={action.loading}>Create</Button></>}
    >
      <form id="sequence-form" className="form-stack" onSubmit={create}>
        <Field label="Name" required><input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required autoFocus placeholder="Speed to lead" /></Field>
        <Field label="Description"><input value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></Field>
      </form>
    </Modal>
  </>
}
