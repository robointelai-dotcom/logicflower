import React from 'react'
import { Activity, Ban, CheckCircle2, ChevronRight, Clock3, Download, Filter, RefreshCw, RotateCcw, Search, XCircle } from 'lucide-react'
import { useSearchParams } from '../router'
import { download, getList, getOne, send } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, Button, Card, EmptyState, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { Execution, UnknownRecord } from '../types'
import { formatDate, formatDuration } from '../utils/format'

async function listExecutions(status: string, query: string): Promise<Execution[]> {
  const result = await getList<Execution & UnknownRecord>('/executions', ['executions'], { params: { status: status === 'all' ? undefined : status, query: query || undefined, limit: 100 } })
  return result.items.map(normalizeExecution)
}

function normalizeExecution(item: Execution & UnknownRecord): Execution {
  const serverCapabilities = item.capabilities && typeof item.capabilities === 'object' && !Array.isArray(item.capabilities) ? item.capabilities as UnknownRecord : {}
  const rawError = item.error
  const error = typeof rawError === 'string' ? rawError : rawError && typeof rawError === 'object' && !Array.isArray(rawError) ? String((rawError as UnknownRecord).message ?? '') : undefined
  const steps = Array.isArray(item.steps) ? item.steps.map((step, index) => ({
    ...step,
    id: String(step.id ?? step.nodeId ?? index),
    name: String(step.name ?? step.type ?? `Step ${index + 1}`),
    error: typeof step.error === 'string' ? step.error : step.error && typeof step.error === 'object' ? String((step.error as UnknownRecord).message ?? '') : undefined,
  })) : []
  return {
    ...item,
    error,
    steps,
    capabilities: {
      cancel: typeof serverCapabilities.cancel === 'boolean' ? serverCapabilities.cancel : ['queued', 'running', 'waiting'].includes(item.status),
      retry: typeof serverCapabilities.retry === 'boolean' ? serverCapabilities.retry : ['failed', 'partial', 'cancelled'].includes(item.status),
      export: typeof serverCapabilities.export === 'boolean' ? serverCapabilities.export : true,
    },
  }
}

