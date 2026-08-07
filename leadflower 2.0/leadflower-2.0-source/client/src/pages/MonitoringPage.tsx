import React from 'react'
import { Activity, AlertTriangle, CheckCircle2, ChevronRight, Clock3, Database, HeartPulse, Plug, RefreshCw, Server, Siren } from 'lucide-react'
import { getList, getOne, send } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, Button, Card, EmptyState, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { Incident, UnknownRecord } from '../types'
import { formatDate } from '../utils/format'

interface HealthCheck extends UnknownRecord { id: string; name: string; provider?: string; status: string; latencyMs?: number; message?: string; checkedAt?: string }
interface MonitorData { overall: string; checks: HealthCheck[]; incidents: Incident[] }

async function loadMonitoring(): Promise<MonitorData> {
  const [summary, incidents] = await Promise.allSettled([
    getOne<UnknownRecord>('/monitoring/health'), getList<Incident & UnknownRecord>('/monitoring/incidents', ['incidents']),
  ])
  if (summary.status === 'rejected' && incidents.status === 'rejected') throw summary.reason
  const body = summary.status === 'fulfilled' ? summary.value : {}
  const checksRaw = Array.isArray(body.checks) ? body.checks : Array.isArray(body.connections) ? body.connections : []
  const checks = checksRaw.map((value, index) => { const item = value as UnknownRecord; const rawStatus = String(item.status ?? 'unknown'); return { ...item, id: String(item.id ?? item._id ?? item.key ?? index), name: String(item.name ?? item.label ?? item.provider ?? item.key ?? 'Service'), provider: typeof item.provider === 'string' ? item.provider : undefined, status: rawStatus === 'active' ? 'healthy' : ['degraded', 'error'].includes(rawStatus) ? 'attention' : rawStatus, latencyMs: typeof item.latencyMs === 'number' ? item.latencyMs : undefined, message: typeof item.message === 'string' ? item.message : typeof item.lastError === 'string' ? item.lastError : undefined, checkedAt: typeof item.checkedAt === 'string' ? item.checkedAt : typeof item.lastHealthyAt === 'string' ? item.lastHealthyAt : undefined } })
  const incidentRows = incidents.status === 'fulfilled' ? incidents.value.items.map((incident) => ({ ...incident, source: incident.source ?? String((incident as UnknownRecord).provider ?? 'Platform monitor'), message: incident.message ?? String((incident as UnknownRecord).description ?? '') })) : []
  const hasAttention = checks.some((check) => ['attention', 'error', 'degraded'].includes(check.status)) || Number(body.openIncidents ?? 0) > 0
  return { overall: String(body.status ?? body.overall ?? (hasAttention ? 'degraded' : checks.length ? 'healthy' : 'unknown')), checks, incidents: incidentRows }
}

function checkIcon(name: string) { const lower = name.toLowerCase(); return lower.includes('database') ? <Database /> : lower.includes('queue') || lower.includes('worker') ? <Server /> : lower.includes('connection') || lower.includes('platform') ? <Plug /> : <Activity /> }

