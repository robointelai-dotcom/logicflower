import React from 'react'
import { CalendarDays, Megaphone, Plus, Star } from 'lucide-react'
import { getList, getOne, send } from '../api/client'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'

interface PlatformProfile {
  platform: string
  displayName: string
  publishState: string
  approvalRequired: string
  documentationNeeded: string
  rateLimitNote?: string
  recentChanges?: string
}

interface PlatformsResponse {
  platforms: PlatformProfile[]
  backend: { configured: boolean; provider: string | null; note: string }
}

interface AccountRow extends UnknownRecord { id: string; platform: string; displayName: string; publishState: string; status: string }
interface PostRow extends UnknownRecord {
  id: string; caption: string; status: string; scheduledFor?: string
  targets: Array<{ platform: string; status: string; blockedReason?: string; externalPostUrl?: string }>
}
interface ReviewRow extends UnknownRecord {
  id: string; rating: number; body: string; authorName: string; publishState: string; submittedAt: string
  source?: string; reply?: { body: string; repliedAt: string } | null
}

export default function SocialPage() {
  const action = useAction()
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState({ caption: '', accountIds: [] as string[], scheduledFor: '' })

  const platforms = useApi(async () => await getOne<PlatformsResponse>('/social/platforms'), [])
  const accounts = useApi(async () => (await getList<AccountRow>('/social/accounts', ['accounts'])).items, [])
  const posts = useApi(async () => (await getList<PostRow>('/social/posts', ['posts'])).items, [])
  const reviews = useApi(async () => (await getList<ReviewRow>('/social/reviews', ['reviews'])).items, [])

  const createPost = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send('post', '/social/posts', {
      caption: form.caption,
      targets: form.accountIds.map((id) => ({ socialAccountId: id })),
      scheduledFor: form.scheduledFor || null,
    }), 'Post saved.')
    if (result !== undefined) { setOpen(false); setForm({ caption: '', accountIds: [], scheduledFor: '' }); await posts.reload() }
  }

  const [replyTo, setReplyTo] = React.useState<ReviewRow | null>(null)
  const [replyBody, setReplyBody] = React.useState('')

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

  const blocked = platforms.data?.platforms.filter((platform) => platform.publishState !== 'available') ?? []

  return <>
    <PageHeader
      eyebrow="Social & reviews"
      title="Social"
      description="Compose once, schedule everywhere, and collect reviews that feed a widget on your site."
      actions={<Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />New post</Button>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    {/*
      Stated at the top rather than discovered when a post fails. Publishing is
      gated on platform app review, which no amount of configuration here
      shortens.
    */}
    {Boolean(blocked.length) && <Alert tone="warning">
      <strong>Publishing is not yet enabled for {blocked.length} platform(s).</strong>{' '}
      {platforms.data?.backend.note}{' '}
      Posts can be composed and scheduled now; they will not go out until each platform&rsquo;s app review is granted.
    </Alert>}

    <Card title="Platforms" subtitle="What is approved, and what each one still needs.">
      {platforms.loading ? <SkeletonRows rows={3} columns={3} /> : <table className="data-table">
        <thead><tr><th>Platform</th><th>Publishing</th><th>Outstanding</th></tr></thead>
        <tbody>{platforms.data?.platforms.map((platform) => <tr key={platform.platform}>
          <td><strong>{platform.displayName}</strong>{platform.recentChanges && <div className="muted">{platform.recentChanges}</div>}</td>
          <td><StatusBadge status={platform.publishState === 'available' ? 'active' : platform.publishState === 'unverified' ? 'attention' : 'paused'} label={platform.publishState} /></td>
          <td className="muted">{platform.approvalRequired}</td>
        </tr>)}</tbody>
      </table>}
    </Card>

    <Card title="Scheduled posts">
      {posts.loading ? <SkeletonRows rows={3} columns={3} />
        : posts.data?.length ? <table className="data-table">
          <thead><tr><th>Caption</th><th>Scheduled</th><th>Destinations</th></tr></thead>
          <tbody>{posts.data.map((post) => <tr key={post.id}>
            <td>{post.caption.slice(0, 120) || <span className="muted">Media only</span>}</td>
            <td className="muted"><CalendarDays size={13} /> {post.scheduledFor ? new Date(post.scheduledFor).toLocaleString() : 'Draft'}</td>
            <td>{post.targets.map((target, index) => <span key={index} className="chip" title={target.blockedReason}>{target.platform}: {target.status}</span>)}</td>
          </tr>)}</tbody>
        </table> : <EmptyState icon={<Megaphone />} title="No posts yet" description="Compose one and schedule it — it will publish once a platform is approved." />}
    </Card>

    <Card title="Reviews" subtitle="Nothing appears on your public widget until you publish it here.">
      {reviews.loading ? <SkeletonRows rows={3} columns={3} />
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
              {review.publishState !== 'published' && <Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void moderate(review, 'published') }}>Publish</Button>}
              {review.publishState !== 'hidden' && <Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void moderate(review, 'hidden') }}>Hide</Button>}
              {/* Replying is only offered on reviews collected here — a reply to
                  a Google review has to be posted on Google. */}
              {(review.source ?? 'first_party') === 'first_party' && <Button size="sm" variant="ghost" onClick={() => { setReplyTo(review); setReplyBody(review.reply?.body ?? '') }}>
                {review.reply?.body ? 'Edit reply' : 'Reply'}
              </Button>}
            </td>
          </tr>)}</tbody>
        </table> : <EmptyState icon={<Star />} title="No reviews yet" description="Request one from a contact after a completed job." />}
    </Card>

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
      open={open}
      title="New post"
      description="Character limits are enforced per platform when you save."
      onClose={() => setOpen(false)}
      footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="post-form" busy={action.loading}>Save post</Button></>}
    >
      <form id="post-form" className="form-stack" onSubmit={createPost}>
        <Field label="Caption" required><textarea rows={5} value={form.caption} onChange={(event) => setForm((current) => ({ ...current, caption: event.target.value }))} required autoFocus /></Field>
        <Field label="Destinations" hint={accounts.data?.length ? undefined : 'No accounts connected yet.'}>
          <div className="choice-grid">
            {accounts.data?.map((account) => <button
              type="button"
              key={account.id}
              className={form.accountIds.includes(account.id) ? 'selected' : ''}
              onClick={() => setForm((current) => ({
                ...current,
                accountIds: current.accountIds.includes(account.id) ? current.accountIds.filter((id) => id !== account.id) : [...current.accountIds, account.id],
              }))}
            ><span>{account.displayName}</span><small>{account.platform}</small></button>)}
          </div>
        </Field>
        <Field label="Schedule for" hint="Leave empty to keep it as a draft.">
          <input type="datetime-local" value={form.scheduledFor} onChange={(event) => setForm((current) => ({ ...current, scheduledFor: event.target.value }))} />
        </Field>
      </form>
    </Modal>
  </>
}
