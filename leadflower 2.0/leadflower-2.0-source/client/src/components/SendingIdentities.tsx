import React from 'react'
import { CheckCircle2, CreditCard, Mail, MessageSquare, ShieldCheck } from 'lucide-react'
import { getList, send } from '../api/client'
import { Alert, Button, Card, Field, Modal, StatusBadge } from './ui'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'

/**
 * How a workspace sends: its own email and text provider, and its own payment
 * account.
 *
 * The API and the model for this existed from the start — `MessagingIdentity`
 * and `POST /sequences/identities` — but nothing in the interface ever reached
 * them, so a customer could publish a sequence and never send a message. That
 * is the product's central promise, so this sits above the connector grid
 * rather than inside it.
 *
 * The nine connectors below belong to the previous product. A local business
 * needs an email provider, a text provider and a way to take money; it does not
 * need HubSpot before it can reply to an enquiry.
 *
 * Credentials go out once over HTTPS and are encrypted server-side under a
 * per-record AAD. Nothing here reads them back, and the local form state is
 * cleared the moment the dialog closes.
 */

interface SendingIdentity extends UnknownRecord {
  id: string
  channel: string
  provider: string
  label: string
  status: string
  isDefault: boolean
  fromAddress?: string
  fromNumber?: string
  providerVerification?: string
  hasCredentials?: boolean
}

type Dialog = 'email' | 'sms' | 'payments'

const emptyEmail = { transport: 'smtp', label: '', fromAddress: '', fromName: '', host: '', port: '587', secure: true, user: '', password: '', apiKey: '' }
const emptySms = { label: '', fromNumber: '', accountSid: '', authToken: '' }
const emptyPayments = { secretKey: '' }

async function loadIdentities(): Promise<SendingIdentity[]> {
  const result = await getList<SendingIdentity>('/sequences/identities', ['identities'])
  return result.items.map((item) => ({
    ...item,
    channel: String(item.channel ?? ''),
    provider: String(item.provider ?? ''),
    label: String(item.label ?? ''),
    status: String(item.status ?? 'active'),
    isDefault: Boolean(item.isDefault),
  }))
}

/**
 * A default name that does not collide.
 *
 * `{organizationId, channel, label}` is unique on the server. Defaulting a
 * blank name to the same word every time meant a second identity on the same
 * channel was refused on the index — so the fallback is numbered.
 */
function defaultLabel(base: string, existing: SendingIdentity[]): string {
  if (!existing.some((item) => item.label === base)) return base
  let suffix = 2
  while (existing.some((item) => item.label === `${base} ${suffix}`)) suffix += 1
  return `${base} ${suffix}`
}

function providerLabel(provider: string): string {
  const names: Record<string, string> = { smtp: 'Your own mail server', sendgrid: 'SendGrid', twilio: 'Twilio', whatsapp_cloud: 'WhatsApp' }
  return names[provider] ?? provider
}

