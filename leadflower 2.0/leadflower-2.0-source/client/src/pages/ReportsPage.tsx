import React from 'react'
import { BarChart3, Download, FileBarChart, PhoneMissed, Plus, RefreshCw, Search, TrendingUp } from 'lucide-react'
import { getList, getOne, send } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, Progress, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord, UsageMetric } from '../types'
import { formatDate, formatNumber, percentage } from '../utils/format'

interface Report extends UnknownRecord { id: string; name: string; type?: string; status?: string; period?: string; createdAt?: string; expiresAt?: string }
interface ReportsData { reports: Report[]; usage: UsageMetric[]; savings?: number; currency?: string }

/**
 * Results — what the business got, not what the platform did.
 *
 * This screen used to open with "Business intelligence… measure reliability,
 * throughput and platform activity… total metered activity… usage is captured
 * per workspace and connector". That is metering language, and this product
 * does not charge per action — "no charge per action" is the central
 * commercial claim. The screen was advertising a pricing model we do not use.
 *
 * So it leads with the attribution report: jobs won and what they were worth.
 * Plan usage stays, small, at the bottom, because an owner still needs to know
 * when they are near a limit — but it is not what the screen is for.
 */
interface AttributionRow { source: string; label: string; jobs: number; valueMinorUnits: number; missedCalls: number }
interface Attribution {
  currency: string
  totals: { jobs: number; valueMinorUnits: number; missedCalls: number }
  rows: AttributionRow[]
  queries: Array<{ query: string; clicks: number; jobs: number }>
  empty: boolean
  method: string
}

