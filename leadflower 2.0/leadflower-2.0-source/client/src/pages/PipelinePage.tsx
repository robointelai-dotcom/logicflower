import React from 'react'
import { GitBranch, Plus, Settings2, Trash2 } from 'lucide-react'
import { getList, getOne, send } from '../api/client'
import { Link } from '../router'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows } from '../components/ui'
import { HelpLink } from './HelpPage'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'
import { usePermissions } from '../hooks/usePermissions'

interface BoardDeal {
  id: string
  title: string
  contactId: string
  valueMinorUnits: number
  currency: string
  ownerUserId?: string | null
  status: string
}

interface BoardStage {
  stageId: string
  name: string
  outcome: 'open' | 'won' | 'lost'
  pageValueMinorUnits: number
  truncated: boolean
  deals: BoardDeal[]
}

interface PipelineSummary extends UnknownRecord {
  id: string
  name: string
  stages: Array<{ stageId: string; name: string; outcome?: string }>
}

/**
 * Currency is stored in minor units throughout, so display divides by 100 here
 * rather than anywhere arithmetic happens. Totals are summed as integers and
 * only ever formatted at the edge.
 */
function money(minorUnits: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(minorUnits / 100)
  } catch {
    return `${(minorUnits / 100).toFixed(2)} ${currency || ''}`.trim()
  }
}

