import React from 'react'
import { Ban, CheckCircle2, Download, FileSpreadsheet, Pause, Play, Plus, RefreshCw, RotateCcw, Search, ShieldCheck, Upload, XCircle } from 'lucide-react'
import { api, download, getList, send, unwrap } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, Button, Card, ConfirmDialog, EmptyState, Field, Modal, PageHeader, Progress, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { BatchJob, UnknownRecord } from '../types'
import { formatDate, formatNumber, percentage, titleCase } from '../utils/format'

interface BatchConnection extends UnknownRecord { id: string; name: string; provider: string; status: string }

function normalizeBatch(item: BatchJob & UnknownRecord): BatchJob {
  const stats = item.stats && typeof item.stats === 'object' && !Array.isArray(item.stats) ? item.stats as UnknownRecord : {}
  const rawPreview = item.preview && typeof item.preview === 'object' && !Array.isArray(item.preview) ? item.preview as UnknownRecord : undefined
  const succeeded = Number(item.succeeded ?? stats.succeeded ?? 0)
  const failed = Number(item.failed ?? stats.failed ?? 0)
  const skipped = Number(stats.skipped ?? 0)
  const excluded = Number(stats.invalid ?? rawPreview?.invalid ?? 0) + Number(stats.duplicate ?? rawPreview?.duplicate ?? 0)
  const warnings = Array.isArray(item.warnings) ? item.warnings.map(String) : []
  return {
    ...item,
    name: item.name || 'Untitled batch',
    total: Number(item.total ?? stats.total ?? rawPreview?.total ?? 0),
    processed: Number(item.processed ?? stats.processed ?? succeeded + failed + skipped) + excluded,
    succeeded,
    failed,
    preview: rawPreview ? {
      affected: Number(rawPreview.affected ?? rawPreview.valid ?? 0),
      unchanged: Number(rawPreview.unchanged ?? rawPreview.duplicate ?? 0),
      invalid: Number(rawPreview.invalid ?? 0),
      warnings,
    } : item.preview,
    previewHash: typeof item.previewHash === 'string' ? item.previewHash : undefined,
    rollbackAvailable: Boolean(item.rollbackAvailable),
  }
}

async function loadBatches(): Promise<BatchJob[]> {
  const result = await getList<BatchJob & UnknownRecord>('/batches', ['batches', 'jobs'])
  return result.items.map(normalizeBatch)
}

async function loadBatchConnections(): Promise<BatchConnection[]> {
  const result = await getList<BatchConnection>('/connections', ['connections'])
  return result.items.map((item) => ({ ...item, name: String(item.name ?? item.provider ?? 'Connection'), provider: String(item.provider ?? ''), status: String(item.status ?? '') })).filter((item) => ['active', 'degraded'].includes(item.status) && ['ghl', 'hubspot', 'klaviyo', 'activecampaign'].includes(item.provider))
}

