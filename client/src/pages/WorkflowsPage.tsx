import React from 'react'
import { Copy, Pause, Pencil, Play, Plus, Search, Trash2, Workflow as WorkflowIcon } from 'lucide-react'
import { Link, useNavigate } from '../router'
import { getList, send } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, Button, Card, ConfirmDialog, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord, Workflow } from '../types'
import { formatDate } from '../utils/format'

async function loadWorkflows(): Promise<Workflow[]> {
  const result = await getList<Workflow & UnknownRecord>('/workflows', ['workflows'])
  return result.items.map((item) => ({ ...item, name: item.name || 'Untitled workflow', status: item.status ?? 'draft', nodes: Array.isArray(item.nodes) ? item.nodes : [], edges: Array.isArray(item.edges) ? item.edges : [] }))
}

export default function WorkflowsPage() {
  const { session } = useAuth()
  const navigate = useNavigate()
  const query = useApi(loadWorkflows, [session?.organization?.id])
  const action = useAction()
  const [search, setSearch] = React.useState('')
  const [status, setStatus] = React.useState('all')
  const [createOpen, setCreateOpen] = React.useState(false)
  const [newWorkflow, setNewWorkflow] = React.useState({ name: '', description: '' })
  const [deleteTarget, setDeleteTarget] = React.useState<Workflow | null>(null)
  const canEdit = ['owner', 'admin', 'operator'].includes(session?.organization?.role ?? '')
  const filtered = (query.data ?? []).filter((workflow) => (status === 'all' || workflow.status === status) && `${workflow.name} ${workflow.description ?? ''}`.toLowerCase().includes(search.toLowerCase()))

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const created = await action.run(() => send<Workflow>('post', '/workflows', { ...newWorkflow, nodes: [], edges: [], status: 'draft' }))
    if (created?.id) { setCreateOpen(false); navigate(`/workflows/${created.id}/builder`) }
  }
  const duplicate = async (workflow: Workflow) => { await action.run(() => send('post', `/workflows/${workflow.id}/duplicate`), 'Workflow duplicated.'); await query.reload() }
  const changeStatus = async (workflow: Workflow, next: 'draft' | 'published') => { await action.run(() => send('patch', `/workflows/${workflow.id}/status`, { status: next }), next === 'published' ? 'Workflow published.' : 'Workflow returned to draft.'); await query.reload() }
  const remove = async () => {
    if (!deleteTarget) return
    const done = await action.run(async () => { await send('delete', `/workflows/${deleteTarget.id}`); return true }, 'Workflow deleted.')
    if (done) { setDeleteTarget(null); await query.reload() }
  }

  return <>
    <PageHeader eyebrow="Automation" title="Workflows" description="Build structured, reviewable automations without arbitrary code." actions={canEdit && <Button variant="primary" onClick={() => setCreateOpen(true)}><Plus size={16} />New workflow</Button>} />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}{action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}
    <Card>
      <div className="table-toolbar"><div className="search-input"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search workflows" aria-label="Search workflows" /></div><select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by status"><option value="all">All statuses</option><option value="published">Published</option><option value="draft">Draft</option><option value="paused">Paused</option><option value="archived">Archived</option></select></div>
      {query.loading ? <SkeletonRows rows={5} columns={5} /> : query.error ? <Alert>{query.error}</Alert> : filtered.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Workflow</th><th>Status</th><th>Nodes</th><th>Last run</th><th>Updated</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{filtered.map((workflow) => <tr key={workflow.id}><td><Link className="entity-name" to={`/workflows/${workflow.id}/builder`}><span className="entity-icon"><WorkflowIcon size={17} /></span><div><strong>{workflow.name}</strong><span>{workflow.description || 'No description'}</span></div></Link></td><td><StatusBadge status={workflow.status} /></td><td>{workflow.nodes.length}</td><td>{formatDate(workflow.lastRunAt)}</td><td>{formatDate(workflow.updatedAt)}</td><td><div className="inline-actions"><Link className="icon-button" to={`/workflows/${workflow.id}/builder`} aria-label={`Edit ${workflow.name}`}><Pencil size={16} /></Link>{canEdit && <><button className="icon-button" aria-label={`Duplicate ${workflow.name}`} onClick={() => { void duplicate(workflow) }}><Copy size={16} /></button>{workflow.status === 'published' ? <button className="icon-button" aria-label={`Return ${workflow.name} to draft`} onClick={() => { void changeStatus(workflow, 'draft') }}><Pause size={16} /></button> : <button className="icon-button" aria-label={`Publish ${workflow.name}`} onClick={() => { void changeStatus(workflow, 'published') }}><Play size={16} /></button>}<button className="icon-button danger-hover" aria-label={`Delete ${workflow.name}`} onClick={() => setDeleteTarget(workflow)}><Trash2 size={16} /></button></>}</div></td></tr>)}</tbody></table></div> : <EmptyState icon={<WorkflowIcon />} title={search || status !== 'all' ? 'No workflows match' : 'Create your first workflow'} description={search || status !== 'all' ? 'Clear the filters to see more workflows.' : 'Use the structured builder to connect triggers, rules, transformations and approved actions.'} action={canEdit && !search && status === 'all' ? <Button variant="primary" onClick={() => setCreateOpen(true)}><Plus size={16} />Create workflow</Button> : undefined} />}
    </Card>
    <Modal open={createOpen} title="Create workflow" description="Start with a clear name. You can add safe nodes in the next step." onClose={() => setCreateOpen(false)} footer={<><Button onClick={() => setCreateOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="create-workflow" busy={action.loading}>Create and open builder</Button></>}><form id="create-workflow" className="form-stack" onSubmit={create}><Field label="Workflow name" required><input value={newWorkflow.name} onChange={(event) => setNewWorkflow((current) => ({ ...current, name: event.target.value }))} required autoFocus maxLength={120} placeholder="New customer qualification" /></Field><Field label="Description"><textarea value={newWorkflow.description} onChange={(event) => setNewWorkflow((current) => ({ ...current, description: event.target.value }))} rows={3} maxLength={500} placeholder="What this workflow does and when it should run" /></Field></form></Modal>
    <ConfirmDialog open={Boolean(deleteTarget)} title="Delete workflow?" description={`${deleteTarget?.name ?? 'This workflow'} and its active schedules will be removed. Execution and audit history will be retained.`} confirmLabel="Delete workflow" danger busy={action.loading} onClose={() => setDeleteTarget(null)} onConfirm={() => { void remove() }} />
  </>
}
