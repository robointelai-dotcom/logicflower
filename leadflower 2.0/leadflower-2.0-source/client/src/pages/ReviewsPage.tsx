import React from 'react'
import { Code2, Send, Star } from 'lucide-react'
import { getList, send } from '../api/client'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { HelpLink } from './HelpPage'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'
import { usePermissions } from '../hooks/usePermissions'

/**
 * Reviews, separated from Social.
 *
 * These two jobs were on one screen and have opposite availability. Collecting
 * a review works today, against endpoints that have nothing to do with
 * publishing. Posting to Meta, LinkedIn, TikTok and Pinterest cannot work until
 * each grants app review, which is months away. Sharing a screen meant the half
 * that works sat beneath a banner announcing that nothing does.
 *
 * No API changed for this. The endpoints below are the ones Social was already
 * calling.
 */

interface ReviewRow extends UnknownRecord {
  id: string; rating: number; body: string; authorName: string; publishState: string; submittedAt: string
  source?: string; reply?: { body: string; repliedAt: string } | null
}

interface ContactRow extends UnknownRecord { id: string; name?: string; firstName?: string; lastName?: string; email?: string; phone?: string }

interface CreatedWidget { id: string; publicKey: string; embedSnippet: string }

function contactLabel(contact: ContactRow): string {
  const name = contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ')
  return name || contact.email || contact.phone || 'Unnamed contact'
}

