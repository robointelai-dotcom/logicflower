import React from 'react'
import { Inbox, Send } from 'lucide-react'
import { getList, getOne, send } from '../api/client'
import { Alert, Button, Card, EmptyState, Field, PageHeader, SkeletonRows } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'

interface ConversationRow extends UnknownRecord {
  id: string
  contactId: string
  status: string
  channels: string[]
  lastMessagePreview?: string
  lastMessageDirection?: string
  lastMessageAt?: string
  unreadCount: number
}

interface ThreadMessage {
  id: string
  direction: 'inbound' | 'outbound'
  channel: string
  body: string
  subject?: string
  unreadable?: boolean
  occurredAt: string
}

export default function InboxPage() {
  const action = useAction()
  const [selected, setSelected] = React.useState<string | null>(null)
  const [reply, setReply] = React.useState('')
  const [channel, setChannel] = React.useState<'email' | 'sms'>('sms')

  const conversations = useApi(async () => (await getList<ConversationRow>('/inbox/conversations', ['conversations'])).items, [])
  const thread = useApi(async () => selected ? await getOne<{ conversation: UnknownRecord; messages: ThreadMessage[] }>(`/inbox/conversations/${selected}`) : null, [selected])

  const sendReply = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selected || !reply.trim()) return
    const result = await action.run(() => send('post', `/inbox/conversations/${selected}/messages`, { channel, body: reply }), 'Reply sent.')
    if (result !== undefined) { setReply(''); await thread.reload(); await conversations.reload() }
  }

  return <>
    <PageHeader
      eyebrow="Unified inbox"
      title="Conversations"
      description="One thread per person across SMS and email. An inbound reply stops every sequence they are in."
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    <div className="inbox-layout">
      <Card className="inbox-list">
        {conversations.loading ? <SkeletonRows rows={5} columns={1} />
          : conversations.error ? <Alert>{conversations.error}</Alert>
            : conversations.data?.length ? <ul className="thread-list">
              {conversations.data.map((conversation) => <li key={conversation.id}>
                <button className={selected === conversation.id ? 'selected' : ''} onClick={() => setSelected(conversation.id)}>
                  <span className="thread-channels">{conversation.channels.join(' · ') || '—'}</span>
                  {/* The list renders from stored previews and decrypts nothing. */}
                  <p>{conversation.lastMessagePreview ?? 'No messages yet'}</p>
                  <span className="muted">{conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toLocaleString() : ''}</span>
                  {conversation.unreadCount > 0 && <span className="unread-dot">{conversation.unreadCount}</span>}
                </button>
              </li>)}
            </ul> : <EmptyState icon={<Inbox />} title="No conversations" description="Replies from contacts will appear here." />}
      </Card>

      <Card className="inbox-thread">
        {!selected ? <EmptyState title="Select a conversation" description="Pick a thread on the left to read and reply." />
          : thread.loading ? <SkeletonRows rows={5} columns={1} />
            : thread.error ? <Alert>{thread.error}</Alert>
              : <>
                <ol className="message-thread">
                  {thread.data?.messages.map((message) => <li key={message.id} className={message.direction === 'inbound' ? 'inbound' : 'outbound'}>
                    <header><span>{message.channel}</span><time>{new Date(message.occurredAt).toLocaleString()}</time></header>
                    {message.subject && <strong>{message.subject}</strong>}
                    {/* A body that will not decrypt is reported, not silently blank. */}
                    {message.unreadable ? <p className="muted">This message could not be decrypted.</p> : <p>{message.body}</p>}
                  </li>)}
                </ol>
                <form className="reply-box" onSubmit={sendReply}>
                  <Field label="Reply">
                    <textarea rows={3} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Type a reply" />
                  </Field>
                  <div className="reply-actions">
                    <select value={channel} onChange={(event) => setChannel(event.target.value as 'email' | 'sms')} aria-label="Reply channel">
                      <option value="sms">SMS</option>
                      <option value="email">Email</option>
                    </select>
                    <Button variant="primary" type="submit" busy={action.loading} disabled={!reply.trim()}><Send size={15} />Send</Button>
                  </div>
                </form>
              </>}
      </Card>
    </div>
  </>
}
