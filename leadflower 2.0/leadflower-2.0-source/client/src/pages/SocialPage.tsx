import React from 'react'
import { CalendarDays, Megaphone, Plus, Star } from 'lucide-react'
import { Link } from '../router'
import { getList, getOne, send } from '../api/client'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { HelpLink } from './HelpPage'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'
import { usePermissions } from '../hooks/usePermissions'

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
export default function SocialPage() {
  const { canOperate } = usePermissions()
  const action = useAction()
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState({ caption: '', accountIds: [] as string[], scheduledFor: '' })

  const platforms = useApi(async () => await getOne<PlatformsResponse>('/social/platforms'), [])
  const accounts = useApi(async () => (await getList<AccountRow>('/social/accounts', ['accounts'])).items, [])
  const posts = useApi(async () => (await getList<PostRow>('/social/posts', ['posts'])).items, [])

  const createPost = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send('post', '/social/posts', {
      caption: form.caption,
      targets: form.accountIds.map((id) => ({ socialAccountId: id })),
      scheduledFor: form.scheduledFor || null,
    }), 'Post saved.')
    if (result !== undefined) { setOpen(false); setForm({ caption: '', accountIds: [], scheduledFor: '' }); await posts.reload() }
  }

  const blocked = platforms.data?.platforms.filter((platform) => platform.publishState !== 'available') ?? []

  return <>
    <PageHeader
      eyebrow="Social"
      title="Social"
      description="Compose once and schedule everywhere. Reviews have their own screen."
      actions={canOperate && <Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />New post</Button>}
      help={<HelpLink route="/social" />}
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

    <Card className="security-note"><Star size={21} /><div><strong>Reviews have moved</strong><p>Collecting and publishing reviews now has its own screen, because it works today and social publishing does not. Open <Link to="/reviews">Reviews</Link>.</p></div></Card>

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