export default function PipelinePage() {
  const { canOperate } = usePermissions()
  const action = useAction()
  const [pipelineId, setPipelineId] = React.useState('')
  const [dragging, setDragging] = React.useState<string | null>(null)
  const [overStage, setOverStage] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState({ title: '', contactId: '', valueMinorUnits: '', currency: 'USD', stageId: '' })
  const [stagesOpen, setStagesOpen] = React.useState(false)
  const [newPipelineOpen, setNewPipelineOpen] = React.useState(false)
  const [pipelineName, setPipelineName] = React.useState('')
  const [draftStages, setDraftStages] = React.useState<Array<{ stageId?: string; name: string; outcome: 'open' | 'won' | 'lost' }>>([])

  const pipelines = useApi(async () => (await getList<PipelineSummary>('/crm/pipelines', ['pipelines'])).items, [])

  React.useEffect(() => {
    if (!pipelineId && pipelines.data?.length) setPipelineId(pipelines.data[0]!.id)
  }, [pipelines.data, pipelineId])

  const board = useApi(async () => {
    if (!pipelineId) return null
    return await getOne<{ id: string; name: string; stages: BoardStage[] }>(`/crm/pipelines/${pipelineId}/board`)
  }, [pipelineId])

  const move = async (dealId: string, stageId: string) => {
    const result = await action.run(() => send('post', `/crm/deals/${dealId}/stage`, { stageId }), 'Deal moved.')
    // Reloaded rather than patched locally: a stage change fires sequence
    // enrolments and raises tasks server-side, so the board must reflect what
    // actually happened rather than what was optimistically assumed.
    if (result !== undefined) await board.reload()
  }

  const createDeal = async (event: React.FormEvent) => {
    event.preventDefault()
    const value = Math.round(Number(form.valueMinorUnits || 0) * 100)
    const result = await action.run(() => send('post', '/crm/deals', {
      title: form.title,
      contactId: form.contactId,
      pipelineId,
      stageId: form.stageId || undefined,
      valueMinorUnits: Number.isFinite(value) ? value : 0,
      currency: form.currency,
    }), 'Deal created.')
    if (result !== undefined) {
      setOpen(false)
      setForm({ title: '', contactId: '', valueMinorUnits: '', currency: 'USD', stageId: '' })
      await board.reload()
    }
  }

  const stages = board.data?.stages ?? []

  const openStageEditor = () => {
    const current = pipelines.data?.find((pipeline) => pipeline.id === pipelineId)
    setDraftStages((current?.stages ?? []).map((stage: any) => ({
      stageId: stage.stageId, name: stage.name, outcome: stage.outcome ?? 'open',
    })))
    setStagesOpen(true)
  }

  const saveStages = async (event: React.FormEvent) => {
    event.preventDefault()
    // Existing stageIds are sent back unchanged, so renaming a stage does not
    // orphan the deals in it or break a sequence trigger bound to it.
    const result = await action.run(() => send('put', `/crm/pipelines/${pipelineId}/stages`, {
      stages: draftStages.filter((stage) => stage.name.trim()),
    }), 'Stages saved.')
    if (result !== undefined) { setStagesOpen(false); await pipelines.reload(); await board.reload() }
  }

  const createPipeline = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send<{ id: string }>('post', '/crm/pipelines', {
      name: pipelineName,
      stages: [
        { name: 'New inquiry' }, { name: 'Quoted' }, { name: 'Scheduled' },
        { name: 'Won', outcome: 'won' }, { name: 'Lost', outcome: 'lost' },
      ],
    }), 'Pipeline created.')
    if (result) { setNewPipelineOpen(false); setPipelineName(''); await pipelines.reload(); setPipelineId(result.id) }
  }

  const moveStage = (index: number, delta: number) => setDraftStages((current) => {
    const next = [...current]
    const target = index + delta
    if (target < 0 || target >= next.length) return current
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    return next
  })

  return <>
    <PageHeader
      eyebrow="Micro-CRM"
      title="Pipeline"
      description="Drag a deal between stages. Moving a deal can start or stop a sequence and raise tasks."
      actions={<>
        {pipelines.data && pipelines.data.length > 1 && <select value={pipelineId} onChange={(event) => setPipelineId(event.target.value)} aria-label="Pipeline">
          {pipelines.data.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
        </select>}
        {pipelineId && <Button onClick={openStageEditor}><Settings2 size={15} />
    <HelpLink route="/pipeline" />Edit stages</Button>}
        {canOperate && <Button variant="primary" disabled={!pipelineId} onClick={() => setOpen(true)}><Plus size={16} />New deal</Button>}
      </>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    {pipelines.loading || board.loading ? <SkeletonRows rows={4} columns={4} />
      : pipelines.error ? <Alert>{pipelines.error}</Alert>
        : !pipelines.data?.length ? <Card><EmptyState
          icon={<GitBranch />}
          title="No pipelines yet"
          description="A pipeline is the set of stages your work moves through. Set up your workspace to get one written for your trade, or create your own."
          action={canOperate ? <Button variant="primary" onClick={() => setNewPipelineOpen(true)}><Plus size={16} />Create a pipeline</Button> : undefined}
        /></Card>
          : <div className="kanban">
            {stages.map((stage) => <section
              key={stage.stageId}
              className={`kanban-column${overStage === stage.stageId ? ' kanban-column-over' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setOverStage(stage.stageId) }}
              onDragLeave={() => setOverStage((current) => current === stage.stageId ? null : current)}
              onDrop={(event) => {
                event.preventDefault()
                setOverStage(null)
                const dealId = dragging || event.dataTransfer.getData('text/plain')
                setDragging(null)
                // A drop onto the stage a deal is already in is a no-op, not a
                // request the server should have to reject.
                if (dealId && !stage.deals.some((deal) => deal.id === dealId)) void move(dealId, stage.stageId)
              }}
            >
              <header>
                <h2>{stage.name}</h2>
                <span className="muted">{stage.deals.length}{stage.truncated ? '+' : ''}</span>
              </header>
              <p className="kanban-total">{money(stage.pageValueMinorUnits, stage.deals[0]?.currency ?? 'USD')}{stage.truncated ? ' (page)' : ''}</p>
              <div className="kanban-cards">
                {stage.deals.map((deal) => <article
                  key={deal.id}
                  className="kanban-card"
                  draggable
                  onDragStart={(event) => { setDragging(deal.id); event.dataTransfer.setData('text/plain', deal.id) }}
                  onDragEnd={() => setDragging(null)}
                >
                  <strong>{deal.title}</strong>
                  <span className="muted">{money(deal.valueMinorUnits, deal.currency)}</span>
                  <Link to={`/contacts/${deal.contactId}`}>View contact</Link>
                </article>)}
                {!stage.deals.length && <p className="muted kanban-empty">Nothing here</p>}
              </div>
            </section>)}
          </div>}

    <Modal
      open={stagesOpen}
      title="Pipeline stages"
      description="Renaming a stage keeps every deal in it. A stage that still holds deals cannot be removed."
      onClose={() => setStagesOpen(false)}
      footer={<><Button onClick={() => setStagesOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="stages-form" busy={action.loading}>Save stages</Button></>}
    >
      <form id="stages-form" className="form-stack" onSubmit={saveStages}>
        <ol className="stage-editor">
          {draftStages.map((stage, index) => <li key={stage.stageId ?? `new-${index}`}>
            <input
              value={stage.name}
              onChange={(event) => setDraftStages((current) => current.map((item, position) => position === index ? { ...item, name: event.target.value } : item))}
              placeholder="Stage name"
              aria-label={`Stage ${index + 1} name`}
            />
            <select
              value={stage.outcome}
              onChange={(event) => setDraftStages((current) => current.map((item, position) => position === index ? { ...item, outcome: event.target.value as 'open' | 'won' | 'lost' } : item))}
              aria-label={`Stage ${index + 1} outcome`}
            >
              <option value="open">In progress</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
            </select>
            <div className="stage-tools">
              <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => moveStage(index, -1)} aria-label="Move up">↑</Button>
              <Button size="sm" variant="ghost" disabled={index === draftStages.length - 1} onClick={() => moveStage(index, 1)} aria-label="Move down">↓</Button>
              <Button size="sm" variant="ghost" disabled={draftStages.length === 1} onClick={() => setDraftStages((current) => current.filter((_, position) => position !== index))} aria-label="Remove"><Trash2 size={13} /></Button>
            </div>
          </li>)}
        </ol>
        <Button onClick={() => setDraftStages((current) => [...current, { name: '', outcome: 'open' }])}><Plus size={15} />Add stage</Button>
        <p className="muted">Every pipeline needs at least one stage still in progress, or a live deal has nowhere to sit.</p>
      </form>
    </Modal>

    <Modal
      open={newPipelineOpen}
      title="New pipeline"
      description="Starts with five common stages. Rename or replace them afterwards."
      onClose={() => setNewPipelineOpen(false)}
      footer={<><Button onClick={() => setNewPipelineOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="pipeline-form" busy={action.loading}>Create</Button></>}
    >
      <form id="pipeline-form" className="form-stack" onSubmit={createPipeline}>
        <Field label="Name" required><input value={pipelineName} onChange={(event) => setPipelineName(event.target.value)} required autoFocus placeholder="Jobs" /></Field>
      </form>
    </Modal>

    <Modal
      open={open}
      title="New deal"
      description="Deals sit against a contact. Moving one between stages can trigger follow-up automatically."
      onClose={() => setOpen(false)}
      footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="deal-form" busy={action.loading}>Create deal</Button></>}
    >
      <form id="deal-form" className="form-stack" onSubmit={createDeal}>
        <Field label="Title" required><input value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} required autoFocus /></Field>
        <Field label="Contact id" hint="Open a contact and copy its identifier from the address bar." required><input value={form.contactId} onChange={(event) => setForm((current) => ({ ...current, contactId: event.target.value }))} required /></Field>
        <div className="field-row">
          <Field label="Value" hint="In major units, e.g. 1250.00"><input inputMode="decimal" value={form.valueMinorUnits} onChange={(event) => setForm((current) => ({ ...current, valueMinorUnits: event.target.value }))} /></Field>
          <Field label="Currency"><input value={form.currency} maxLength={3} onChange={(event) => setForm((current) => ({ ...current, currency: event.target.value.toUpperCase() }))} /></Field>
        </div>
        <Field label="Stage">
          <select value={form.stageId} onChange={(event) => setForm((current) => ({ ...current, stageId: event.target.value }))}>
            <option value="">First stage</option>
            {stages.map((stage) => <option key={stage.stageId} value={stage.stageId}>{stage.name}</option>)}
          </select>
        </Field>
      </form>
    </Modal>
  </>
}
