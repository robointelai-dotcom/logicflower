import React from 'react'
import { Check, Hammer, HeartPulse, Briefcase, Sparkles } from 'lucide-react'
import { getOne, send } from '../api/client'
import { useNavigate } from '../router'
import { Alert, Button, Card, PageHeader, SkeletonRows } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'

/**
 * Onboarding.
 *
 * Closes the finding behind four others: a new workspace starts completely
 * empty, so Pipeline has no stages, Sequences has nothing to publish, and every
 * create button is correctly but confusingly disabled.
 *
 * One choice here seeds a pipeline, custom fields, follow-up sequences and an
 * inquiry form. Everything it creates is ordinary and editable — the pack is a
 * starting point, not a mould.
 */

interface SnapshotSummary {
  id: string
  name: string
  description?: string
  customFieldCount: number
  stageCount: number
  sequenceCount: number
  formCount: number
  operatorNotes: string[]
}

interface ApplyResult {
  customFields: { created: string[]; skipped: string[] }
  pipeline: { created: string | null; skipped: string | null }
  sequences: { created: string[]; skipped: string[] }
  forms: { created: string[]; skipped: string[] }
  operatorNotes: string[]
}

const ICONS: Record<string, React.ReactNode> = {
  trades: <Hammer size={22} />,
  healthcare_wellness: <HeartPulse size={22} />,
  professional_services: <Briefcase size={22} />,
}

export default function OnboardingWizardPage() {
  const navigate = useNavigate()
  const action = useAction()
  const [selected, setSelected] = React.useState<string | null>(null)
  const [applied, setApplied] = React.useState<ApplyResult | null>(null)

  const snapshots = useApi(async () => (await getOne<{ snapshots: SnapshotSummary[] }>('/inbox/snapshots')).snapshots, [])

  const apply = async () => {
    if (!selected) return
    const result = await action.run(() => send<ApplyResult>('post', `/inbox/snapshots/${selected}/apply`, {}),
      'Your workspace is set up.')
    if (result) setApplied(result)
  }

  if (snapshots.loading) return <SkeletonRows rows={3} columns={3} />

  if (applied) {
    return <>
      <PageHeader eyebrow="Setup" title="You're set up" description="Everything below is yours to change — the pack is a starting point, not a mould." />
      <Card>
        <ul className="setup-summary">
          {applied.pipeline.created && <li><Check size={16} />Pipeline created with its stages</li>}
          {applied.customFields.created.length > 0 && <li><Check size={16} />{applied.customFields.created.length} custom fields added</li>}
          {applied.sequences.created.length > 0 && <li><Check size={16} />{applied.sequences.created.length} follow-up sequences written, saved as drafts</li>}
          {applied.forms.created.length > 0 && <li><Check size={16} />{applied.forms.created.length} inquiry form created as a draft</li>}
        </ul>
        {/*
          Stated rather than assumed: nothing starts messaging anyone until a
          person reads it and turns it on.
        */}
        <Alert tone="info">
          Sequences and forms are saved as <strong>drafts</strong>. Nothing will message anyone until you read
          it in your own voice and activate it.
        </Alert>
        {Boolean(applied.operatorNotes.length) && <div className="operator-notes">
          <h3>Worth reading before you activate anything</h3>
          <ul>{applied.operatorNotes.map((note) => <li key={note}>{note}</li>)}</ul>
        </div>}
      </Card>
      <div className="setup-actions">
        <Button variant="primary" onClick={() => navigate('/sequences')}>Review the sequences</Button>
        <Button onClick={() => navigate('/pipeline')}>See the pipeline</Button>
        <Button variant="ghost" onClick={() => navigate('/dashboard')}>Go to Today</Button>
      </div>
    </>
  }

  return <>
    <PageHeader
      eyebrow="Setup"
      title="What kind of work do you do?"
      description="Pick the closest match and we'll set up your pipeline, fields, follow-up and inquiry form. Change anything afterwards."
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}

    <div className="snapshot-grid">
      {snapshots.data?.map((snapshot) => <button
        type="button"
        key={snapshot.id}
        className={selected === snapshot.id ? 'snapshot-card selected' : 'snapshot-card'}
        onClick={() => setSelected(snapshot.id)}
        aria-pressed={selected === snapshot.id}
      >
        <span className="snapshot-icon">{ICONS[snapshot.id] ?? <Sparkles size={22} />}</span>
        <strong>{snapshot.name}</strong>
        <span className="muted">{snapshot.description}</span>
        <span className="snapshot-counts">
          {snapshot.stageCount} stages · {snapshot.sequenceCount} sequences · {snapshot.customFieldCount} fields
        </span>
      </button>)}
    </div>

    <div className="setup-actions">
      <Button variant="primary" busy={action.loading} disabled={!selected} onClick={() => { void apply() }}>
        Set up my workspace
      </Button>
      {/*
        Skipping is allowed but honest about the consequence, rather than
        leaving somebody to discover the empty state themselves.
      */}
      <Button variant="ghost" onClick={() => navigate('/dashboard')}>
        Skip — I'll build it myself
      </Button>
    </div>
    <p className="muted setup-note">
      Skipping leaves your workspace empty. You can apply a pack later from Settings, or create a pipeline
      and sequences by hand.
    </p>
  </>
}
