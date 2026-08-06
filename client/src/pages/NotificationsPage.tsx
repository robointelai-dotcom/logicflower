import React from 'react'
import { Bell, CheckCircle2, Mail, MessageSquare, Pause, Play, Plus, Send, Trash2, Webhook } from 'lucide-react'
import { getList, send } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, Button, Card, ConfirmDialog, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { NotificationChannel, UnknownRecord } from '../types'

async function loadChannels(): Promise<NotificationChannel[]> {
  return (await getList<NotificationChannel & UnknownRecord>('/notifications/channels', ['channels'])).items.map((channel) => {
    const config = channel.config && typeof channel.config === 'object' && !Array.isArray(channel.config) ? channel.config as UnknownRecord : {}
    const recipients = Array.isArray(config.recipients) ? config.recipients.map(String) : []
    return { ...channel, destinationMasked: channel.destinationMasked ?? (recipients.length ? recipients.join(', ') : `${channel.type} destination`), minimumSeverity: channel.minimumSeverity ?? 'warning' }
  })
}

function channelIcon(type: string) { return type === 'email' ? <Mail /> : type === 'slack' ? <MessageSquare /> : <Webhook /> }

export default function NotificationsPage() {
  const { session } = useAuth()
  const query = useApi(loadChannels, [])
  const action = useAction()
  const [open, setOpen] = React.useState(false)
  const [remove, setRemove] = React.useState<NotificationChannel | null>(null)
  const [form, setForm] = React.useState({ name: '', type: 'email' as NotificationChannel['type'], destination: '', minimumSeverity: 'warning' as NotificationChannel['minimumSeverity'] })
  const canManage = ['owner', 'admin'].includes(session?.organization?.role ?? '')
  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send('post', '/notifications/channels', { name: form.name, type: form.type, destination: form.destination, minimumSeverity: form.minimumSeverity }), 'Channel created.')
    if (result !== undefined) { setOpen(false); await query.reload() }
  }
  const test = async (channel: NotificationChannel) => { await action.run(() => send('post', `/notifications/channels/${channel.id}/test`), `Test notification sent to ${channel.name}.`) }
  const toggle = async (channel: NotificationChannel) => {
    const enabled = !channel.enabled
    const result = await action.run(() => send('patch', `/notifications/channels/${channel.id}`, { enabled }), `${channel.name} ${enabled ? 'resumed' : 'paused'}.`)
    if (result !== undefined) await query.reload()
  }
  const removeNow = async () => { if (!remove) return; const done = await action.run(async () => { await send('delete', `/notifications/channels/${remove.id}`); return true }, 'Channel removed.'); if (done) { setRemove(null); await query.reload() } }

  return <>
    <PageHeader eyebrow="Incident routing" title="Alerts & channels" description="Route important operational events without exposing notification credentials." actions={canManage && <Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />Add channel</Button>} />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}{action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}
    {query.loading ? <SkeletonRows rows={4} columns={4} /> : query.error ? <Alert>{query.error}</Alert> : query.data?.length ? <div className="channel-grid">{query.data.map((channel) => <Card key={channel.id} className="channel-card"><div className="channel-head"><span>{channelIcon(channel.type)}</span><div><h2>{channel.name}</h2><p>{channel.destinationMasked ?? `${channel.type} destination`}</p></div><StatusBadge status={channel.enabled ? (channel.verified === false ? 'attention' : 'active') : 'paused'} /></div><div className="event-chips"><span>Minimum severity: {channel.minimumSeverity ?? 'warning'}</span><span>Incident deduplication enabled</span></div>{canManage && <div className="channel-actions"><Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void toggle(channel) }}>{channel.enabled ? <Pause size={14} /> : <Play size={14} />}{channel.enabled ? 'Pause' : 'Resume'}</Button><Button size="sm" variant="ghost" busy={action.loading} disabled={!channel.enabled} onClick={() => { void test(channel) }}><Send size={14} />Send test</Button><button className="icon-button danger-hover" disabled={action.loading} onClick={() => setRemove(channel)} aria-label={`Delete ${channel.name}`}><Trash2 size={16} /></button></div>}</Card>)}</div> : <Card><EmptyState icon={<Bell />} title="No alert channels" description="Add email, Slack or a signed webhook so the right people know when action is required." action={canManage ? <Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />Add channel</Button> : undefined} /></Card>}
    <Modal open={open} title="Add notification channel" description="Destination credentials are encrypted after submission and never returned." onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="channel-form" busy={action.loading}>Create channel</Button></>}><form id="channel-form" className="form-stack" onSubmit={create}><Field label="Channel name" required><input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Operations alerts" required autoFocus /></Field><Field label="Channel type"><div className="choice-grid">{(['email', 'slack', 'webhook'] as const).map((type) => <button type="button" key={type} className={form.type === type ? 'selected' : ''} onClick={() => setForm((current) => ({ ...current, type, destination: '' }))}>{channelIcon(type)}<span>{type === 'slack' ? 'Slack' : type[0]?.toUpperCase() + type.slice(1)}</span>{form.type === type && <CheckCircle2 size={15} />}</button>)}</div></Field><Field label={form.type === 'email' ? 'Email address' : form.type === 'slack' ? 'Slack webhook URL' : 'HTTPS destination URL'} hint={form.type === 'email' ? 'Used only for operational notifications.' : 'Stored encrypted. The secret URL is never returned.'} required><input type={form.type === 'email' ? 'email' : 'url'} pattern={form.type === 'email' ? undefined : 'https://.*'} value={form.destination} onChange={(event) => setForm((current) => ({ ...current, destination: event.target.value }))} required /></Field><Field label="Minimum incident severity"><select value={form.minimumSeverity} onChange={(event) => setForm((current) => ({ ...current, minimumSeverity: event.target.value as NotificationChannel['minimumSeverity'] }))}><option value="info">Info and above</option><option value="warning">Warning and above</option><option value="critical">Critical only</option></select></Field></form></Modal>
    <ConfirmDialog open={Boolean(remove)} title="Delete notification channel?" description={`${remove?.name ?? 'This channel'} will stop receiving alerts immediately.`} confirmLabel="Delete channel" danger busy={action.loading} onClose={() => setRemove(null)} onConfirm={() => { void removeNow() }} />
  </>
}
