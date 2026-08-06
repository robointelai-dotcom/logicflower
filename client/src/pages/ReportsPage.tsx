import React from 'react'
import { BarChart3, Download, FileBarChart, Gauge, Plus, RefreshCw, TrendingUp } from 'lucide-react'
import { getList, getOne, send } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, Progress, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord, UsageMetric } from '../types'
import { formatDate, formatNumber, percentage } from '../utils/format'

interface Report extends UnknownRecord { id: string; name: string; type?: string; status?: string; period?: string; createdAt?: string; expiresAt?: string }
interface ReportsData { reports: Report[]; usage: UsageMetric[]; savings?: number; currency?: string }

async function loadReports(): Promise<ReportsData> {
  const [reports, usage] = await Promise.allSettled([getList<Report>('/reports', ['reports']), getOne<UnknownRecord>('/usage')])
  if (reports.status === 'rejected' && usage.status === 'rejected') throw reports.reason
  const usageBody = usage.status === 'fulfilled' ? usage.value : {}
  const raw = Array.isArray(usageBody.metrics) ? usageBody.metrics : Array.isArray(usageBody.items) ? usageBody.items : []
  const summary = usageBody.summary && typeof usageBody.summary === 'object' && !Array.isArray(usageBody.summary) ? usageBody.summary as UnknownRecord : {}
  const entitlement = usageBody.entitlement && typeof usageBody.entitlement === 'object' && !Array.isArray(usageBody.entitlement) ? usageBody.entitlement as UnknownRecord : {}
  const entitlementMetrics = entitlement.metrics && typeof entitlement.metrics === 'object' && !Array.isArray(entitlement.metrics) ? entitlement.metrics as UnknownRecord : {}
  const quotaUsage: UsageMetric[] = Object.entries(entitlementMetrics).map(([key, value]) => {
    const metric = value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
    return { key, label: key.replace(/[._-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()), used: Number(metric.used ?? 0), limit: metric.limit === null ? null : Number(metric.limit ?? 0), unit: key.includes('contact') ? 'contacts' : 'runs' }
  })
  const detailedUsage: UsageMetric[] = raw.map((value, index) => { const item = value as UnknownRecord; return { key: String(item.key ?? index), label: String(item.label ?? item.name ?? item.key ?? 'Usage'), used: Number(item.used ?? item.value ?? 0), limit: item.limit === null ? null : Number(item.limit ?? 0), unit: typeof item.unit === 'string' ? item.unit : undefined } })
  const summaryUsage: UsageMetric[] = Object.entries(summary).filter(([key]) => !entitlementMetrics[key]).map(([key, value]) => ({ key, label: key.replace(/[._-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()), used: Number(value) || 0 }))
  const usageMetrics: UsageMetric[] = quotaUsage.length ? [...quotaUsage, ...summaryUsage] : detailedUsage.length ? detailedUsage : summaryUsage
  const normalizedReports = reports.status === 'fulfilled' ? reports.value.items.map((report) => ({ ...report, name: report.name || `${String(report.type ?? 'Operations').replace(/\b\w/g, (letter) => letter.toUpperCase())} report`, period: report.period ?? `${formatDate(String(report.periodStart ?? ''))} – ${formatDate(String(report.periodEnd ?? ''))}`, createdAt: report.createdAt ?? String(report.generatedAt ?? '') })) : []
  return { reports: normalizedReports, usage: usageMetrics, savings: usageMetrics.reduce((sum, metric) => sum + metric.used, 0), currency: typeof usageBody.currency === 'string' ? usageBody.currency : 'USD' }
}

export default function ReportsPage() {
  const { session } = useAuth()
  const query = useApi(loadReports, [])
  const action = useAction()
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState({ type: 'health', period: 'last_30_days' })
  const canGenerate = ['owner', 'admin', 'operator'].includes(session?.organization?.role ?? '')
  const generate = async (event: React.FormEvent) => {
    event.preventDefault()
    const periodEnd = new Date(); const days = form.period === 'last_7_days' ? 7 : form.period === 'quarter' ? 90 : 30; const periodStart = new Date(periodEnd.getTime() - days * 86_400_000)
    const result = await action.run(() => send('post', '/reports', { type: form.type, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() }), 'Report generated.')
    if (result !== undefined) { setOpen(false); await query.reload() }
  }
  const exportReport = async (report: Report) => {
    const detail = await action.run(() => getOne<UnknownRecord>(`/reports/${report.id}`))
    if (!detail) return
    const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${report.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`; anchor.click(); URL.revokeObjectURL(url)
  }
  return <>
    <PageHeader eyebrow="Business intelligence" title="Reports & usage" description="Measure reliability, throughput and platform activity." actions={<><Button onClick={() => { void query.reload() }} busy={query.loading}><RefreshCw size={16} />Refresh</Button>{canGenerate && <Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />Generate report</Button>}</>} />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}{action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}
    {query.loading && !query.data ? <SkeletonRows rows={5} columns={4} /> : query.error ? <Alert>{query.error}</Alert> : <>
      <div className="usage-summary"><Card className="savings-card"><span><TrendingUp /></span><div><p>Total metered activity</p><strong>{formatNumber(query.data?.savings)}</strong><small>Sum of recorded usage metrics in the selected period.</small></div></Card><Card className="usage-card"><span><Gauge /></span><div><p>Metering status</p><strong>Current reporting period</strong><small>Usage is captured per workspace and connector.</small></div></Card></div>
      <Card title="Plan usage" subtitle="Limits reset at the start of the next billing period."><div className="usage-grid">{query.data?.usage.length ? query.data.usage.map((metric) => <div className="usage-item" key={metric.key}><div><strong>{metric.label}</strong><span>{formatNumber(metric.used)}{metric.limit ? ` of ${formatNumber(metric.limit)}` : ''} {metric.unit ?? ''}</span></div><Progress value={metric.limit ? percentage(metric.used, metric.limit) : 0} /></div>) : <EmptyState title="No usage recorded" description="Metered actions will appear after your first workflow or batch run." />}</div></Card>
      <Card title="Generated reports" subtitle="Export the complete structured report for analysis or archival.">{query.data?.reports.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Report</th><th>Type</th><th>Period</th><th>Status</th><th>Created</th><th>Export</th></tr></thead><tbody>{query.data.reports.map((report) => <tr key={report.id}><td><div className="entity-name"><span className="entity-icon"><FileBarChart size={17} /></span><strong>{report.name}</strong></div></td><td>{report.type ?? 'Operations'}</td><td>{report.period ?? 'Custom'}</td><td><StatusBadge status={report.status ?? 'ready'} /></td><td>{formatDate(report.createdAt)}</td><td><Button size="sm" variant="ghost" disabled={report.status !== undefined && report.status !== 'ready' && report.status !== 'completed'} onClick={() => { void exportReport(report) }}><Download size={14} />JSON</Button></td></tr>)}</tbody></table></div> : <EmptyState icon={<BarChart3 />} title="No reports generated" description="Create a health, usage, savings or incident report." action={canGenerate ? <Button onClick={() => setOpen(true)}>Generate report</Button> : undefined} />}</Card>
    </>}
    <Modal open={open} title="Generate report" description="Reports include only data visible to your current workspace role." onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="report-form" busy={action.loading}>Generate</Button></>}><form id="report-form" className="form-stack" onSubmit={generate}><div className="form-grid"><Field label="Report type"><select value={form.type} autoFocus onChange={(event) => setForm((current) => ({ ...current, type: event.target.value }))}><option value="health">Workflow health</option><option value="usage">Usage and limits</option><option value="savings">Operational savings data</option><option value="incident">Incident history</option></select></Field><Field label="Period"><select value={form.period} onChange={(event) => setForm((current) => ({ ...current, period: event.target.value }))}><option value="last_7_days">Last 7 days</option><option value="last_30_days">Last 30 days</option><option value="quarter">Last 90 days</option></select></Field></div></form></Modal>
  </>
}