function money(minorUnits: number, currency: string): string {
  return (minorUnits / 100).toLocaleString(undefined, {
    style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0,
  })
}

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
  // Loaded separately and allowed to fail: a workspace that has not yet won a
  // job should still see its plan usage rather than an error.
  const results = useApi(async () => {
    /*
     * A failed call and an empty month are different things and must not read
     * the same. Swallowing the error into a null rendered "Nothing to show
     * yet", which tells an owner they have won no work when in fact we could
     * not ask — the exact silent-zero this codebase refuses elsewhere.
     */
    try { return { report: await getOne<Attribution>('/visibility/results?days=30'), failed: false } }
    catch { return { report: null, failed: true } }
  }, [])
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
  const resultsData = results.data?.report ?? null
  const resultsFailed = Boolean(results.data?.failed)
  const best = resultsData?.rows.find((row) => row.source !== 'unknown')

  return <>
    <PageHeader eyebrow="Results" title="What your work is worth" description="Jobs you won, what they were worth, and where they came from." actions={<><Button onClick={() => { void query.reload(); void results.reload() }} busy={query.loading}><RefreshCw size={16} />Refresh</Button>{canGenerate && <Button onClick={() => setOpen(true)}><Plus size={16} />Generate report</Button>}</>} />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}{action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}
    {query.loading && !query.data ? <SkeletonRows rows={5} columns={4} /> : query.error ? <Alert>{query.error}</Alert> : <>
      {resultsData?.empty === false ? <>
        <Card className="results-headline">
          {/* The one sentence the screen exists to produce. */}
          <p className="results-lead">
            {best
              ? <>Your <strong>{best.label.toLowerCase()}</strong> produced{' '}
                <strong>{best.jobs} job{best.jobs === 1 ? '' : 's'} worth {money(best.valueMinorUnits, resultsData.currency)}</strong>
                {best.missedCalls > 0 && <> — including <strong>{best.missedCalls}</strong> that came in as {best.missedCalls === 1 ? 'a call you missed' : 'calls you missed'}</>}
                .</>
              : <>You won <strong>{resultsData.totals.jobs} job{resultsData.totals.jobs === 1 ? '' : 's'} worth {money(resultsData.totals.valueMinorUnits, resultsData.currency)}</strong>, though we could not trace where they came from.</>}
          </p>
        </Card>

        <Card title="Where it came from">
          <table className="data-table">
            <thead><tr><th>Source</th><th>Jobs</th><th>Worth</th><th>Missed calls</th></tr></thead>
            <tbody>{resultsData.rows.map((row) => <tr key={row.source} className={row.source === 'unknown' ? 'row-muted' : undefined}>
              <td><strong>{row.label}</strong></td>
              <td>{row.jobs}</td>
              <td>{money(row.valueMinorUnits, resultsData.currency)}</td>
              <td>{row.missedCalls > 0 ? <span className="signal signal-amber"><PhoneMissed size={13} />{row.missedCalls}</span> : <span className="muted">—</span>}</td>
            </tr>)}</tbody>
          </table>
        </Card>

        {Boolean(resultsData.queries.length) && <Card title="What people searched for">
          <table className="data-table">
            <thead><tr><th>Search</th><th>Jobs</th></tr></thead>
            <tbody>{resultsData.queries.map((entry) => <tr key={entry.query}><td><Search size={13} /> {entry.query}</td><td>{entry.jobs}</td></tr>)}</tbody>
          </table>
        </Card>}
      </> : resultsFailed ? <Card><EmptyState
        icon={<TrendingUp />}
        title="We could not load your results"
        description="This is not a report of no work — we could not reach the figures at all. Your plan usage below is unaffected. Try refreshing; if it keeps happening, this deployment may not have the results module set up."
      /></Card> : <Card><EmptyState
        icon={<TrendingUp />}
        title="Nothing to show yet"
        description="This fills in once you have won some work. Every job is counted from what you actually closed, not from clicks."
      /></Card>}

      {/*
        Small, and at the bottom. The owner needs to know when they are near a
        limit; they do not need a screen about it.
      */}
      <Card title="Your plan" subtitle="So you know before you run out. There is no charge per message or per action."><div className="usage-grid">{query.data?.usage.length ? query.data.usage.map((metric) => <div className="usage-item" key={metric.key}><div><strong>{metric.label}</strong><span>{formatNumber(metric.used)}{metric.limit ? ` of ${formatNumber(metric.limit)}` : ''} {metric.unit ?? ''}</span></div><Progress value={metric.limit ? percentage(metric.used, metric.limit) : 0} /></div>) : <EmptyState title="Nothing counted yet" description="Contacts and users appear here as you add them." />}</div></Card>
      <Card title="Generated reports" subtitle="Export the complete structured report for analysis or archival.">{query.data?.reports.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Report</th><th>Type</th><th>Period</th><th>Status</th><th>Created</th><th>Export</th></tr></thead><tbody>{query.data.reports.map((report) => <tr key={report.id}><td><div className="entity-name"><span className="entity-icon"><FileBarChart size={17} /></span><strong>{report.name}</strong></div></td><td>{report.type ?? 'Operations'}</td><td>{report.period ?? 'Custom'}</td><td><StatusBadge status={report.status ?? 'ready'} /></td><td>{formatDate(report.createdAt)}</td><td><Button size="sm" variant="ghost" disabled={report.status !== undefined && report.status !== 'ready' && report.status !== 'completed'} onClick={() => { void exportReport(report) }}><Download size={14} />JSON</Button></td></tr>)}</tbody></table></div> : <EmptyState icon={<BarChart3 />} title="No reports generated" description="Create a health, usage, savings or incident report." action={canGenerate ? <Button onClick={() => setOpen(true)}>Generate report</Button> : undefined} />}</Card>
    </>}
    <Modal open={open} title="Generate report" description="Reports include only data visible to your current workspace role." onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="report-form" busy={action.loading}>Generate</Button></>}><form id="report-form" className="form-stack" onSubmit={generate}><div className="form-grid"><Field label="Report type"><select value={form.type} autoFocus onChange={(event) => setForm((current) => ({ ...current, type: event.target.value }))}><option value="health">Workflow health</option><option value="usage">Usage and limits</option><option value="savings">Operational savings data</option><option value="incident">Incident history</option></select></Field><Field label="Period"><select value={form.period} onChange={(event) => setForm((current) => ({ ...current, period: event.target.value }))}><option value="last_7_days">Last 7 days</option><option value="last_30_days">Last 30 days</option><option value="quarter">Last 90 days</option></select></Field></div></form></Modal>
  </>
}
