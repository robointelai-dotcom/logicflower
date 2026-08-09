import React from 'react'
import { ArrowLeft, ArrowDown, Copy, Mail, MessageSquare, Trash2 } from 'lucide-react'
import { getOne, send } from '../api/client'
import { Link, useParams } from '../router'
import { Alert, Button, Card, Field, PageHeader, SkeletonRows } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'

/**
 * The sequence step editor.
 *
 * Versions are immutable: editing loads the published version, changes it, and
 * publishes a NEW one. Anybody already part-way through the old version keeps
 * running on it until they finish, which is what stops an edit from silently
 * changing what a contact is about to receive.
 *
 * Validation goes through the same server-side validator the publish path uses,
 * rather than a second copy of the rules here. A client that permits something
 * the server rejects is worse than no validation at all — it lets somebody
 * spend ten minutes writing a sequence that cannot be saved.
 */

type Channel = 'email' | 'sms'
type WaitKind = 'immediate' | 'duration' | 'time_of_day'

interface Step {
  channel: Channel
  wait: { kind: WaitKind; minutes?: number; hour?: number; minute?: number; afterMinutes?: number }
  subjectTemplate?: string
  bodyTemplate?: string
}

interface VersionResponse {
  id: string
  version: number
  definition: {
    steps: Step[]
    quietHours?: { enabled: boolean; startMinute: number; endMinute: number }
    defaultTimeZone?: string
  }
}

/** Merge fields the engine resolves at send time. */
const VARIABLES = ['contact.firstName', 'contact.lastName', 'contact.name', 'contact.companyName']

const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

/** Plain-English summary of a wait, so the timing reads as a sentence. */
function describeWait(step: Step, index: number): string {
  if (index === 0 && step.wait.kind === 'immediate') return 'Sent straight away'
  if (step.wait.kind === 'immediate') return 'Sent immediately after the previous step'
  if (step.wait.kind === 'duration') {
    const minutes = step.wait.minutes ?? 0
    if (minutes >= 1440) return `${Math.round(minutes / 1440 * 10) / 10} days after the previous step`
    if (minutes >= 60) return `${Math.round(minutes / 60 * 10) / 10} hours after the previous step`
    return `${minutes} minutes after the previous step`
  }
  return `At ${clock((step.wait.hour ?? 9) * 60 + (step.wait.minute ?? 0))} in the contact's own timezone`
}

function newStep(channel: Channel = 'email'): Step {
  return {
    channel,
    wait: { kind: 'duration', minutes: 1440 },
    ...(channel === 'email' ? { subjectTemplate: '', bodyTemplate: '' } : { bodyTemplate: '' }),
  }
}

