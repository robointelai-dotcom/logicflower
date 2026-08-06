import React from 'react'
import { Archive, ArrowRightLeft, Check, FileDiff, Plus, Search, ShieldCheck } from 'lucide-react'
import { getList } from '../api/client'
import { Alert, Button, Card, EmptyState, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord, VaultSnapshot } from '../types'
import { formatDate } from '../utils/format'

interface DiffItem extends UnknownRecord { id: string; path?: string; type?: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown }

async function loadSnapshots(): Promise<VaultSnapshot[]> {
  const rows = (await getList<VaultSnapshot & UnknownRecord>('/vault/snapshots', ['snapshots'])).items
  const versions = new Map<string, number>()
  return rows.slice().reverse().map((item) => {
    const raw = item as UnknownRecord
    const resourceKey = String(raw.externalWorkflowId ?? item.resourceName ?? item.id)
    const version = (versions.get(resourceKey) ?? 0) + 1
    versions.set(resourceKey, version)
    return { ...item, resourceName: String(item.resourceName ?? raw.name ?? raw.externalWorkflowId ?? 'Platform workflow'), platform: String(item.platform ?? raw.provider ?? 'Platform'), version, createdAt: String(item.createdAt ?? raw.capturedAt ?? ''), changeType: item.changeType ?? 'snapshot' }
  }).reverse()
}

export default function VaultPage() {
  const query = useApi(loadSnapshots, [])
  const action = useAction()
  const [search, setSearch] = React.useState('')
  const [selected, setSelected] = React.useState<string[]>([])
  const [diffOpen, setDiffOpen] = React.useState(false)
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [diff, setDiff] = React.useState<DiffItem[]>([])
  const filtered = (query.data ?? []).filter((item) => `${item.resourceName} ${item.platform ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length >= 2 ? [current[1] ?? id, id] : [...current, id])
  const compare = async () => {
    if (selected.length !== 2) return
    setDiffOpen(true); setDiffLoading(true)
    const result = await action.run(() => getList<DiffItem>('/vault/diff', ['changes'], { params: { before: selected[0], after: selected[1] } }))
    if (result) setDiff(result.items.map((item, index) => ({ ...item, id: item.id || `${item.path ?? 'change'}-${index}` })))
    setDiffLoading(false)
  }

  return <>
    <PageHeader eyebrow="Version protection" title="Workflow Vault" description="Encrypted snapshots and structural differences captured by connection monitoring." actions={<Button disabled={selected.length !== 2} onClick={() => { void compare() }}><ArrowRightLeft size={16} />Compare {selected.length}/2</Button>} />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}{action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}
    <Card className="security-note"><ShieldCheck size={21} /><div><strong>Encrypted, evidence-focused history</strong><p>Vault preserves supported definitions and shows structural differences. Restoration is never offered unless complete before-state coverage and a safe platform capability are available.</p></div></Card>
    <Card>
      <div className="table-toolbar"><div className="search-input"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search snapshots" aria-label="Search snapshots" /></div><span className="selection-help">Select two versions to compare</span></div>
      {query.loading ? <SkeletonRows rows={6} columns={6} /> : query.error ? <Alert>{query.error}</Alert> : filtered.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Select</th><th>Resource</th><th>Platform</th><th>Version</th><th>Change</th><th>Captured</th></tr></thead><tbody>{filtered.map((snapshot) => <tr key={snapshot.id} className={selected.includes(snapshot.id) ? 'selected-row' : ''}><td><input type="checkbox" checked={selected.includes(snapshot.id)} onChange={() => toggle(snapshot.id)} aria-label={`Select version ${snapshot.version} of ${snapshot.resourceName}`} /></td><td><div className="entity-name"><span className="entity-icon"><Archive size={17} /></span><div><strong>{snapshot.resourceName}</strong><span>{snapshot.hash ? `Integrity ${snapshot.hash.slice(0, 10)}…` : 'Integrity verified'}</span></div></div></td><td>{snapshot.platform ?? 'LogicFlower'}</td><td><strong>v{snapshot.version}</strong></td><td><StatusBadge status={snapshot.changeType ?? 'snapshot'} /></td><td>{formatDate(snapshot.createdAt)}<small className="table-subline">{snapshot.createdBy ?? 'Automated monitor'}</small></td></tr>)}</tbody></table></div> : <EmptyState icon={<Archive />} title="No snapshots yet" description="Run monitoring on a supported connection to capture its first workflow snapshot." />}
    </Card>
    <Modal open={diffOpen} title="Structural comparison" description="Human-readable changes between the selected versions." onClose={() => setDiffOpen(false)} wide footer={<Button onClick={() => setDiffOpen(false)}>Close comparison</Button>}>
      {diffLoading ? <SkeletonRows rows={5} columns={3} /> : diff.length ? <div className="diff-list">{diff.map((change) => <div key={change.id} className={`diff-${change.type ?? 'changed'}`}><span>{change.type === 'added' ? <Plus /> : change.type === 'removed' ? <FileDiff /> : <ArrowRightLeft />}</span><div><strong>{change.path ?? 'Configuration changed'}</strong><small>{change.type ?? 'changed'}</small>{change.before !== undefined && <code>Before: {JSON.stringify(change.before)}</code>}{change.after !== undefined && <code>After: {JSON.stringify(change.after)}</code>}</div></div>)}</div> : <div className="healthy-state"><Check size={22} /><div><strong>No structural changes</strong><span>These snapshots contain equivalent supported definitions.</span></div></div>}
    </Modal>
  </>
}
