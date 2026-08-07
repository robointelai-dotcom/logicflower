import React from 'react'
import { GitBranch, Plus } from 'lucide-react'
import { getList, getOne, send } from '../api/client'
import { Link } from '../router'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'

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
  const action = useAction()
  const [pipelineId, setPipelineId] = React.useState('')
  const [dragging, setDragging] = React.useState<string | null>(null)
  const [overStage, setOverStage] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState({ title: '', contactId: '', valueMinorUnits: '', currency: 'USD', stageId: '' })

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

  return <>
    <PageHeader
      eyebrow="Micro-CRM"
      title="Pipeline"
      description="Drag a deal between stages. Moving a deal can start or stop a sequence and raise tasks."
      actions={<>
        {pipelines.data && pipelines.data.length > 1 && <select value={pipelineId} onChange={(event) => setPipelineId(event.target.value)} aria-label="Pipeline">
          {pipelines.data.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
        </select>}
        <Button variant="primary" disabled={!pipelineId} onClick={() => setOpen(true)}><Plus size={16} />New deal</Button>
      </>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    {pipelines.loading || board.loading ? <SkeletonRows rows={4} columns={4} />
      : pipelines.error ? <Alert>{pipelines.error}</Alert>
        : !pipelines.data?.length ? <Card><EmptyState icon={<GitBranch />} title="No pipelines yet" description="Apply an industry snapshot during onboarding, or create a pipeline in settings." /></Card>
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