export default function BatchesPage() {
  const { session } = useAuth()
  const query = useApi(loadBatches, [])
  const connectionQuery = useApi(loadBatchConnections, [session?.organization?.id])
  const action = useAction()
  const [search, setSearch] = React.useState('')
  const [createOpen, setCreateOpen] = React.useState(false)
  const [preview, setPreview] = React.useState<BatchJob | null>(null)
  const [cancelTarget, setCancelTarget] = React.useState<BatchJob | null>(null)
  const [rollbackTarget, setRollbackTarget] = React.useState<BatchJob | null>(null)
  const [approval, setApproval] = React.useState('')
  const [form, setForm] = React.useState({ name: '', operation: 'update_contacts', connectionId: '', duplicateRule: 'email_or_phone' })
  const [file, setFile] = React.useState<File | null>(null)
  const canOperate = ['owner', 'admin', 'operator'].includes(session?.organization?.role ?? '')
  const availableConnections = (connectionQuery.data ?? []).filter((connection) => !['add_tags', 'remove_tags'].includes(form.operation) || connection.provider === 'ghl')

  React.useEffect(() => {
    if (!query.data?.some((job) => ['queued', 'running', 'previewing', 'cancel_requested'].includes(job.status))) return
    const timer = window.setInterval(() => { void query.reload() }, 8000)
    return () => window.clearInterval(timer)
  }, [query])

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file) return
    const body = new FormData()
    body.append('file', file); body.append('name', form.name); body.append('operation', form.operation); body.append('connectionId', form.connectionId); body.append('duplicateRule', form.duplicateRule)
    const result = await action.run(async () => unwrap<BatchJob>((await api.post('/batches', body)).data), 'File uploaded and validation started.')
    if (result) { setCreateOpen(false); setFile(null); setForm({ name: '', operation: 'update_contacts', connectionId: '', duplicateRule: 'email_or_phone' }); await query.reload() }
  }
  const openPreview = async (job: BatchJob) => {
    const detail = await action.run(() => send<BatchJob & UnknownRecord>('post', `/batches/${job.id}/preview`))
    if (detail) { setPreview(normalizeBatch({ ...job, ...detail })); setApproval('') }
  }
  const approve = async () => {
    if (!preview || approval !== 'APPROVE') return
    const complete = await action.run(async () => { await send('post', `/batches/${preview.id}/approve`, { confirmation: approval, previewHash: preview.previewHash }); return true }, 'Batch approved and queued.')
    if (complete) { setPreview(null); await query.reload() }
  }
  const control = async (job: BatchJob, command: 'pause' | 'resume') => { await action.run(() => send('post', `/batches/${job.id}/${command}`), `Batch ${command === 'pause' ? 'paused' : 'resumed'}.`); await query.reload() }
  const cancel = async () => { if (!cancelTarget) return; const done = await action.run(async () => { await send('post', `/batches/${cancelTarget.id}/cancel`); return true }, 'Cancellation requested.'); if (done) { setCancelTarget(null); await query.reload() } }
  const retryFailures = async (job: BatchJob) => { await action.run(() => send('post', `/batches/${job.id}/retry-failures`), 'Retryable failed records were queued.'); await query.reload() }
  const exportFailures = async (job: BatchJob) => { await action.run(async () => { await download(`/batches/${job.id}/failed.csv`, `${job.name}-failed.csv`); return true }, 'Failed-row CSV downloaded.') }
  const rollback = async () => { if (!rollbackTarget) return; const done = await action.run(async () => { await send('post', `/batches/${rollbackTarget.id}/rollback`); return true }, 'Rollback job created from the before-state snapshot.'); if (done) { setRollbackTarget(null); await query.reload() } }
  const filtered = (query.data ?? []).filter((job) => `${job.name} ${job.operation ?? ''}`.toLowerCase().includes(search.toLowerCase()))

  return <>
    <PageHeader eyebrow="Safe bulk operations" title="Batch jobs" description="Preview impact, approve intentionally, pause safely and retry only failed records." actions={canOperate && <Button variant="primary" onClick={() => setCreateOpen(true)}><Upload size={16} />New batch</Button>} />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}{action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}
    <div className="safety-strip"><span><ShieldCheck /></span><div><strong>Every live batch requires a dry-run approval.</strong><p>LogicFlower validates the source, checkpoints processing and keeps per-record results.</p></div></div>
    <Card>
      <div className="table-toolbar"><div className="search-input"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search batch jobs" aria-label="Search batch jobs" /></div><Button size="sm" onClick={() => { void query.reload() }} busy={query.loading}><RefreshCw size={15} />Refresh</Button></div>
      {query.loading && !query.data ? <SkeletonRows rows={6} columns={6} /> : query.error ? <Alert>{query.error}</Alert> : filtered.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Batch</th><th>Status</th><th>Progress</th><th>Results</th><th>Created</th><th>Controls</th></tr></thead><tbody>{filtered.map((job) => <tr key={job.id}><td><div className="entity-name"><span className="entity-icon"><FileSpreadsheet size={17} /></span><div><strong>{job.name}</strong><span>{titleCase(job.operation ?? 'Bulk operation')} · {formatNumber(job.total)} rows</span></div></div></td><td><StatusBadge status={job.status} /></td><td className="progress-cell"><Progress value={percentage(job.processed, job.total)} /><small>{formatNumber(job.processed)} / {formatNumber(job.total)}</small></td><td><span className="result-count success-text"><CheckCircle2 size={14} />{formatNumber(job.succeeded)}</span><span className="result-count danger-text"><XCircle size={14} />{formatNumber(job.failed)}</span></td><td>{formatDate(job.createdAt)}</td><td><div className="inline-actions">{canOperate && ['draft', 'uploaded', 'preview_ready', 'awaiting_approval'].includes(job.status) && <Button size="sm" variant="primary" onClick={() => { void openPreview(job) }}>Review preview</Button>}{canOperate && ['queued', 'running'].includes(job.status) && <button className="icon-button" onClick={() => { void control(job, 'pause') }} aria-label={`Pause ${job.name}`}><Pause size={16} /></button>}{canOperate && job.status === 'paused' && <button className="icon-button" onClick={() => { void control(job, 'resume') }} aria-label={`Resume ${job.name}`}><Play size={16} /></button>}{canOperate && ['queued', 'running', 'paused'].includes(job.status) && <button className="icon-button danger-hover" onClick={() => setCancelTarget(job)} aria-label={`Cancel ${job.name}`}><Ban size={16} /></button>}{canOperate && job.failed > 0 && ['completed_with_errors', 'failed', 'paused'].includes(job.status) && <button className="icon-button" onClick={() => { void retryFailures(job) }} aria-label={`Retry failed records for ${job.name}`}><RefreshCw size={16} /></button>}{job.failed > 0 && ['completed_with_errors', 'failed', 'paused', 'cancelled'].includes(job.status) && <button className="icon-button" onClick={() => { void exportFailures(job) }} aria-label={`Download failed records for ${job.name}`}><Download size={16} /></button>}{canOperate && job.rollbackAvailable && ['completed', 'completed_with_errors'].includes(job.status) && <button className="icon-button" onClick={() => setRollbackTarget(job)} aria-label={`Create rollback preview for ${job.name}`}><RotateCcw size={16} /></button>}</div></td></tr>)}</tbody></table></div> : <EmptyState icon={<FileSpreadsheet />} title="No batch jobs" description="Upload a CSV to validate, deduplicate and preview a bulk operation." action={canOperate ? <Button variant="primary" onClick={() => setCreateOpen(true)}><Plus size={16} />Create batch</Button> : undefined} />}
    </Card>
    <Modal open={createOpen} title="Create a safe batch" description="Upload CSV only. The first pass validates and previews—it never writes data." onClose={() => setCreateOpen(false)} footer={<><Button onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" form="batch-form" variant="primary" busy={action.loading} disabled={!file || (!form.connectionId && form.operation !== 'deduplicate')}>Upload and validate</Button></>}><form id="batch-form" className="form-stack" onSubmit={create}><Field label="Batch name" required><input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required autoFocus placeholder="August contact cleanup" /></Field><div className="form-grid"><Field label="Operation" required><select value={form.operation} onChange={(event) => { const operation = event.target.value; setForm((current) => ({ ...current, operation, connectionId: ['add_tags', 'remove_tags'].includes(operation) && !connectionQuery.data?.some((connection) => connection.id === current.connectionId && connection.provider === 'ghl') ? '' : current.connectionId })) }}><option value="update_contacts">Update contacts</option><option value="add_tags">Add HighLevel tags</option><option value="remove_tags">Remove HighLevel tags</option><option value="sync_records">Sync records</option><option value="deduplicate">Deduplicate only</option></select></Field><Field label="Connection" hint={form.operation === 'deduplicate' ? 'Optional for local deduplication.' : ['add_tags', 'remove_tags'].includes(form.operation) ? 'Only HighLevel supports this batch operation.' : undefined} required={form.operation !== 'deduplicate'}><select value={form.connectionId} onChange={(event) => setForm((current) => ({ ...current, connectionId: event.target.value }))} required={form.operation !== 'deduplicate'} disabled={connectionQuery.loading}><option value="">{connectionQuery.loading ? 'Loading connections…' : form.operation === 'deduplicate' ? 'No connection (local only)' : 'Select a connection'}</option>{availableConnections.map((connection) => <option value={connection.id} key={connection.id}>{connection.name} · {titleCase(connection.provider)}</option>)}</select></Field></div>{connectionQuery.error && <Alert tone="warning">Connections could not be loaded. Refresh this page before creating a connected batch.</Alert>}<Field label="Duplicate matching rule"><select value={form.duplicateRule} onChange={(event) => setForm((current) => ({ ...current, duplicateRule: event.target.value }))}><option value="email_or_phone">Email or normalised phone</option><option value="email">Email only</option><option value="phone">Normalised phone only</option><option value="external_id">Platform external ID</option></select></Field><Field label="CSV file" hint="Maximum size and row limits depend on your plan." required><label className={`file-drop ${file ? 'has-file' : ''}`}><input type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><span><Upload size={23} />{file ? <><strong>{file.name}</strong><small>{(file.size / 1024).toFixed(1)} KB</small></> : <><strong>Choose a CSV file</strong><small>or drag it here</small></>}</span></label></Field></form></Modal>
    <Modal open={Boolean(preview)} title="Dry-run impact review" description="Nothing will be written until you approve this exact preview." onClose={() => setPreview(null)} wide footer={<><Button onClick={() => setPreview(null)}>Cancel</Button><Button variant="primary" busy={action.loading} disabled={approval !== 'APPROVE'} onClick={() => { void approve() }}>Approve and start</Button></>}>
      {preview && <div className="preview-panel"><div className="preview-metrics"><div><span>Affected</span><strong>{formatNumber(preview.preview?.affected ?? preview.total)}</strong></div><div><span>Unchanged</span><strong>{formatNumber(preview.preview?.unchanged)}</strong></div><div><span>Invalid</span><strong className={preview.preview?.invalid ? 'danger-text' : ''}>{formatNumber(preview.preview?.invalid)}</strong></div><div><span>Rollback</span><strong>{preview.rollbackAvailable ? 'Supported' : 'Not available'}</strong></div></div>{preview.preview?.warnings?.length ? <Alert tone="warning"><strong>Review these warnings</strong><ul>{preview.preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Alert> : <Alert tone="success">Validation passed. No external writes occur until this exact preview is approved.</Alert>}<Field label="Type APPROVE to start" hint="Approval and the preview hash are recorded in the audit log." required><input value={approval} onChange={(event) => setApproval(event.target.value.toUpperCase())} placeholder="APPROVE" autoComplete="off" /></Field></div>}
    </Modal>
    <ConfirmDialog open={Boolean(cancelTarget)} title="Cancel batch job?" description="Processing will stop at the next safe checkpoint. Records already completed will not be reversed automatically." confirmLabel="Cancel batch" danger busy={action.loading} onClose={() => setCancelTarget(null)} onConfirm={() => { void cancel() }} />
    <ConfirmDialog open={Boolean(rollbackTarget)} title="Create rollback job?" description="LogicFlower will use the encrypted before-state snapshot to preview a compensating batch. You must approve that preview separately." confirmLabel="Create rollback preview" busy={action.loading} onClose={() => setRollbackTarget(null)} onConfirm={() => { void rollback() }} />
  </>
}