export default function ReviewsPage() {
  const { canOperate } = usePermissions()
  const action = useAction()

  const reviews = useApi(async () => (await getList<ReviewRow>('/social/reviews', ['reviews'])).items, [])
  const contacts = useApi(async () => (await getList<ContactRow>('/crm/contacts', ['contacts'])).items, [])

  const [replyTo, setReplyTo] = React.useState<ReviewRow | null>(null)
  const [replyBody, setReplyBody] = React.useState('')
  const [requestOpen, setRequestOpen] = React.useState(false)
  const [request, setRequest] = React.useState({ contactId: '', channel: 'email', messageTemplate: '' })
  const [widgetOpen, setWidgetOpen] = React.useState(false)
  const [widget, setWidget] = React.useState({ name: '', layout: 'carousel', minimumRating: '4' })
  const [createdWidget, setCreatedWidget] = React.useState<CreatedWidget | null>(null)

  const saveReply = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!replyTo) return
    const result = await action.run(() => send('post', `/social/reviews/${replyTo.id}/reply`, { body: replyBody }),
      replyBody.trim() ? 'Reply saved.' : 'Reply removed.')
    if (result !== undefined) { setReplyTo(null); setReplyBody(''); await reviews.reload() }
  }

  const moderate = async (review: ReviewRow, publishState: string) => {
    const result = await action.run(() => send('post', `/social/reviews/${review.id}/publish-state`, { publishState }),
      publishState === 'published' ? 'Review published to your widget.' : 'Review updated.')
    if (result !== undefined) await reviews.reload()
  }

  const askForReview = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send('post', '/social/reviews/requests', {
      contactId: request.contactId,
      channel: request.channel,
      ...(request.messageTemplate.trim() ? { messageTemplate: request.messageTemplate.trim() } : {}),
    }), 'Review request sent.')
    if (result !== undefined) { setRequestOpen(false); setRequest({ contactId: '', channel: 'email', messageTemplate: '' }); await reviews.reload() }
  }

  const createWidget = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send<CreatedWidget>('post', '/social/reviews/widgets', {
      name: widget.name.trim(),
      layout: widget.layout,
      minimumRating: Number(widget.minimumRating),
    }), 'Widget created.')
    if (result !== undefined) {
      setWidgetOpen(false)
      setWidget({ name: '', layout: 'carousel', minimumRating: '4' })
      setCreatedWidget(result)
    }
  }

  return <>
    <PageHeader
      eyebrow="Reputation"
      title="Reviews"
      description="Ask a customer for a review after a job, decide which ones go on your website, and reply to them."
      actions={canOperate && <><Button onClick={() => setWidgetOpen(true)}><Code2 size={16} />Website widget</Button><Button variant="primary" onClick={() => setRequestOpen(true)}><Send size={16} />Ask for a review</Button></>}
      help={<HelpLink route="/social" />}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    <Card title="Your reviews" subtitle="Nothing appears on your public widget until you publish it here.">
      {reviews.loading ? <SkeletonRows rows={3} columns={4} />
        : reviews.error ? <Alert>{reviews.error}</Alert>
        : reviews.data?.length ? <table className="data-table">
          <thead><tr><th>Rating</th><th>Review</th><th>State</th><th /></tr></thead>
          <tbody>{reviews.data.map((review) => <tr key={review.id}>
            <td>{'★'.repeat(review.rating)}<span className="muted">{'☆'.repeat(5 - review.rating)}</span></td>
            <td>
              {review.body || <span className="muted">No comment</span>}
              <div className="muted">{review.authorName}</div>
              {review.reply?.body && <p className="review-reply">Your reply: {review.reply.body}</p>}
            </td>
            <td><StatusBadge status={review.publishState === 'published' ? 'active' : review.publishState === 'hidden' ? 'paused' : 'pending'} label={review.publishState} /></td>
            <td className="row-actions">
              {canOperate && review.publishState !== 'published' && <Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void moderate(review, 'published') }}>Publish</Button>}
              {canOperate && review.publishState !== 'hidden' && <Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void moderate(review, 'hidden') }}>Hide</Button>}
              {/* Replying is only offered on reviews collected here — a reply to
                  a Google review has to be posted on Google. */}
              {canOperate && (review.source ?? 'first_party') === 'first_party' && <Button size="sm" variant="ghost" onClick={() => { setReplyTo(review); setReplyBody(review.reply?.body ?? '') }}>
                {review.reply?.body ? 'Edit reply' : 'Reply'}
              </Button>}
            </td>
          </tr>)}</tbody>
        </table> : <EmptyState icon={<Star />} title="No reviews yet" description="Ask a customer for one after a completed job. Requests respect quiet hours, like everything else that goes out." action={canOperate && <Button variant="primary" onClick={() => setRequestOpen(true)}><Send size={16} />Ask for a review</Button>} />}
    </Card>

    {createdWidget && <Card title="Your widget code" subtitle="Paste this into your website where the reviews should appear.">
      <Alert tone="info">This code is shown once. Copy it now — creating the widget again will produce a different one.</Alert>
      <pre className="embed-snippet"><code>{createdWidget.embedSnippet}</code></pre>
    </Card>}

    <Modal
      open={Boolean(replyTo)}
      title={replyTo?.reply?.body ? 'Edit your reply' : 'Reply to review'}
      description={replyTo?.publishState === 'published'
        ? 'This review is live, so your reply appears on your website as soon as you save it.'
        : 'This review is not published yet. Your reply will appear when you publish it.'}
      onClose={() => { setReplyTo(null); setReplyBody('') }}
      footer={<><Button onClick={() => { setReplyTo(null); setReplyBody('') }}>Cancel</Button><Button variant="primary" type="submit" form="reply-form" busy={action.loading}>Save reply</Button></>}
    >
      <form id="reply-form" className="form-stack" onSubmit={saveReply}>
        {replyTo && <p className="muted">{'★'.repeat(replyTo.rating)} — {replyTo.body || 'No comment'}</p>}
        <Field label="Your reply" hint="Clear it and save to remove the reply.">
          <textarea rows={4} maxLength={2000} value={replyBody} onChange={(event) => setReplyBody(event.target.value)} autoFocus placeholder="Thanks for taking the time to let us know." />
        </Field>
      </form>
    </Modal>

    <Modal
      open={requestOpen}
      title="Ask for a review"
      description="Sent from your own email or number, and held until your working hours if it is late."
      onClose={() => setRequestOpen(false)}
      footer={<><Button onClick={() => setRequestOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="review-request-form" busy={action.loading} disabled={!request.contactId}>Send request</Button></>}
    >
      <form id="review-request-form" className="form-stack" onSubmit={askForReview}>
        <Field label="Who are you asking?" required>
          <select value={request.contactId} onChange={(event) => setRequest((current) => ({ ...current, contactId: event.target.value }))} required autoFocus>
            <option value="">Choose a contact</option>
            {contacts.data?.map((contact) => <option key={contact.id} value={contact.id}>{contactLabel(contact)}</option>)}
          </select>
        </Field>
        {!contacts.loading && !contacts.data?.length && <Alert tone="warning">You have no contacts yet, so there is nobody to ask. Add one first.</Alert>}
        <Field label="How should it go out?">
          <select value={request.channel} onChange={(event) => setRequest((current) => ({ ...current, channel: event.target.value }))}>
            <option value="email">Email</option>
            <option value="sms">Text message</option>
          </select>
        </Field>
        <Field label="Anything you want to add" hint="Optional. Left blank, the standard wording is used.">
          <textarea rows={3} maxLength={2000} value={request.messageTemplate} onChange={(event) => setRequest((current) => ({ ...current, messageTemplate: event.target.value }))} placeholder="Thanks for having us out today —" />
        </Field>
      </form>
    </Modal>

    <Modal
      open={widgetOpen}
      title="Website widget"
      description="A block of code you paste into your own site. It shows the reviews you have published, and nothing else."
      onClose={() => setWidgetOpen(false)}
      footer={<><Button onClick={() => setWidgetOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="review-widget-form" busy={action.loading}>Create widget</Button></>}
    >
      <form id="review-widget-form" className="form-stack" onSubmit={createWidget}>
        <Field label="Name this widget" hint="Only you see this. For example: Homepage reviews." required>
          <input value={widget.name} onChange={(event) => setWidget((current) => ({ ...current, name: event.target.value }))} required autoFocus />
        </Field>
        <Field label="How should it look?">
          <select value={widget.layout} onChange={(event) => setWidget((current) => ({ ...current, layout: event.target.value }))}>
            <option value="carousel">Sliding row</option>
            <option value="grid">Grid</option>
            <option value="list">List</option>
            <option value="badge">Small badge</option>
          </select>
        </Field>
        <Field label="Show reviews of at least" hint="Lower-rated reviews stay in this screen and off your site.">
          <select value={widget.minimumRating} onChange={(event) => setWidget((current) => ({ ...current, minimumRating: event.target.value }))}>
            {[5, 4, 3, 2, 1].map((rating) => <option key={rating} value={String(rating)}>{'★'.repeat(rating)}</option>)}
          </select>
        </Field>
      </form>
    </Modal>
  </>
}
