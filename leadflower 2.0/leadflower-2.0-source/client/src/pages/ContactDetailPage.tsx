import React from 'react'
import { ArrowLeft, Archive, FileText, MessageSquare, Paperclip, StickyNote } from 'lucide-react'
import { getOne, send } from '../api/client'
import { Link, useParams } from '../router'
import { Alert, Button, Card, EmptyState, Field, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'

interface ContactDetail {
  contact: {
    id: string
    name?: string
    firstName?: string
    lastName?: string
    companyName?: string
    email?: string
    phone?: string
    lifecycleStatus?: string
    tags?: string[]
    revenueMinorUnits?: number
    revenueCurrency?: string | null
    lastActivityAt?: string
    customFields?: Record<string, unknown>
  }
  undefinedCustomFieldKeys?: string[]
  notes: Array<{ id: string; body: string; createdAt: string }>
  enrolments: Array<{ id: string; sequenceId: string; status: string; stepIndex: number; nextDueAt?: string; exitReason?: string }>
  messages: Array<{ id: string; channel: string; status: string; recipientPreview?: string; sentAt?: string }>
  deals: Array<{ id: string; title: string; stageId: string; status: string; valueMinorUnits: number; currency: string }>
  attachments?: Array<{ id: string; fileName: string; sizeBytes: number; createdAt: string }>
  timeline: Array<{ id: string; type: string; summary: string; occurredAt: string }>
}

function money(minorUnits: number, currency?: string | null): string {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(minorUnits / 100) }
  catch { return `${(minorUnits / 100).toFixed(2)}` }
}

