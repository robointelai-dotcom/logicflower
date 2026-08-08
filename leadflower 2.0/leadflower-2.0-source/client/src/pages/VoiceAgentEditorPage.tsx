import React from 'react'
import { ArrowLeft, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { getOne, send } from '../api/client'
import { Link, useParams } from '../router'
import { Alert, Button, Card, Field, PageHeader, SkeletonRows } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'

/**
 * The voice agent editor.
 *
 * Fields and defaults follow the provider's documented configuration model, so
 * an operator who has read their training material recognises this screen.
 *
 * The section that matters most is restricted topics. The platform resolves an
 * unexpected question through script, then instructions, then knowledge base,
 * and finally the underlying language model's own general knowledge — which
 * means an under-instructed agent does not go quiet when it hits something it
 * does not know. It improvises. For a regulated trade, an improvised answer
 * about pricing or eligibility is a liability event rather than a quality
 * problem, so refusals are a first-class field here rather than a line buried
 * in a prompt.
 */

const AGENT_TYPES = [
  { value: 'lead_engagement', label: 'Conversational', hint: 'Free-form. Speaks most freely — and improvises most.' },
  { value: 'support_agent', label: 'Support', hint: 'Question-led, answers with detail. No script.' },
  { value: 'sales_representative', label: 'Sales', hint: 'The only type that follows a step-by-step script.' },
]

interface Definition {
  direction: 'inbound' | 'outbound'
  agentType: string
  language: string
  tone?: string
  goal?: string
  background?: string
  script?: string
  prompt: string
  welcomeMessage?: string
  welcomeMessageDelaySeconds: number
  voicemailDetection: boolean
  voicemailAction: 'leave_message' | 'hang_up'
  voicemailMessage?: string
  machineTimeoutSeconds: number
  maxCallSeconds: number
  restrictedTopics: Array<{ topic: string; refusalWording: string }>
  disclosures: { aiDisclosureText: string; recordingEnabled: boolean; recordingConsentText?: string; optOutPhrases: string[] }
}

const BLANK: Definition = {
  direction: 'outbound',
  agentType: 'lead_engagement',
  language: 'en',
  prompt: '',
  welcomeMessageDelaySeconds: 2,
  voicemailDetection: false,
  voicemailAction: 'hang_up',
  machineTimeoutSeconds: 10,
  maxCallSeconds: 300,
  restrictedTopics: [],
  disclosures: { aiDisclosureText: '', recordingEnabled: false, optOutPhrases: [] },
}

export default function VoiceAgentEditorPage() {
  const params = useParams()
  const agentId = params.id ?? ''
  const action = useAction()

  const [def, setDef] = React.useState<Definition>(BLANK)
  const [loaded, setLoaded] = React.useState(false)

  const query = useApi(async () => agentId
    ? await getOne<{ agent: { name: string; status: string }; version: { version: number; definition: Definition } | null }>(`/voice/agents/${agentId}/version`)
    : null, [agentId])

  React.useEffect(() => {
    if (loaded || query.loading) return
    if (query.data?.version?.definition) setDef({ ...BLANK, ...query.data.version.definition })
    setLoaded(true)
  }, [query.loading, query.data, loaded])

  const set = <K extends keyof Definition>(key: K, value: Definition[K]) => setDef((current) => ({ ...current, [key]: value }))

  const publish = async () => {
    const result = await action.run(() => send('post', `/voice/agents/${agentId}/versions`, { definition: def }),
      'Published. Activate the agent when you are ready.')
    if (result !== undefined) await query.reload()
  }

  if (query.loading && !loaded) return <SkeletonRows rows={5} columns={2} />

  const isSales = def.agentType === 'sales_representative'

  return <>
    <p className="back-link"><Link to="/voice"><ArrowLeft size={13} /> All agents</Link></p>
    <PageHeader
      eyebrow="AI voice"
      title={query.data?.agent?.name ? `Editing “${query.data.agent.name}”` : 'Voice agent'}
      description="Write it as if you were briefing a new member of staff — clear, specific, and explicit about what they must not say."
      actions={<Button variant="primary" busy={action.loading} onClick={() => { void publish() }}>
        Publish version{query.data?.version ? ` ${query.data.version.version + 1}` : ''}
      </Button>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    <div className="editor-layout">
      <div className="editor-steps">
        <Card title="What kind of agent">
          <div className="field-row">
            <Field label="Direction">
              <select value={def.direction} onChange={(event) => set('direction', event.target.value as Definition['direction'])}>
                <option value="outbound">Places calls</option>
                <option value="inbound">Answers calls</option>
              </select>
            </Field>
            <Field label="Language"><input value={def.language} onChange={(event) => set('language', event.target.value)} /></Field>
          </div>
          <Field label="Style" hint={AGENT_TYPES.find((type) => type.value === def.agentType)?.hint}>
            <select value={def.agentType} onChange={(event) => set('agentType', event.target.value)}>
              {AGENT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </Field>
        </Card>

        <Card title="How it should behave" subtitle="Tone, purpose and who it is. The agent answers questions about itself from the background.">
          <Field label="Tone"><input value={def.tone ?? ''} onChange={(event) => set('tone', event.target.value)} placeholder="Warm and efficient, never pushy" /></Field>
          <Field label="Goal" hint="The one thing this call is for.">
            <input value={def.goal ?? ''} onChange={(event) => set('goal', event.target.value)} placeholder="Book a survey appointment" />
          </Field>
          <Field label="Background" hint="Name, role, experience — so it can answer personal questions.">
            <textarea rows={3} value={def.background ?? ''} onChange={(event) => set('background', event.target.value)} />
          </Field>
        </Card>

        <Card title="What it knows" subtitle="Services, prices, FAQs, and the rules it must follow.">
          <Field label="Instructions" required>
            <textarea rows={8} value={def.prompt} onChange={(event) => set('prompt', event.target.value)}
              placeholder={'We fit and repair boilers across Chennai.\n\nCallout is ₹800, refunded against any work booked.\n\nOffer a free survey to anyone asking about a replacement.'} />
          </Field>
          {/* Only a sales representative follows a script; the field is hidden
              rather than ignored, so nobody writes one that never runs. */}
          {isSales && <Field label="Script" hint="Followed step by step. Only the sales style uses this.">
            <textarea rows={6} value={def.script ?? ''} onChange={(event) => set('script', event.target.value)} />
          </Field>}
        </Card>

        <Card
          title="What it must never answer"
          subtitle="Without these, an unexpected question is answered from the language model's general knowledge — it will make something up rather than decline."
        >
          {!def.restrictedTopics.length && <Alert tone="warning">
            <ShieldAlert size={15} /> Nothing is restricted. If a caller asks about something outside the instructions, the agent will improvise an answer.
          </Alert>}
          <div className="restricted-list">
            {def.restrictedTopics.map((entry, index) => <div key={index} className="restricted-row">
              <input value={entry.topic} placeholder="Topic, e.g. medical advice"
                onChange={(event) => set('restrictedTopics', def.restrictedTopics.map((item, position) => position === index ? { ...item, topic: event.target.value } : item))} />
              <input value={entry.refusalWording} placeholder="Say instead: “I'll have someone qualified call you back.”"
                onChange={(event) => set('restrictedTopics', def.restrictedTopics.map((item, position) => position === index ? { ...item, refusalWording: event.target.value } : item))} />
              <Button size="sm" variant="ghost" aria-label="Remove"
                onClick={() => set('restrictedTopics', def.restrictedTopics.filter((_, position) => position !== index))}><Trash2 size={13} /></Button>
            </div>)}
          </div>
          <Button onClick={() => set('restrictedTopics', [...def.restrictedTopics, { topic: '', refusalWording: '' }])}><Plus size={15} />Add a restriction</Button>
        </Card>
      </div>

      <aside className="editor-side">
        <Card title="Opening the call">
          <Field label="Greeting"><input value={def.welcomeMessage ?? ''} onChange={(event) => set('welcomeMessage', event.target.value)} placeholder="Hello, this is Priya from Acme." /></Field>
          <Field label="Wait before speaking" hint="Seconds. A short pause feels more natural than an instant reply.">
            <input type="number" min={0} max={10} value={def.welcomeMessageDelaySeconds} onChange={(event) => set('welcomeMessageDelaySeconds', Number(event.target.value))} />
          </Field>
        </Card>

        <Card title="Required by law" subtitle="These cannot be switched off.">
          <Field label="Automated-caller disclosure" required hint="Spoken before the conversation begins.">
            <textarea rows={2} value={def.disclosures.aiDisclosureText}
              onChange={(event) => set('disclosures', { ...def.disclosures, aiDisclosureText: event.target.value })}
              placeholder="Hello, this is an automated assistant calling on behalf of Acme." />
          </Field>
          <label className="toggle-row">
            <input type="checkbox" checked={def.disclosures.recordingEnabled}
              onChange={(event) => set('disclosures', { ...def.disclosures, recordingEnabled: event.target.checked })} />
            <span>Record and transcribe calls</span>
          </label>
          {/* Recording cannot be enabled without an announcement: whether it is
              lawful at all turns on consent rules this system cannot evaluate. */}
          {def.disclosures.recordingEnabled && <Field label="Recording announcement" required>
            <textarea rows={2} value={def.disclosures.recordingConsentText ?? ''}
              onChange={(event) => set('disclosures', { ...def.disclosures, recordingConsentText: event.target.value })}
              placeholder="This call is recorded for quality and training." />
          </Field>}
        </Card>

        <Card title="If a machine answers">
          <label className="toggle-row">
            <input type="checkbox" checked={def.voicemailDetection} onChange={(event) => set('voicemailDetection', event.target.checked)} />
            <span>Detect voicemail</span>
          </label>
          {def.voicemailDetection && <>
            <Field label="Then">
              <select value={def.voicemailAction} onChange={(event) => set('voicemailAction', event.target.value as Definition['voicemailAction'])}>
                <option value="hang_up">Hang up</option>
                <option value="leave_message">Leave a message</option>
              </select>
            </Field>
            {def.voicemailAction === 'leave_message' && <Field label="Message">
              <textarea rows={2} value={def.voicemailMessage ?? ''} onChange={(event) => set('voicemailMessage', event.target.value)} />
            </Field>}
          </>}
          <Field label="Decide within" hint="Seconds before judging whether a person answered.">
            <input type="number" min={1} max={60} value={def.machineTimeoutSeconds} onChange={(event) => set('machineTimeoutSeconds', Number(event.target.value))} />
          </Field>
        </Card>

        <Card title="Always on">
          <ul className="plain-list">
            <li><strong>Stops if they ask</strong><span className="muted">“Stop calling me” ends the call and blocks future ones</span></li>
            <li><strong>Calling hours honoured</strong><span className="muted">In the contact's own timezone</span></li>
            <li><strong>Do-not-call checked</strong><span className="muted">Blocked if it cannot be verified</span></li>
          </ul>
        </Card>
      </aside>
    </div>
  </>
}
