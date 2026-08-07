import React from 'react'
import { Activity, AlertTriangle, ArrowRight, CheckCircle2, Layers3, Plug, Workflow as WorkflowIcon, Zap } from 'lucide-react'
import { Link } from '../router'
import { api, normalizeList, unwrap } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, Card, EmptyState, LoadingState, PageHeader, Progress, StatusBadge } from '../components/ui'
import { useApi } from '../hooks/useApi'
import type { Execution, Incident, UnknownRecord } from '../types'
import { formatDate, formatNumber } from '../utils/format'

interface DashboardData {
  metrics: { connections: number; workflows: number; executions: number; successRate: number; batches: number }
  executions: Execution[]
  incidents: Incident[]
  checklist: Array<{ key: string; label: string; complete: boolean; to: string }>
}

function asNumber(value: unknown): number { return typeof value === 'number' ? value : Number(value) || 0 }

async function loadDashboard(): Promise<DashboardData> {
  const [overviewResult, executionResult, incidentResult, onboardingResult, connectionResult, workflowResult, channelResult] = await Promise.allSettled([
    api.get('/reports/dashboard'), api.get('/executions', { params: { limit: 5 } }), api.get('/monitoring/incidents', { params: { status: 'open', limit: 4 } }), api.get('/organizations/onboarding'), api.get('/connections', { params: { limit: 100 } }), api.get('/workflows', { params: { limit: 100 } }), api.get('/notifications/channels'),
  ])
  const overview = overviewResult.status === 'fulfilled' ? unwrap<UnknownRecord>(overviewResult.value.data) : {}
  const executionPayload = executionResult.status === 'fulfilled' ? executionResult.value.data : []
  const incidentPayload = incidentResult.status === 'fulfilled' ? incidentResult.value.data : []
  const onboarding = onboardingResult.status === 'fulfilled' ? unwrap<UnknownRecord>(onboardingResult.value.data) : {}
  const connectionCount = connectionResult.status === 'fulfilled' ? normalizeList<UnknownRecord>(connectionResult.value.data).items.filter((item) => item.status === 'active').length : 0
  const workflowItems = workflowResult.status === 'fulfilled' ? normalizeList<UnknownRecord>(workflowResult.value.data).items : []
  const workflowCount = workflowItems.filter((item) => item.status === 'published').length
  const alertCount = channelResult.status === 'fulfilled' ? normalizeList<UnknownRecord>(channelResult.value.data).items.filter((item) => item.enabled !== false).length : 0
  if ([overviewResult, executionResult, incidentResult, connectionResult, workflowResult].every((result) => result.status === 'rejected')) throw overviewResult.status === 'rejected' ? overviewResult.reason : new Error('Dashboard unavailable')
  const checklistRaw = Array.isArray(onboarding.items) ? onboarding.items : Array.isArray(onboarding.checklist) ? onboarding.checklist : []
  const defaults = [
    { key: 'organization', label: 'Configure workspace', complete: true, to: '/settings' },
    { key: 'connection', label: 'Connect your first platform', complete: connectionCount > 0, to: '/connections' },
    { key: 'workflow', label: 'Create a safe workflow', complete: workflowItems.length > 0, to: '/workflows' },
    { key: 'alerts', label: 'Choose an alert channel', complete: alertCount > 0, to: '/notifications' },
  ]
  return {
    metrics: {
      connections: connectionCount,
      workflows: workflowCount,
      executions: asNumber(overview.executions ?? overview.executionsThisMonth),
      successRate: asNumber(overview.successRate) <= 1 ? Math.round(asNumber(overview.successRate) * 100) : Math.round(asNumber(overview.successRate)),
      batches: asNumber(overview.activeBatches ?? overview.batches),
    },
    executions: normalizeList<Execution & UnknownRecord>(executionPayload, ['executions']).items,
    incidents: normalizeList<Incident & UnknownRecord>(incidentPayload, ['incidents']).items.filter((incident) => incident.status !== 'resolved').slice(0, 4),
    checklist: checklistRaw.length ? checklistRaw.map((entry) => {
      const item = entry as UnknownRecord
      return { key: String(item.key ?? item.id ?? item.label), label: String(item.label ?? item.name), complete: Boolean(item.complete ?? item.completed), to: String(item.to ?? item.path ?? '/onboarding') }
    }) : defaults,
  }
}