export default function ContactDetailPage() {
  const params = useParams()
  const contactId = params.id ?? ''
  const action = useAction()
  const [note, setNote] = React.useState('')

  const query = useApi(async () => contactId ? await getOne<ContactDetail>(`/crm/contacts/${contactId}`) : null, [contactId])

  const addNote = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!note.trim()) return
    const result = await action.run(() => send('post', `/crm/contacts/${contactId}/notes`, { body: note }), 'Note added.')
    if (result !== undefined) { setNote(''); await query.reload() }
  }

  const archive = async () => {
    const result = await action.run(() => send('post', `/crm/contacts/${contactId}/archive`, {}), 'Contact archived and removed from active sequences.')
    if (result !== undefined) await query.reload()
  }

  if (query.loading) return <SkeletonRows rows={6} columns={3} />
  if (query.error) return <Alert>{query.error}</Alert>
  if (!query.data) return <Card><EmptyState title="Contact not found" description="It may have been deleted." /></Card>

  const { contact } = query.data
  const name = contact.name?.trim() || [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || contact.companyName || 'Unnamed contact'

  return <>
    <p className="back-link"><Link to="/contacts"><ArrowLeft size={13} /> All contacts</Link></p>
    <PageHeader
      eyebrow="Micro-CRM"
      title={name}
      description={[contact.companyName, contact.email, contact.phone].filter(Boolean).join(' · ')}
      actions={<Button busy={action.loading} onClick={() => { void archive() }}><Archive size={15} />Archive</Button>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    {/*
      Values stored before a field was defined, or after one was removed. They
      are surfaced rather than hidden: silently dropping a customer's data to
      satisfy a newer rule is the wrong trade.
    */}
    {Boolean(query.data.undefinedCustomFieldKeys?.length) && <Alert tone="warning">
      This contact carries values for fields that are no longer defined: {query.data.undefinedCustomFieldKeys!.join(', ')}. Define them, or clear them from the record.
    </Alert>}

    <div className="detail-grid">
      <div className="detail-main">
        <Card title="Activity timeline" subtitle="Everything that has happened to this person, newest first.">
          {query.data.timeline.length ? <ol className="timeline">
            {query.data.timeline.map((entry) => <li key={entry.id}>
              <span className="timeline-type">{entry.type}</span>
              <p>{entry.summary}</p>
              <time>{new Date(entry.occurredAt).toLocaleString()}</time>
            </li>)}
          </ol> : <EmptyState title="Nothing yet" description="Messages, deals, tasks and payments will appear here." />}
        </Card>

        <Card title="Messages" subtitle="Across every channel. Content lives in the inbox; this is delivery state.">
          {query.data.messages.length ? <table className="data-table">
            <thead><tr><th>Channel</th><th>To</th><th>Status</th><th>Sent</th></tr></thead>
            <tbody>{query.data.messages.map((message) => <tr key={message.id}>
              <td>{message.channel}</td>
              <td className="muted">{message.recipientPreview}</td>
              <td><StatusBadge status={message.status === 'delivered' || message.status === 'sent' ? 'active' : message.status === 'bounced' || message.status === 'failed' ? 'failed' : 'pending'} label={message.status} /></td>
              <td className="muted">{message.sentAt ? new Date(message.sentAt).toLocaleString() : '—'}</td>
            </tr>)}</tbody>
          </table> : <EmptyState icon={<MessageSquare />} title="No messages" description="Nothing has been sent to this contact yet." />}
        </Card>

        <Card title="Notes">
          <form className="form-stack" onSubmit={addNote}>
            <Field label="Add a note"><textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What happened?" /></Field>
            <Button variant="primary" type="submit" busy={action.loading} disabled={!note.trim()}><StickyNote size={15} />Add note</Button>
          </form>
          {query.data.notes.map((entry) => <article key={entry.id} className="note">
            <p>{entry.body}</p>
            <time className="muted">{new Date(entry.createdAt).toLocaleString()}</time>
          </article>)}
        </Card>
      </div>

      <aside className="detail-side">
        <Card title="Summary">
          <dl className="summary-list">
            <div><dt>Status</dt><dd>{contact.lifecycleStatus ?? 'lead'}</dd></div>
            <div><dt>Revenue</dt><dd>{money(Number(contact.revenueMinorUnits ?? 0), contact.revenueCurrency)}</dd></div>
            <div><dt>Last activity</dt><dd>{contact.lastActivityAt ? new Date(contact.lastActivityAt).toLocaleDateString() : '—'}</dd></div>
          </dl>
          {Boolean(contact.tags?.length) && <div className="chip-row">{contact.tags!.map((tag) => <span key={tag} className="chip">{tag}</span>)}</div>}
        </Card>

        <Card title="Sequences">
          {query.data.enrolments.length ? <ul className="plain-list">
            {query.data.enrolments.map((enrolment) => <li key={enrolment.id}>
              <StatusBadge status={enrolment.status === 'active' ? 'active' : enrolment.status === 'completed' ? 'completed' : 'paused'} label={enrolment.status} />
              <span className="muted">Step {enrolment.stepIndex + 1}{enrolment.exitReason ? ` · exited: ${enrolment.exitReason}` : enrolment.nextDueAt ? ` · next ${new Date(enrolment.nextDueAt).toLocaleString()}` : ''}</span>
            </li>)}
          </ul> : <p className="muted">Not enrolled in any sequence.</p>}
        </Card>

        <Card title="Deals">
          {query.data.deals.length ? <ul className="plain-list">
            {query.data.deals.map((deal) => <li key={deal.id}><strong>{deal.title}</strong><span className="muted">{money(deal.valueMinorUnits, deal.currency)} · {deal.status}</span></li>)}
          </ul> : <p className="muted">No deals.</p>}
        </Card>

        <Card title="Files">
          {query.data.attachments?.length ? <ul className="plain-list">
            {query.data.attachments.map((file) => <li key={file.id}>
              <Paperclip size={13} /> <span>{file.fileName}</span>
              <span className="muted">{Math.max(1, Math.round(file.sizeBytes / 1024))} KB</span>
            </li>)}
          </ul> : <p className="muted"><FileText size={13} /> No files attached.</p>}
        </Card>
      </aside>
    </div>
  </>
}