export default function SendingIdentities({ canManage }: { canManage: boolean }) {
  const query = useApi(loadIdentities, [])
  const action = useAction()
  const [dialog, setDialog] = React.useState<Dialog | null>(null)
  const [email, setEmail] = React.useState(emptyEmail)
  const [sms, setSms] = React.useState(emptySms)
  const [payments, setPayments] = React.useState(emptyPayments)

  const identities = query.data ?? []
  const emailIdentities = identities.filter((item) => item.channel === 'email')
  const smsIdentities = identities.filter((item) => item.channel === 'sms')

  /** Secrets do not outlive the dialog that collected them. */
  const closeDialog = () => {
    setDialog(null)
    setEmail(emptyEmail)
    setSms(emptySms)
    setPayments(emptyPayments)
  }

  const saveEmail = async (event: React.FormEvent) => {
    event.preventDefault()
    const credentials = email.transport === 'smtp'
      ? { host: email.host.trim(), port: Number(email.port), secure: email.secure, ...(email.user ? { user: email.user.trim() } : {}), ...(email.password ? { password: email.password } : {}) }
      : { apiKey: email.apiKey.trim() }
    const result = await action.run(() => send('post', '/sequences/identities', {
      channel: 'email',
      provider: email.transport,
      label: email.label.trim() || defaultLabel('Email', emailIdentities),
      fromAddress: email.fromAddress.trim(),
      ...(email.fromName.trim() ? { fromName: email.fromName.trim() } : {}),
      // The first identity on a channel becomes the default, because a
      // sequence with no default refuses to send rather than guessing.
      isDefault: emailIdentities.length === 0,
      credentials,
    }), 'Email set up. Follow-up can now go out from your address.')
    if (result !== undefined) { closeDialog(); await query.reload() }
  }

  const saveSms = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send('post', '/sequences/identities', {
      channel: 'sms',
      provider: 'twilio',
      label: sms.label.trim() || defaultLabel('Text messages', smsIdentities),
      fromNumber: sms.fromNumber.trim(),
      isDefault: smsIdentities.length === 0,
      credentials: { accountSid: sms.accountSid.trim(), authToken: sms.authToken.trim() },
    }), 'Text messaging set up.')
    if (result !== undefined) { closeDialog(); await query.reload() }
  }

  const savePayments = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send('post', '/crm/payments/credential', { secretKey: payments.secretKey.trim() }),
      'Payment account saved. Money from payment links goes to you, not to us.')
    if (result !== undefined) closeDialog()
  }

  const channelCard = (options: {
    key: Dialog
    icon: React.ReactNode
    title: string
    plain: string
    rows: SendingIdentity[]
    connectLabel: string
    addLabel: string
  }) => (
    <Card className="sending-card">
      <div className="sending-head">
        <span className="sending-icon">{options.icon}</span>
        <div><h3>{options.title}</h3><p>{options.plain}</p></div>
      </div>
      {options.rows.length ? <ul className="sending-list">{options.rows.map((row) => (
        <li key={row.id}>
          <span className="sending-tick"><CheckCircle2 size={15} /></span>
          <div>
            <strong>{row.label}</strong>
            <small>{providerLabel(row.provider)}{row.fromAddress ? ` · ${row.fromAddress}` : row.fromNumber ? ` · ${row.fromNumber}` : ''}</small>
          </div>
          {row.isDefault && <StatusBadge status="active" label="Used by default" />}
        </li>
      ))}</ul> : <p className="sending-empty">Not set up yet. Until this is done, nothing can be sent.</p>}
      {canManage && <Button variant={options.rows.length ? 'secondary' : 'primary'} onClick={() => setDialog(options.key)}>
        {options.rows.length ? options.addLabel : options.connectLabel}
      </Button>}
    </Card>
  )

  return <section className="sending-section">
    <header className="section-heading">
      <h2>How you send</h2>
      <p>Messages go out from your own email and phone number, and payments arrive in your own account. Set these up first — nothing can be sent until you do.</p>
    </header>
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}
    {query.error && <Alert>{query.error}</Alert>}

    <div className="sending-grid">
      {channelCard({
        key: 'email',
        icon: <Mail size={19} />,
        title: 'Email',
        plain: 'The address your follow-up arrives from. Use your own mail server or a SendGrid key.',
        rows: emailIdentities,
        connectLabel: 'Set up email',
        addLabel: 'Add another address',
      })}
      {channelCard({
        key: 'sms',
        icon: <MessageSquare size={19} />,
        title: 'Text messages',
        plain: 'The number your texts come from, through your own Twilio account.',
        rows: smsIdentities,
        connectLabel: 'Set up text messages',
        addLabel: 'Add another number',
      })}
      <Card className="sending-card">
        <div className="sending-head">
          <span className="sending-icon"><CreditCard size={19} /></span>
          <div><h3>Taking payment</h3><p>Your own Stripe account, so money from a payment link goes straight to you.</p></div>
        </div>
        <p className="sending-empty">Saving a key replaces the one before it. We cannot show you the key back, so this panel does not report whether one is already saved.</p>
        {canManage && <Button onClick={() => setDialog('payments')}>Save a Stripe key</Button>}
      </Card>
    </div>

    <Card className="security-note">
      <ShieldCheck size={21} />
      <div>
        <strong>What happens to these details</strong>
        <p>They are sent once over HTTPS, encrypted before they are stored, and never shown again — not to us and not back to you. Messages are sent under your name, so replies come to you.</p>
      </div>
    </Card>

    <Modal
      open={dialog === 'email'}
      title="Set up email"
      description="Follow-up will arrive from this address. Your customers reply to you."
      onClose={closeDialog}
      footer={<><Button onClick={closeDialog}>Cancel</Button><Button variant="primary" type="submit" form="sending-email-form" busy={action.loading}>Save email setup</Button></>}
    >
      <form id="sending-email-form" className="form-stack" onSubmit={saveEmail}>
        <Field label="How do you send email?">
          <select value={email.transport} onChange={(event) => setEmail((current) => ({ ...current, transport: event.target.value }))}>
            <option value="smtp">My own mail server</option>
            <option value="sendgrid">SendGrid</option>
          </select>
        </Field>
        <Field label="Name this setup" hint="Only you see this. For example: Office email.">
          <input value={email.label} onChange={(event) => setEmail((current) => ({ ...current, label: event.target.value }))} placeholder="Office email" />
        </Field>
        <Field label="Send from address" required>
          <input type="email" value={email.fromAddress} onChange={(event) => setEmail((current) => ({ ...current, fromAddress: event.target.value }))} placeholder="you@yourbusiness.co.uk" required autoFocus />
        </Field>
        <Field label="Name shown to your customer" hint="Optional. Left blank, only the address is shown.">
          <input value={email.fromName} onChange={(event) => setEmail((current) => ({ ...current, fromName: event.target.value }))} placeholder="Ridgeway Plumbing" />
        </Field>
        {email.transport === 'smtp' ? <>
          <div className="form-grid">
            <Field label="Mail server" hint="Your provider gives you this." required>
              <input value={email.host} onChange={(event) => setEmail((current) => ({ ...current, host: event.target.value }))} placeholder="smtp.yourprovider.com" required />
            </Field>
            <Field label="Port" required>
              <input type="number" min={1} max={65535} value={email.port} onChange={(event) => setEmail((current) => ({ ...current, port: event.target.value }))} required />
            </Field>
          </div>
          <label className="check"><input type="checkbox" checked={email.secure} onChange={(event) => setEmail((current) => ({ ...current, secure: event.target.checked }))} /><span>Use a secure connection (leave this on unless your provider says otherwise)</span></label>
          <Field label="Username">
            <input autoComplete="off" value={email.user} onChange={(event) => setEmail((current) => ({ ...current, user: event.target.value }))} />
          </Field>
          <Field label="Password" hint="Stored encrypted. It is never shown again.">
            <input type="password" autoComplete="new-password" value={email.password} onChange={(event) => setEmail((current) => ({ ...current, password: event.target.value }))} />
          </Field>
        </> : (
          <Field label="SendGrid API key" hint="Stored encrypted. It is never shown again." required>
            <input type="password" autoComplete="off" minLength={10} value={email.apiKey} onChange={(event) => setEmail((current) => ({ ...current, apiKey: event.target.value }))} required />
          </Field>
        )}
      </form>
    </Modal>

    <Modal
      open={dialog === 'sms'}
      title="Set up text messages"
      description="Texts go out through your own Twilio account, from your own number."
      onClose={closeDialog}
      footer={<><Button onClick={closeDialog}>Cancel</Button><Button variant="primary" type="submit" form="sending-sms-form" busy={action.loading}>Save text setup</Button></>}
    >
      <form id="sending-sms-form" className="form-stack" onSubmit={saveSms}>
        <Field label="Name this setup" hint="Only you see this.">
          <input value={sms.label} onChange={(event) => setSms((current) => ({ ...current, label: event.target.value }))} placeholder="Mobile number" />
        </Field>
        <Field label="Send from number" hint="Include the country code, for example +447700900123." required>
          <input value={sms.fromNumber} onChange={(event) => setSms((current) => ({ ...current, fromNumber: event.target.value }))} placeholder="+447700900123" required autoFocus />
        </Field>
        <Field label="Twilio account SID" required>
          <input autoComplete="off" minLength={10} value={sms.accountSid} onChange={(event) => setSms((current) => ({ ...current, accountSid: event.target.value }))} required />
        </Field>
        <Field label="Twilio auth token" hint="Stored encrypted. It is never shown again." required>
          <input type="password" autoComplete="off" minLength={10} value={sms.authToken} onChange={(event) => setSms((current) => ({ ...current, authToken: event.target.value }))} required />
        </Field>
      </form>
    </Modal>

    <Modal
      open={dialog === 'payments'}
      title="Save a Stripe key"
      description="This is your own Stripe account. Payments go to you, not to us."
      onClose={closeDialog}
      footer={<><Button onClick={closeDialog}>Cancel</Button><Button variant="primary" type="submit" form="sending-payments-form" busy={action.loading}>Save Stripe key</Button></>}
    >
      <form id="sending-payments-form" className="form-stack" onSubmit={savePayments}>
        <Field label="Stripe secret key" hint="Begins sk_ or rk_. Find it in your Stripe dashboard under Developers, API keys." required>
          <input type="password" autoComplete="off" value={payments.secretKey} onChange={(event) => setPayments({ secretKey: event.target.value })} required autoFocus />
        </Field>
      </form>
    </Modal>
  </section>
}