export default function MonitoringPage() {
  const { session } = useAuth()
  const query = useApi(loadMonitoring, [])
  const action = useAction()
  const [selected, setSelected] = React.useState<Incident | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const inspect = async (incident: Incident) => { setSelected(incident); setDetailLoading(true); const detail = await action.run(() => getOne<Incident>(`/monitoring/incidents/${incident.id}`)); if (detail) setSelected(detail); setDetailLoading(false) }
  const transition = async (incident: Incident, status: 'acknowledged' | 'resolved') => { await action.run(() => send('patch', `/monitoring/incidents/${incident.id}`, { status }), `Incident ${status}.`); setSelected(null); await query.reload() }
  const runMonitor = async (check: HealthCheck) => { if (!check.provider) return; const result = await action.run(() => send('post', '/monitoring/run', { connectionId: check.id, provider: check.provider }), `Health check queued for ${check.name}.`); if (result !== undefined) window.setTimeout(() => { void query.reload() }, 1500) }
  const open = query.data?.incidents.filter((incident) => incident.status !== 'resolved') ?? []
  const canOperate = ['owner', 'admin', 'operator'].includes(session?.organization?.role ?? '')

  return <>
    <PageHeader eyebrow="Reliability" title="Monitoring & incidents" description="Connection, worker and workflow health with a complete incident timeline." actions={<Button onClick={() => { void query.reload() }} busy={query.loading}><RefreshCw size={16} />Refresh</Button>} />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}{action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}
    {query.loading && !query.data ? <SkeletonRows rows={5} columns={4} /> : query.error ? <Alert>{query.error}</Alert> : <>
      <div className={`overall-health overall-${query.data?.overall}`}><span>{query.data?.overall === 'healthy' ? <CheckCircle2 /> : <AlertTriangle />}</span><div><p>Connected-platform health</p><h2>{query.data?.overall === 'healthy' ? 'Connections healthy' : 'Attention required'}</h2><small>Based on current connection state and unresolved monitoring incidents.</small></div><StatusBadge status={query.data?.overall ?? 'unknown'} /></div>
      {query.data?.checks.length ? <div className="health-grid">{query.data.checks.map((check) => <Card key={check.id} className="health-card"><div className="health-card-head"><span>{checkIcon(check.name)}</span><StatusBadge status={check.status} /></div><h2>{check.name}</h2><p>{check.message ?? 'No connection error reported.'}</p><div><span>{check.latencyMs !== undefined ? `${check.latencyMs} ms` : 'Latency not recorded'}</span><span>{formatDate(check.checkedAt)}</span></div>{canOperate && check.provider && <Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void runMonitor(check) }}><RefreshCw size={14} />Run check</Button>}</Card>)}</div> : <Card><EmptyState icon={<Plug />} title="No monitorable connections" description="Connect a supported platform to begin connection health monitoring." /></Card>}
      <Card title="Incident queue" subtitle={`${open.length} issue${open.length === 1 ? '' : 's'} currently require attention`}>
        {query.data?.incidents.length ? <div className="incident-table">{query.data.incidents.map((incident) => <button key={incident.id} onClick={() => { void inspect(incident) }}><span className={`incident-severity severity-${incident.severity}`}><Siren size={17} /></span><div><strong>{incident.title}</strong><small>{incident.source ?? 'Platform monitor'} · {formatDate(incident.createdAt)}</small></div><StatusBadge status={incident.severity} /><StatusBadge status={incident.status} /><ChevronRight size={16} /></button>)}</div> : <EmptyState icon={<HeartPulse />} title="No incidents recorded" description="Detected failures and health anomalies will be tracked here." />}
      </Card>
    </>}
    <Modal open={Boolean(selected)} title={selected?.title ?? 'Incident'} description={`${selected?.source ?? 'LogicFlower monitor'} · opened ${formatDate(selected?.createdAt)}`} onClose={() => setSelected(null)} wide footer={selected && <><Button onClick={() => setSelected(null)}>Close</Button>{canOperate && selected.status === 'open' && <Button onClick={() => { void transition(selected, 'acknowledged') }}>Acknowledge</Button>}{canOperate && selected.status !== 'resolved' && <Button variant="primary" onClick={() => { void transition(selected, 'resolved') }}>Mark resolved</Button>}</>}>
      {detailLoading || !selected ? <SkeletonRows rows={4} columns={2} /> : <div className="incident-detail"><div className="incident-detail-head"><StatusBadge status={selected.severity} /><StatusBadge status={selected.status} /></div><p>{selected.message ?? 'No additional incident message was provided.'}</p><h3>Timeline</h3><ol className="incident-timeline"><li><span><AlertTriangle /></span><div><strong>Incident detected</strong><small>{formatDate(selected.createdAt)}</small></div></li>{selected.status !== 'open' && <li><span><Clock3 /></span><div><strong>Team acknowledged the incident</strong><small>Recorded in audit history</small></div></li>}{selected.resolvedAt && <li><span><CheckCircle2 /></span><div><strong>Incident resolved</strong><small>{formatDate(selected.resolvedAt)}</small></div></li>}</ol></div>}
    </Modal>
  </>
}
