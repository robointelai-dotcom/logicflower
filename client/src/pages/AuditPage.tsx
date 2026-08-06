import React from 'react'
import { ChevronRight, ClipboardList, Filter, Search, ShieldCheck } from 'lucide-react'
import { getList } from '../api/client'
import { Alert, Button, Card, EmptyState, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useApi } from '../hooks/useApi'
import type { AuditEvent, UnknownRecord } from '../types'
import { formatDate, titleCase } from '../utils/format'

async function loadAudit(query: string, action: string): Promise<AuditEvent[]> {
  const rows = (await getList<AuditEvent & UnknownRecord>('/organizations/current/audit', ['events', 'audit'], { params: { limit: 200 } })).items
  return rows.map((event) => {
    const actorType = String(event.actorType ?? 'user')
    const actorId = String(event.actorUserId ?? '')
    return { ...event, actorName: event.actorName ?? (actorType === 'system' ? 'System' : actorType === 'webhook' ? 'Verified webhook' : actorId ? `User ${actorId.slice(0, 8)}` : 'User'), entity: event.entity ?? String(event.entityType ?? '') }
  }).filter((event) => (action === 'all' || event.action.toLowerCase().includes(action)) && `${event.actorName ?? ''} ${event.actorEmail ?? ''} ${event.action} ${event.entity ?? ''}`.toLowerCase().includes(query.toLowerCase()))
}

export default function AuditPage() {
  const [search, setSearch] = React.useState('')
  const [actionFilter, setActionFilter] = React.useState('all')
  const [selected, setSelected] = React.useState<AuditEvent | null>(null)
  const query = useApi(() => loadAudit(search, actionFilter), [search, actionFilter])
  return <>
    <PageHeader eyebrow="Accountability" title="Audit log" description="Immutable workspace history for security, administrative and data-changing actions." />
    <Card className="security-note"><ShieldCheck size={21} /><div><strong>Audit records cannot be edited from this application.</strong><p>Sensitive values are redacted; actor, action, resource, time, IP and correlation metadata remain traceable.</p></div></Card>
    <Card><div className="table-toolbar"><div className="search-input"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search actor, action or resource" aria-label="Search audit log" /></div><div className="with-icon filter-select"><Filter size={16} /><select value={actionFilter} onChange={(event) => setActionFilter(event.target.value)}><option value="all">All actions</option><option value="auth">Authentication</option><option value="workflow">Workflows</option><option value="connection">Connections</option><option value="batch">Batch jobs</option><option value="member">Team access</option><option value="billing">Billing</option></select></div></div>{query.loading ? <SkeletonRows rows={8} columns={6} /> : query.error ? <Alert>{query.error}</Alert> : query.data?.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>IP address</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{query.data.map((event) => <tr key={event.id} className="clickable-row" onClick={() => setSelected(event)}><td>{formatDate(event.createdAt)}</td><td><strong>{event.actorName ?? event.actorEmail ?? 'System'}</strong>{event.actorName && <small className="table-subline">{event.actorEmail}</small>}</td><td><StatusBadge status="recorded" label={titleCase(event.action)} /></td><td>{event.entity ?? '—'}{event.entityId && <code className="table-subline">{event.entityId.slice(0, 12)}</code>}</td><td><code>{event.ipAddress ?? '—'}</code></td><td><button className="icon-button" aria-label="View audit event"><ChevronRight size={16} /></button></td></tr>)}</tbody></table></div> : <EmptyState icon={<ClipboardList />} title="No audit events found" description="Try changing the search or action filter." />}</Card>
    <Modal open={Boolean(selected)} title="Audit event" description={formatDate(selected?.createdAt)} onClose={() => setSelected(null)} wide footer={<Button onClick={() => setSelected(null)}>Close</Button>}>
      {selected && <div className="audit-detail"><dl><div><dt>Action</dt><dd>{titleCase(selected.action)}</dd></div><div><dt>Actor</dt><dd>{selected.actorName ?? 'System'}<small>{selected.actorEmail}</small></dd></div><div><dt>Resource</dt><dd>{selected.entity ?? '—'}<small>{selected.entityId}</small></dd></div><div><dt>IP address</dt><dd><code>{selected.ipAddress ?? '—'}</code></dd></div></dl><h3>Redacted metadata</h3><pre>{JSON.stringify(selected.metadata ?? {}, null, 2)}</pre></div>}
    </Modal>
  </>
}
