import React from 'react'
import { CalendarClock, Copy, Globe, Plus } from 'lucide-react'
import { getList, send } from '../api/client'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { HelpLink } from './HelpPage'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'

interface WorkingWindow { weekday: number; startMinute: number; endMinute: number }
interface PageRow extends UnknownRecord {
  id: string; name: string; title: string; slug: string; status: string
  timeZone: string; slotMinutes: number; horizonDays: number
  bookingCount: number; workingWindows: WorkingWindow[]
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

export default function BookingPagesPage() {
  const action = useAction()
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState({
    name: '', title: '', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    slotMinutes: 30, startMinute: 9 * 60, endMinute: 17 * 60,
    weekdays: [1, 2, 3, 4, 5] as number[],
    bufferAfterMinutes: 0, minimumNoticeMinutes: 120, horizonDays: 30,
  })

  const query = useApi(async () => (await getList<PageRow>('/booking/pages', ['pages'])).items, [])

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send('post', '/booking/pages', {
      name: form.name,
      title: form.title || form.name,
      timeZone: form.timeZone,
      slotMinutes: form.slotMinutes,
      slotIntervalMinutes: form.slotMinutes,
      bufferAfterMinutes: form.bufferAfterMinutes,
      minimumNoticeMinutes: form.minimumNoticeMinutes,
      horizonDays: form.horizonDays,
      workingWindows: form.weekdays.map((weekday) => ({ weekday, startMinute: form.startMinute, endMinute: form.endMinute })),
      fields: [
        { field: 'firstName', label: 'Your name', required: true },
        { field: 'email', label: 'Email address', required: true },
        { field: 'phone', label: 'Phone number' },
        { field: 'notes', label: 'Anything we should know?' },
      ],
    }), 'Booking page created as a draft.')
    if (result !== undefined) { setOpen(false); await query.reload() }
  }

  const setStatus = async (page: PageRow, status: string) => {
    const result = await action.run(() => send('post', `/booking/pages/${page.id}/status`, { status }),
      status === 'published' ? 'Published. The link is live.' : 'Updated.')
    if (result !== undefined) await query.reload()
  }

  // The page a customer opens, not the API the page calls.
  const bookingUrl = (slug: string) => `${window.location.origin}/book/${slug}`

  return <>
    <PageHeader
      eyebrow="Scheduling"
      title="Booking pages"
      description="Share a link. People pick a time that is genuinely free, and the confirmation runs through your sequences."
      actions={<Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />
    <HelpLink route="/booking" />New booking page</Button>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    {query.loading ? <SkeletonRows rows={3} columns={4} />
      : query.error ? <Alert>{query.error}</Alert>
        : query.data?.length ? <Card>
          <table className="data-table">
            <thead><tr><th>Page</th><th>Hours</th><th>Status</th><th>Booked</th><th /></tr></thead>
            <tbody>{query.data.map((page) => <tr key={page.id}>
              <td>
                <strong>{page.title}</strong>
                <div className="muted"><Globe size={13} /> {page.timeZone} · {page.slotMinutes} min</div>
              </td>
              <td className="muted">
                {page.workingWindows.length
                  ? `${[...new Set(page.workingWindows.map((window) => DAYS[window.weekday]))].join(' ')} · ${clock(page.workingWindows[0]!.startMinute)}–${clock(page.workingWindows[0]!.endMinute)}`
                  : 'Not configured'}
              </td>
              <td><StatusBadge status={page.status === 'published' ? 'active' : page.status === 'disabled' ? 'paused' : 'pending'} label={page.status} /></td>
              <td className="muted">{page.bookingCount}</td>
              <td className="row-actions">
                {page.status === 'published'
                  ? <>
                    <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(bookingUrl(page.slug)) }}><Copy size={14} />Copy link</Button>
                    <Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void setStatus(page, 'disabled') }}>Disable</Button>
                  </>
                  : <Button size="sm" variant="ghost" busy={action.loading} onClick={() => { void setStatus(page, 'published') }}>Publish</Button>}
              </td>
            </tr>)}</tbody>
          </table>
        </Card>
          : <Card><EmptyState icon={<CalendarClock />} title="No booking pages" description="Create one and share the link. Availability is worked out from your hours and whatever is already in the calendar." action={<Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />New booking page</Button>} /></Card>}

    <Modal
      open={open}
      title="New booking page"
      description="Created as a draft. Publishing is refused if the settings would show an empty calendar."
      onClose={() => setOpen(false)}
      footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="booking-form" busy={action.loading}>Create</Button></>}
    >
      <form id="booking-form" className="form-stack" onSubmit={create}>
        <Field label="Name" hint="Internal — how you'll recognise it." required>
          <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required autoFocus placeholder="Consultation" />
        </Field>
        <Field label="Heading" hint="What the person booking sees.">
          <input value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder="Book a consultation" />
        </Field>
        <Field label="Timezone" hint="Your hours are in this zone. Visitors see times converted to theirs.">
          <input value={form.timeZone} onChange={(event) => setForm((current) => ({ ...current, timeZone: event.target.value }))} />
        </Field>
        <Field label="Days">
          <div className="choice-grid">
            {DAYS.map((label, weekday) => <button
              type="button" key={label}
              className={form.weekdays.includes(weekday) ? 'selected' : ''}
              onClick={() => setForm((current) => ({
                ...current,
                weekdays: current.weekdays.includes(weekday) ? current.weekdays.filter((day) => day !== weekday) : [...current.weekdays, weekday],
              }))}
            >{label}</button>)}
          </div>
        </Field>
        <div className="field-row">
          <Field label="Opens"><input type="time" value={clock(form.startMinute)} onChange={(event) => {
            const [hour, minute] = event.target.value.split(':').map(Number)
            setForm((current) => ({ ...current, startMinute: (hour ?? 9) * 60 + (minute ?? 0) }))
          }} /></Field>
          <Field label="Closes"><input type="time" value={clock(form.endMinute)} onChange={(event) => {
            const [hour, minute] = event.target.value.split(':').map(Number)
            setForm((current) => ({ ...current, endMinute: (hour ?? 17) * 60 + (minute ?? 0) }))
          }} /></Field>
        </div>
        <div className="field-row">
          <Field label="Appointment length" hint="Minutes"><input type="number" min={5} max={480} value={form.slotMinutes} onChange={(event) => setForm((current) => ({ ...current, slotMinutes: Number(event.target.value) }))} /></Field>
          <Field label="Gap after each one" hint="Minutes"><input type="number" min={0} max={240} value={form.bufferAfterMinutes} onChange={(event) => setForm((current) => ({ ...current, bufferAfterMinutes: Number(event.target.value) }))} /></Field>
        </div>
        <div className="field-row">
          <Field label="Shortest notice" hint="Minutes before the earliest bookable slot"><input type="number" min={0} value={form.minimumNoticeMinutes} onChange={(event) => setForm((current) => ({ ...current, minimumNoticeMinutes: Number(event.target.value) }))} /></Field>
          <Field label="Book up to" hint="Days ahead"><input type="number" min={1} max={180} value={form.horizonDays} onChange={(event) => setForm((current) => ({ ...current, horizonDays: Number(event.target.value) }))} /></Field>
        </div>
      </form>
    </Modal>
  </>
}