export default function ExecutionsPage() {
  const { session } = useAuth()
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = React.useState(params.get('status') ?? 'all')
  const [search, setSearch] = React.useState('')
  const [selected, setSelected] = React.useState<Execution | null>(null)
  const [detailsLoading, setDetailsLoading] = React.useState(false)
  const query = useApi(() => listExecutions(status, search), [status, search])
  const action = useAction()
  const canOperate = ['owner', 'admin', 'operator'].includes(session?.organization?.role ?? '')

  const openDetails = React.useCallback(async (id: string) => {
    setDetailsLoading(true)
    const detail = await action.run(() => getOne<Execution & UnknownRecord>(`/executions/${encodeURIComponent(id)}`))
    if (detail) setSelected(normalizeExecution(detail))
    setDetailsLoading(false)
    params.set('selected', id); setParams(params, { replace: true })
  }, [action, params, setParams])

  React.useEffect(() => { const id = params.get('selected'); if (id && !selected && !detailsLoading) void openDetails(id) }, [detailsLoading, openDetails, params, selected])

  const close = () => { setSelected(null); params.delete('selected'); setParams(params, { replace: true }) }
  const retry = async (execution: Execution) => { const created = await action.run(() => send<Execution>('post', `/executions/${execution.id}/retry`), 'Execution queued for retry.'); if (created) { close(); await query.reload() } }
  const cancel = async (execution: Execution) => { await action.run(() => send('post', `/executions/${execution.id}/cancel`), 'Cancellation requested.'); close(); await query.reload() }
  const exportCsv = async () => { await action.run(async () => { await download('/executions/export', 'logicflower-executions.csv'); return true }, 'Execution CSV downloaded.') }

  return <>
    <PageHeader eyebrow="Observability" title="Executions" description="Inspect every workflow run, step result, retry and failure." actions={<><Button onClick={() => { void exportCsv() }} busy={action.loading}><Download size={16} />Export CSV</Button><Button onClick={() => { void query.reload() }} busy={query.loading}><RefreshCw size={16} />Refresh</Button></>} />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}{action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}
    <Card>
      <div className="table-toolbar"><div className="search-input"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search workflow or execution ID" aria-label="Search executions" /></div><div className="with-icon filter-select"><Filter size={16} /><select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by status"><option value="all">All statuses</option><option value="queued">Queued</option><option value="waiting">Waiting</option><option value="running">Running</option><option value="cancel_requested">Cancellation requested</option><option value="succeeded">Succeeded</option><option value="partial">Partial</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></div></div>
      {query.loading ? <SkeletonRows rows={7} columns={6} /> : query.error ? <Alert>{query.error}</Alert> : query.data?.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Workflow</th><th>Execution ID</th><th>Status</th><th>Trigger</th><th>Started</th><th>Duration</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{query.data.map((execution) => <tr key={execution.id} className="clickable-row" onClick={() => { void openDetails(execution.id) }}><td><strong>{execution.workflowName ?? 'Workflow'}</strong></td><td><code>{execution.id.slice(0, 12)}</code></td><td><StatusBadge status={execution.status} /></td><td>{execution.trigger ?? 'Manual'}</td><td>{formatDate(execution.startedAt)}</td><td>{['running', 'waiting'].includes(execution.status) ? <span className="with-icon info-text"><Activity className={execution.status === 'running' ? 'pulse' : ''} size={15} />{execution.status === 'waiting' ? 'Waiting' : 'In progress'}</span> : formatDuration(execution.durationMs)}</td><td><button className="icon-button" aria-label={`View execution ${execution.id}`}><ChevronRight size={16} /></button></td></tr>)}</tbody></table></div> : <EmptyState icon={<Activity />} title="No executions found" description="Workflow runs will appear here with complete step-by-step history." />}
    </Card>
    <Modal open={Boolean(selected) || detailsLoading} title="Execution details" description={selected ? `Run ${selected.id}` : 'Loading execution'} onClose={close} wide footer={selected && <><Button onClick={close}>Close</Button>{canOperate && selected.capabilities?.cancel && ['queued', 'running', 'waiting'].includes(selected.status) && <Button variant="danger" onClick={() => { void cancel(selected) }}><Ban size={16} />Cancel</Button>}{canOperate && selected.capabilities?.retry && ['failed', 'partial', 'cancelled'].includes(selected.status) && <Button variant="primary" onClick={() => { void retry(selected) }} busy={action.loading}><RotateCcw size={16} />Retry safely</Button>}</>}>
      {detailsLoading || !selected ? <SkeletonRows rows={5} columns={3} /> : <div className="execution-detail"><div className="detail-summary"><div><span>Status</span><StatusBadge status={selected.status} /></div><div><span>Workflow</span><strong>{selected.workflowName ?? selected.workflowId ?? '—'}</strong></div><div><span>Started</span><strong>{formatDate(selected.startedAt)}</strong></div><div><span>Duration</span><strong>{formatDuration(selected.durationMs)}</strong></div></div>{selected.error && <Alert><strong>Execution failed</strong><p>{selected.error}</p></Alert>}<h3>Step timeline</h3>{selected.steps?.length ? <ol className="step-timeline">{selected.steps.map((step, index) => <li key={step.id ?? index} className={step.status ?? 'neutral'}><span className="timeline-icon">{step.status === 'succeeded' ? <CheckCircle2 /> : step.status === 'failed' ? <XCircle /> : <Clock3 />}</span><div><strong>{step.name ?? `Step ${index + 1}`}</strong><small>{step.error ?? formatDuration(step.durationMs)}</small></div><StatusBadge status={step.status ?? 'queued'} /></li>)}</ol> : <EmptyState title="No step results available" description="This execution has not produced step-level data yet." />}</div>}
    </Modal>
  </>
}
