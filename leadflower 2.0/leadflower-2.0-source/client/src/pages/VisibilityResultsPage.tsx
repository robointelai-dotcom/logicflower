import React from 'react'
import { PhoneMissed, Search, TrendingUp } from 'lucide-react'
import { getOne } from '../api/client'
import { Link } from '../router'
import { Alert, Card, EmptyState, PageHeader, SkeletonRows } from '../components/ui'
import { useApi } from '../hooks/useApi'

/**
 * Where the work came from.
 *
 * The landing screen for this section, and the reason it exists. Every other
 * tool in this category reports impressions and positions; this reports jobs
 * and money, because LogicFlower owns the call, the booking and the deal.
 *
 * Deliberately has no chart. A plumber checking his phone between jobs needs a
 * sentence he can act on, and a chart is not one.
 */

interface Row {
  source: string
  label: string
  jobs: number
  valueMinorUnits: number
  missedCalls: number
}

interface Report {
  currency: string
  totals: { jobs: number; valueMinorUnits: number; missedCalls: number }
  rows: Row[]
  queries: Array<{ query: string; clicks: number; jobs: number }>
  empty: boolean
  method: string
}

function money(minorUnits: number, currency: string): string {
  return (minorUnits / 100).toLocaleString(undefined, {
    style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0,
  })
}

export default function VisibilityResultsPage() {
  const [days, setDays] = React.useState(30)
  const query = useApi(async () => await getOne<Report>(`/visibility/results?days=${days}`), [days])

  if (query.loading) return <SkeletonRows rows={4} columns={3} />
  if (query.error) return <Alert>{query.error}</Alert>

  const report = query.data
  const best = report?.rows.find((row) => row.source !== 'unknown')

  return <>
    <PageHeader
      eyebrow="Getting found"
      title="Where your work comes from"
      description="Counted from jobs you actually won, not from clicks."
      actions={<select value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Period">
        <option value={30}>Last 30 days</option>
        <option value={90}>Last 90 days</option>
        <option value={365}>Last year</option>
      </select>}
    />

    {/*
      The empty state matters more than the full one. Before there are closed
      jobs this would render a column of zeros, and zeros read as a broken
      report rather than an empty month.
    */}
    {report?.empty ? <Card><EmptyState
      icon={<TrendingUp />}
      title="Nothing to show yet"
      description="This fills in once you have won some work in LogicFlower. Add your business details first so search engines can find you."
      action={<Link to="/seo/profile" className="btn-inline">Add my business details</Link>}
    /></Card> : <>
      <Card className="results-headline">
        {/* The one sentence the whole module exists to produce. */}
        <p className="results-lead">
          {best
            ? <>Your <strong>{best.label.toLowerCase()}</strong> produced{' '}
              <strong>{best.jobs} job{best.jobs === 1 ? '' : 's'} worth {money(best.valueMinorUnits, report!.currency)}</strong>
              {best.missedCalls > 0 && <> — including <strong>{best.missedCalls}</strong> that came in as {best.missedCalls === 1 ? 'a call you missed' : 'calls you missed'}</>}
              .</>
            : <>You won <strong>{report!.totals.jobs} job{report!.totals.jobs === 1 ? '' : 's'} worth {money(report!.totals.valueMinorUnits, report!.currency)}</strong>, though we could not trace where they came from.</>}
        </p>
      </Card>

      <Card title="Where it came from">
        <table className="data-table">
          <thead><tr><th>Source</th><th>Jobs</th><th>Worth</th><th>Missed calls</th></tr></thead>
          <tbody>{report!.rows.map((row) => <tr key={row.source} className={row.source === 'unknown' ? 'row-muted' : undefined}>
            <td><strong>{row.label}</strong></td>
            <td>{row.jobs}</td>
            <td>{money(row.valueMinorUnits, report!.currency)}</td>
            <td>{row.missedCalls > 0 ? <span className="signal signal-amber"><PhoneMissed size={13} />{row.missedCalls}</span> : <span className="muted">—</span>}</td>
          </tr>)}</tbody>
        </table>
      </Card>

      {Boolean(report!.queries.length) && <Card title="What people searched for">
        <table className="data-table">
          <thead><tr><th>Search</th><th>Jobs</th></tr></thead>
          <tbody>{report!.queries.map((entry) => <tr key={entry.query}>
            <td><Search size={13} /> {entry.query}</td>
            <td>{entry.jobs}</td>
          </tr>)}</tbody>
        </table>
      </Card>}
    </>}

    {/* Stated plainly. A method nobody can see is a method nobody should trust. */}
    <p className="muted method-note">{report?.method}</p>
  </>
}