export default function DashboardPage() {
  const { session } = useAuth()
  const query = useApi(loadDashboard, [])
  const canEdit = ['owner', 'admin', 'operator'].includes(session?.organization?.role ?? '')
  if (query.loading && !query.data) return <><PageHeader title="Overview" description="Your automation operations at a glance." /><LoadingState label="Loading workspace overview" /></>
  if (query.error && !query.data) return <><PageHeader title="Overview" /><Alert>{query.error}</Alert></>
  const data = query.data ?? { metrics: { connections: 0, workflows: 0, executions: 0, successRate: 0, batches: 0 }, executions: [], incidents: [], checklist: [] }
  const complete = data.checklist.filter((item) => item.complete).length
  const progress = data.checklist.length ? Math.round((complete / data.checklist.length) * 100) : 100
  return (
    <>
      <PageHeader eyebrow="Operations center" title="Good morning" description="Here’s what is happening across your workspace." actions={canEdit && <Link className="button button-primary" to="/workflows/new/builder"><Zap size={16} />Create workflow</Link>} />
      {query.error && <Alert tone="warning">Some dashboard data could not be refreshed. Showing the last available values.</Alert>}
      <div className="metric-grid">
        <Metric icon={<Plug />} label="Connected platforms" value={data.metrics.connections} detail="Connection health" to="/connections" />
        <Metric icon={<WorkflowIcon />} label="Published workflows" value={data.metrics.workflows} detail="Manage automations" to="/workflows" />
        <Metric icon={<Activity />} label="Runs this month" value={data.metrics.executions} detail={`${data.metrics.successRate || 0}% success rate`} to="/executions" tone={data.metrics.successRate >= 95 ? 'success' : 'default'} />
        <Metric icon={<Layers3 />} label="Batch jobs this month" value={data.metrics.batches} detail="View bulk operations" to="/batches" />
      </div>
      <div className="dashboard-grid">
        <Card title="Recent executions" subtitle="The latest workflow activity" actions={<Link className="text-link" to="/executions">View all <ArrowRight size={14} /></Link>}>
          {data.executions.length ? <div className="compact-list">{data.executions.map((execution) => <Link to={`/executions?selected=${execution.id}`} key={execution.id} className="compact-row"><span className={`row-icon ${execution.status === 'succeeded' ? 'success' : execution.status === 'failed' ? 'danger' : ''}`}>{execution.status === 'succeeded' ? <CheckCircle2 /> : execution.status === 'failed' ? <AlertTriangle /> : <Activity />}</span><span className="row-main"><strong>{execution.workflowName ?? 'Workflow execution'}</strong><small>{formatDate(execution.startedAt)}</small></span><StatusBadge status={execution.status} /></Link>)}</div> : <EmptyState title="No executions yet" description="Run or publish a workflow to see activity here." action={<Link className="button button-secondary button-sm" to="/workflows">Open workflows</Link>} />}
        </Card>
        <Card title="Workspace setup" subtitle={`${complete} of ${data.checklist.length} tasks complete`}><Progress value={progress} />
          <div className="checklist">{data.checklist.map((item) => <Link to={item.to} key={item.key} className={item.complete ? 'complete' : ''}><span>{item.complete ? <CheckCircle2 size={18} /> : <span className="empty-check" />}</span>{item.label}<ArrowRight size={15} /></Link>)}</div>
        </Card>
        <Card className="wide-card" title="Open incidents" subtitle="Issues requiring attention" actions={<Link className="text-link" to="/monitoring">Monitoring <ArrowRight size={14} /></Link>}>
          {data.incidents.length ? <div className="incident-strip">{data.incidents.map((incident) => <Link to={`/monitoring?incident=${incident.id}`} key={incident.id}><span className={`severity-dot severity-${incident.severity}`} /><div><strong>{incident.title}</strong><small>{incident.source ?? 'LogicFlower'} · {formatDate(incident.createdAt)}</small></div><StatusBadge status={incident.severity} /></Link>)}</div> : <div className="healthy-state"><CheckCircle2 size={22} /><div><strong>All systems healthy</strong><span>No open incidents need your attention.</span></div></div>}
        </Card>
      </div>
    </>
  )
}

function Metric({ icon, label, value, detail, to, tone = 'default' }: { icon: React.ReactNode; label: string; value: number; detail: string; to: string; tone?: 'default' | 'success' }) {
  return <Card className={`metric-card metric-${tone}`}><div className="metric-top"><span>{icon}</span><Link to={to} aria-label={`Open ${label}`}><ArrowRight size={16} /></Link></div><strong>{formatNumber(value)}</strong><h2>{label}</h2><p>{detail}</p></Card>
}