export default function SequenceEditorPage() {
  const params = useParams()
  const sequenceId = params.id ?? ''
  const action = useAction()

  const [steps, setSteps] = React.useState<Step[]>([])
  const [quietHours, setQuietHours] = React.useState({ enabled: true, startMinute: 1260, endMinute: 480 })
  const [timeZone, setTimeZone] = React.useState('UTC')
  const [issues, setIssues] = React.useState<string[]>([])
  const [loaded, setLoaded] = React.useState(false)

  const sequence = useApi(async () => {
    if (!sequenceId) return null
    const detail = await getOne<{ sequences?: unknown; id?: string; name?: string; publishedVersionId?: string | null }>(`/sequences/${sequenceId}`)
      .catch(() => null)
    return detail
  }, [sequenceId])

  const version = useApi(async () => {
    if (!sequenceId) return null
    const list = await getOne<{ versions: Array<{ id: string; version: number }> }>(`/sequences/${sequenceId}/versions`)
    const latest = list.versions?.[0]
    if (!latest) return null
    return await getOne<VersionResponse>(`/sequences/${sequenceId}/versions/${latest.id}`)
  }, [sequenceId])

  React.useEffect(() => {
    if (loaded) return
    if (version.loading) return
    // Seed from the published version if there is one, otherwise start with a
    // single step so the canvas is never an empty void.
    if (version.data?.definition) {
      setSteps(version.data.definition.steps.length ? version.data.definition.steps : [newStep()])
      if (version.data.definition.quietHours) setQuietHours(version.data.definition.quietHours)
      if (version.data.definition.defaultTimeZone) setTimeZone(version.data.definition.defaultTimeZone)
    } else {
      setSteps([{ ...newStep(), wait: { kind: 'immediate' } }])
      setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    }
    setLoaded(true)
  }, [version.loading, version.data, loaded])

  const definition = React.useMemo(() => ({
    steps: steps.map((step) => ({
      channel: step.channel,
      wait: step.wait,
      ...(step.channel === 'email' ? { subjectTemplate: step.subjectTemplate ?? '' } : {}),
      bodyTemplate: step.bodyTemplate ?? '',
    })),
    quietHours,
    defaultTimeZone: timeZone,
  }), [steps, quietHours, timeZone])

  /**
   * Validate against the server, debounced.
   *
   * The same validator the publish path runs, so the editor cannot accept
   * something publishing would reject.
   */
  React.useEffect(() => {
    if (!loaded || !sequenceId) return
    const timer = window.setTimeout(async () => {
      try {
        const result = await send<{ valid: boolean; issues: string[] }>('post', `/sequences/${sequenceId}/versions/validate`, { definition })
        setIssues(result.valid ? [] : result.issues)
      } catch { /* Validation is advisory; publishing is the authority. */ }
    }, 400)
    return () => window.clearTimeout(timer)
  }, [definition, loaded, sequenceId])

  const update = (index: number, patch: Partial<Step>) =>
    setSteps((current) => current.map((step, position) => position === index ? { ...step, ...patch } : step))

  const move = (index: number, delta: number) => setSteps((current) => {
    const next = [...current]
    const target = index + delta
    if (target < 0 || target >= next.length) return current
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    return next
  })

  const publish = async () => {
    const result = await action.run(() => send('post', `/sequences/${sequenceId}/versions`, { definition }),
      'Published. Activate the sequence to start sending.')
    if (result !== undefined) await version.reload()
  }

  const insertVariable = (index: number, variable: string) =>
    update(index, { bodyTemplate: `${steps[index]?.bodyTemplate ?? ''}{{${variable}}}` })

  if (version.loading && !loaded) return <SkeletonRows rows={5} columns={2} />

  return <>
    <p className="back-link"><Link to="/sequences"><ArrowLeft size={13} /> All sequences</Link></p>
    <PageHeader
      eyebrow="Follow-up engine"
      title={sequence.data?.name ? `Editing “${sequence.data.name}”` : 'Sequence steps'}
      description="Each step waits, then sends. Publishing creates a new version — anyone part-way through the old one finishes on it."
      actions={<Button variant="primary" busy={action.loading} disabled={Boolean(issues.length) || !steps.length} onClick={() => { void publish() }}>
        Publish version{version.data ? ` ${version.data.version + 1}` : ''}
      </Button>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    {/* Issues appear as you type, not only when publishing is refused. */}
    {Boolean(issues.length) && <Alert tone="warning">
      <strong>Not ready to publish:</strong>
      <ul className="issue-list">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
    </Alert>}

    <div className="editor-layout">
      <div className="editor-steps">
        {steps.map((step, index) => <Card key={index} className="step-card">
          <header className="step-head">
            <span className="step-number">{index + 1}</span>
            <div className="step-title">
              <strong>{step.channel === 'email' ? 'Email' : 'Text message'}</strong>
              {/* The timing as a sentence, so the schedule is readable at a glance. */}
              <span className="muted">{describeWait(step, index)}</span>
            </div>
            <div className="step-tools">
              <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">↑</Button>
              <Button size="sm" variant="ghost" disabled={index === steps.length - 1} onClick={() => move(index, 1)} aria-label="Move down">↓</Button>
              <Button size="sm" variant="ghost" onClick={() => setSteps((current) => [...current.slice(0, index + 1), { ...step }, ...current.slice(index + 1)])} aria-label="Duplicate"><Copy size={14} /></Button>
              <Button size="sm" variant="ghost" disabled={steps.length === 1} onClick={() => setSteps((current) => current.filter((_, position) => position !== index))} aria-label="Delete"><Trash2 size={14} /></Button>
            </div>
          </header>

          <div className="step-body">
            <div className="field-row">
              <Field label="Channel">
                <select value={step.channel} onChange={(event) => {
                  const channel = event.target.value as Channel
                  // Subject is dropped on SMS: the validator rejects one, and
                  // silently carrying it would fail at publish with a confusing
                  // message.
                  update(index, { channel, ...(channel === 'sms' ? { subjectTemplate: undefined } : { subjectTemplate: step.subjectTemplate ?? '' }) })
                }}>
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                </select>
              </Field>
              <Field label="When">
                <select value={step.wait.kind} onChange={(event) => {
                  const kind = event.target.value as WaitKind
                  update(index, { wait: kind === 'duration' ? { kind, minutes: 1440 } : kind === 'time_of_day' ? { kind, hour: 9, minute: 0 } : { kind } })
                }}>
                  <option value="immediate">{index === 0 ? 'Straight away' : 'Immediately after'}</option>
                  <option value="duration">After a wait</option>
                  <option value="time_of_day">At a time of day</option>
                </select>
              </Field>
            </div>

            {step.wait.kind === 'duration' && <Field label="Wait for" hint="Measured from when the previous step completed.">
              <div className="wait-row">
                <input type="number" min={0} value={Math.floor((step.wait.minutes ?? 0) / 1440)} onChange={(event) => {
                  const days = Math.max(0, Number(event.target.value))
                  const hours = Math.floor(((step.wait.minutes ?? 0) % 1440) / 60)
                  update(index, { wait: { kind: 'duration', minutes: days * 1440 + hours * 60 } })
                }} /><span>days</span>
                <input type="number" min={0} max={23} value={Math.floor(((step.wait.minutes ?? 0) % 1440) / 60)} onChange={(event) => {
                  const hours = Math.max(0, Math.min(23, Number(event.target.value)))
                  const days = Math.floor((step.wait.minutes ?? 0) / 1440)
                  update(index, { wait: { kind: 'duration', minutes: days * 1440 + hours * 60 } })
                }} /><span>hours</span>
              </div>
            </Field>}

            {step.wait.kind === 'time_of_day' && <Field label="Send at" hint="In the contact's own timezone, not yours.">
              <input type="time" value={clock((step.wait.hour ?? 9) * 60 + (step.wait.minute ?? 0))} onChange={(event) => {
                const [hour, minute] = event.target.value.split(':').map(Number)
                update(index, { wait: { kind: 'time_of_day', hour: hour ?? 9, minute: minute ?? 0 } })
              }} />
            </Field>}

            {step.channel === 'email' && <Field label="Subject" required>
              <input value={step.subjectTemplate ?? ''} onChange={(event) => update(index, { subjectTemplate: event.target.value })} placeholder="About your inquiry" />
            </Field>}

            <Field label="Message" required hint={step.channel === 'sms' ? 'Keep it short — long texts are split and billed per part.' : undefined}>
              <textarea rows={step.channel === 'sms' ? 3 : 6} value={step.bodyTemplate ?? ''}
                onChange={(event) => update(index, { bodyTemplate: event.target.value })}
                placeholder={step.channel === 'sms' ? 'Hi {{contact.firstName}}, just checking you got our quote.' : 'Hi {{contact.firstName}},\n\nThanks for getting in touch...'} />
            </Field>

            <div className="variable-row">
              <span className="muted">Insert:</span>
              {VARIABLES.map((variable) => <button type="button" key={variable} className="chip chip-button" onClick={() => insertVariable(index, variable)}>
                {variable.replace('contact.', '')}
              </button>)}
              {step.channel === 'sms' && <span className="muted step-count">{(step.bodyTemplate ?? '').length} characters</span>}
            </div>
          </div>

          {index < steps.length - 1 && <div className="step-connector" aria-hidden="true"><ArrowDown size={15} /></div>}
        </Card>)}

        <div className="add-step">
          <Button onClick={() => setSteps((current) => [...current, newStep('email')])}><Mail size={15} />Add email step</Button>
          <Button onClick={() => setSteps((current) => [...current, newStep('sms')])}><MessageSquare size={15} />Add SMS step</Button>
        </div>
      </div>

      <aside className="editor-side">
        <Card title="Quiet hours" subtitle="Steps due inside this window wait until it opens. They are never skipped.">
          <label className="toggle-row">
            <input type="checkbox" checked={quietHours.enabled} onChange={(event) => setQuietHours((current) => ({ ...current, enabled: event.target.checked }))} />
            <span>Hold sends overnight</span>
          </label>
          {quietHours.enabled && <div className="field-row">
            <Field label="Stop at"><input type="time" value={clock(quietHours.startMinute)} onChange={(event) => {
              const [hour, minute] = event.target.value.split(':').map(Number)
              setQuietHours((current) => ({ ...current, startMinute: (hour ?? 21) * 60 + (minute ?? 0) }))
            }} /></Field>
            <Field label="Resume at"><input type="time" value={clock(quietHours.endMinute)} onChange={(event) => {
              const [hour, minute] = event.target.value.split(':').map(Number)
              setQuietHours((current) => ({ ...current, endMinute: (hour ?? 8) * 60 + (minute ?? 0) }))
            }} /></Field>
          </div>}
          <p className="muted">Applied in each contact's own timezone, and correct across daylight saving.</p>
        </Card>

        <Card title="Fallback timezone" subtitle="Used when a contact has no timezone of their own.">
          <input value={timeZone} onChange={(event) => setTimeZone(event.target.value)} />
        </Card>

        <Card title="Always on">
          <ul className="plain-list">
            <li><strong>Stops when they reply</strong><span className="muted">On any channel, immediately</span></li>
            <li><strong>Never sends twice</strong><span className="muted">Three independent safeguards</span></li>
            <li><strong>Skips anyone unsubscribed</strong><span className="muted">Checked before every send</span></li>
            <li><strong>Survives a restart</strong><span className="muted">Waits are held in the database</span></li>
          </ul>
        </Card>
      </aside>
    </div>
  </>
}
