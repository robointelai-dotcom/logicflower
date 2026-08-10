import React from 'react'
import { Building2, Mail, Phone, Plus, Search, UserPlus, Users } from 'lucide-react'
import { getList, send } from '../api/client'
import { Link } from '../router'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { HelpLink } from './HelpPage'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'
import { usePermissions } from '../hooks/usePermissions'

interface ContactRow extends UnknownRecord {
  id: string
  name?: string
  firstName?: string
  lastName?: string
  companyName?: string
  email?: string
  phone?: string
  lifecycleStatus?: string
  tags?: string[]
  lastActivityAt?: string
}

const LIFECYCLE = ['lead', 'engaged', 'qualified', 'customer', 'churned', 'unqualified'] as const

export function displayName(contact: ContactRow): string {
  return contact.name?.trim()
    || [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim()
    || contact.companyName?.trim()
    // Never fall through to an email address as a display name: it puts a
    // personal identifier into every list, export and screenshot.
    || 'Unnamed contact'
}

export default function ContactsPage() {
  const { canOperate } = usePermissions()
  const [search, setSearch] = React.useState('')
  const [applied, setApplied] = React.useState('')
  const [lifecycle, setLifecycle] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState({
    firstName: '', lastName: '', email: '', phone: '', companyName: '',
    jobTitle: '', secondaryPhone: '',
    addressLine1: '', addressLine2: '', city: '', region: '', postalCode: '', country: '',
    lifecycleStatus: 'lead', preferredContactMethod: '', referredBy: '', leadScore: '',
  })
  const [showMore, setShowMore] = React.useState(false)
  const action = useAction()
  const set = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }))

  const query = useApi(async () => {
    const params = new URLSearchParams()
    if (applied) params.set('q', applied)
    if (lifecycle) params.set('lifecycleStatus', lifecycle)
    const suffix = params.toString()
    return (await getList<ContactRow>(`/crm/contacts${suffix ? `?${suffix}` : ''}`, ['contacts'])).items
  }, [applied, lifecycle])

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    // At least one reachable address, or the contact can never be sent to and
    // every sequence would exit on its first step.
    if (!form.email.trim() && !form.phone.trim()) {
      await action.run(async () => { throw new Error('A contact needs an email address or a phone number.') })
      return
    }
    // Empty strings are stripped rather than sent: posting an empty postcode
    // would store one, and "" is not the same as "not supplied".
    const payload: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(form)) {
      if (String(value).trim()) payload[key] = value
    }
    if (payload.leadScore !== undefined) payload.leadScore = Number(payload.leadScore)

    const result = await action.run(() => send('post', '/crm/contacts', payload), 'Contact created.')
    if (result !== undefined) {
      setOpen(false)
      setForm({
        firstName: '', lastName: '', email: '', phone: '', companyName: '',
        jobTitle: '', secondaryPhone: '',
        addressLine1: '', addressLine2: '', city: '', region: '', postalCode: '', country: '',
        lifecycleStatus: 'lead', preferredContactMethod: '', referredBy: '', leadScore: '',
      })
      setShowMore(false)
      await query.reload()
    }
  }

  return <>
    <PageHeader
      eyebrow="Micro-CRM"
      title="Contacts"
      description="Everyone this workspace can reach, wherever they came from."
      actions={canOperate && <Button variant="primary" onClick={() => setOpen(true)}><UserPlus size={16} />New contact</Button>}
      help={<HelpLink route="/contacts" />}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    <Card>
      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); setApplied(search.trim()) }}>
        <label className="search-input">
          <Search size={16} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, company or email" aria-label="Search contacts" />
        </label>
        <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value)} aria-label="Lifecycle status">
          <option value="">All statuses</option>
          {LIFECYCLE.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
        <Button type="submit">Search</Button>
      </form>
    </Card>

    {query.loading ? <SkeletonRows rows={6} columns={5} />
      : query.error ? <Alert>{query.error}</Alert>
        : query.data?.length ? <Card>
          <table className="data-table">
            <thead><tr><th>Name</th><th>Contact</th><th>Status</th><th>Tags</th></tr></thead>
            <tbody>
              {query.data.map((contact) => <tr key={contact.id}>
                <td>
                  <Link to={`/contacts/${contact.id}`}><strong>{displayName(contact)}</strong></Link>
                  {contact.companyName && <div className="muted"><Building2 size={13} /> {contact.companyName}</div>}
                </td>
                <td>
                  {contact.email && <div className="muted"><Mail size={13} /> {contact.email}</div>}
                  {contact.phone && <div className="muted"><Phone size={13} /> {contact.phone}</div>}
                </td>
                <td><StatusBadge status={contact.lifecycleStatus === 'customer' ? 'active' : contact.lifecycleStatus === 'churned' ? 'failed' : 'pending'} label={contact.lifecycleStatus} /></td>
                <td>{(contact.tags ?? []).slice(0, 3).map((tag) => <span key={tag} className="chip">{tag}</span>)}</td>
              </tr>)}
            </tbody>
          </table>
        </Card>
          : <Card><EmptyState icon={<Users />} title="No contacts yet" description="Add one by hand, import a CSV, or let a hosted form collect them." action={canOperate ? <Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />New contact</Button> : undefined} /></Card>}

    <Modal
      open={open}
      title="New contact"
      description="An email address or phone number is required — without one, nothing can be sent to them."
      onClose={() => setOpen(false)}
      footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="contact-form" busy={action.loading}>Create contact</Button></>}
    >
      <form id="contact-form" className="form-stack" onSubmit={create}>
        <div className="field-row">
          <Field label="First name"><input value={form.firstName} onChange={(event) => set('firstName', event.target.value)} autoFocus /></Field>
          <Field label="Last name"><input value={form.lastName} onChange={(event) => set('lastName', event.target.value)} /></Field>
        </div>
        <div className="field-row">
          <Field label="Company"><input value={form.companyName} onChange={(event) => set('companyName', event.target.value)} /></Field>
          <Field label="Job title"><input value={form.jobTitle} onChange={(event) => set('jobTitle', event.target.value)} /></Field>
        </div>
        <Field label="Email"><input type="email" value={form.email} onChange={(event) => set('email', event.target.value)} /></Field>
        <div className="field-row">
          <Field label="Phone" hint="International format, e.g. +919876543210"><input value={form.phone} onChange={(event) => set('phone', event.target.value)} /></Field>
          <Field label="Second phone"><input value={form.secondaryPhone} onChange={(event) => set('secondaryPhone', event.target.value)} /></Field>
        </div>

        {/*
          The rest is collapsed by default. Every field the API accepts is here,
          but a form of eighteen inputs is one nobody fills in — the four that
          matter stay above the fold.
        */}
        <button type="button" className="disclosure" onClick={() => setShowMore((current) => !current)}>
          {showMore ? 'Fewer details' : 'Add address, status and more'}
        </button>

        {showMore && <>
          <Field label="Address"><input value={form.addressLine1} onChange={(event) => set('addressLine1', event.target.value)} placeholder="Street address" /></Field>
          <Field label=""><input value={form.addressLine2} onChange={(event) => set('addressLine2', event.target.value)} placeholder="Flat, unit, building" /></Field>
          <div className="field-row">
            <Field label="City"><input value={form.city} onChange={(event) => set('city', event.target.value)} /></Field>
            <Field label="State or region"><input value={form.region} onChange={(event) => set('region', event.target.value)} /></Field>
          </div>
          <div className="field-row">
            <Field label="Postcode"><input value={form.postalCode} onChange={(event) => set('postalCode', event.target.value)} /></Field>
            <Field label="Country"><input value={form.country} onChange={(event) => set('country', event.target.value)} /></Field>
          </div>
          <div className="field-row">
            <Field label="Status">
              <select value={form.lifecycleStatus} onChange={(event) => set('lifecycleStatus', event.target.value)}>
                {LIFECYCLE.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </Field>
            <Field label="Prefers to be contacted by">
              <select value={form.preferredContactMethod} onChange={(event) => set('preferredContactMethod', event.target.value)}>
                <option value="">No preference</option>
                <option value="phone">Phone</option>
                <option value="sms">SMS</option>
                <option value="email">Email</option>
                <option value="whatsapp">WhatsApp</option>
              </select>
            </Field>
          </div>
          <div className="field-row">
            <Field label="Referred by"><input value={form.referredBy} onChange={(event) => set('referredBy', event.target.value)} /></Field>
            <Field label="Lead score" hint="0 to 100, your own judgement"><input type="number" min={0} max={100} value={form.leadScore} onChange={(event) => set('leadScore', event.target.value)} /></Field>
          </div>
        </>}
      </form>
    </Modal>
  </>
}
