import React from 'react'
import { MessagesSquare, RefreshCw } from 'lucide-react'
import { getOne, send } from '../api/client'
import { Alert, Button, Card, EmptyState, Field, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'

/**
 * The questions customers actually asked.
 *
 * This is the research step, and the reason it beats a keyword tool: a keyword
 * tool says 480 people a month search "emergency plumber". This says twelve
 * people asked THIS business about Sunday callouts, in their own words.
 *
 * Answers are bounded at 40-60 words by the same validator the blog uses.
 */

interface Question {
  id: string
  question: string
  answer: string
  askedCount: number
  examples: string[]
  status: string
  lastAskedAt: string | null
}

export default function QuestionsPage() {
  const action = useAction()
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const query = useApi(async () => (await getOne<{ questions: Question[] }>('/visibility/questions')).questions, [])

  const scan = async () => {
    const result = await action.run(() => send<{ created: number; scanned: number }>('post', '/visibility/questions/scan', {}),
      'Looked through your messages.')
    if (result) await query.reload()
  }

  const update = async (question: Question, body: Record<string, unknown>, message: string) => {
    const result = await action.run(() => send('patch', `/visibility/questions/${question.id}`, body), message)
    if (result !== undefined) await query.reload()
  }

  if (query.loading) return <SkeletonRows rows={4} columns={2} />

  const questions = query.data ?? []
  const unanswered = questions.filter((entry) => entry.status === 'suggested')
  const answered = questions.filter((entry) => entry.status !== 'suggested')

  return <>
    <PageHeader
      eyebrow="Getting found"
      title="Questions people ask you"
      description="Taken from your own inbox. Real customers, in their own words — better than any keyword tool."
      actions={<Button busy={action.loading} onClick={() => { void scan() }}><RefreshCw size={15} />Look for new ones</Button>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    {!questions.length ? <Card><EmptyState
      icon={<MessagesSquare />}
      title="No repeated questions yet"
      description="Once a few people have asked you the same thing, it appears here so you can answer it once and put it on your website."
      action={<Button variant="primary" busy={action.loading} onClick={() => { void scan() }}>Look through my messages</Button>}
    /></Card> : <>
      {unanswered.map((question) => <Card key={question.id}>
        {/* The count is the point: this is demand, measured. */}
        <p className="question-demand">
          <strong>{question.askedCount} people</strong> asked about this
        </p>
        <h3 className="question-text">{question.question}</h3>

        {Boolean(question.examples.length) && <details className="question-examples">
          <summary>What they actually wrote</summary>
          <ul>{question.examples.map((example) => <li key={example}>{example}</li>)}</ul>
        </details>}

        <Field label="Your answer" hint="40 to 60 words. Short enough to be quoted whole, long enough to be true on its own.">
          <textarea rows={3}
            value={drafts[question.id] ?? question.answer ?? ''}
            onChange={(event) => setDrafts((current) => ({ ...current, [question.id]: event.target.value }))}
            placeholder="Yes — we cover emergency callouts seven days a week across Chennai. Sunday and bank holiday visits carry a higher callout charge, which we tell you before we set off. Most jobs are attended within two hours." />
        </Field>
        <div className="row-actions">
          <Button size="sm" variant="ghost" busy={action.loading}
            onClick={() => { void update(question, { status: 'dismissed' }, 'Hidden.') }}>Not useful</Button>
          <Button size="sm" variant="primary" busy={action.loading}
            disabled={!(drafts[question.id] ?? question.answer ?? '').trim()}
            onClick={() => { void update(question, { answer: drafts[question.id] ?? question.answer, status: 'published' }, 'Published to your website.') }}>
            Publish this answer
          </Button>
        </div>
      </Card>)}

      {Boolean(answered.length) && <Card title="Answered">
        <table className="data-table">
          <thead><tr><th>Question</th><th>Asked by</th><th>Status</th></tr></thead>
          <tbody>{answered.map((question) => <tr key={question.id}>
            <td><strong>{question.question}</strong><div className="muted">{question.answer}</div></td>
            <td className="muted">{question.askedCount}</td>
            <td><StatusBadge status={question.status === 'published' ? 'active' : 'pending'} label={question.status} /></td>
          </tr>)}</tbody>
        </table>
      </Card>}
    </>}
  </>
}
