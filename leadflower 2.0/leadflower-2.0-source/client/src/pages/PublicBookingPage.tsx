import React from 'react'
import { CalendarDays, Check, Clock, MapPin } from 'lucide-react'
import { useParams } from '../router'

/**
 * The page a customer sees when they open a booking link.
 *
 * Public and unauthenticated — the person booking has no account and never
 * will. It talks to the public API directly rather than through the
 * authenticated client, because there is no session to attach.
 *
 * The timezone rule throughout: the business defines its hours in ITS OWN zone,
 * the server returns instants, and this page renders them in the VISITOR's
 * zone. Nobody converts anything by hand, and a customer in another country
 * sees times that mean what they expect.
 */

interface PageConfig {
  title: string
  description?: string
  location?: string
  businessName: string
  timeZone: string
  slotMinutes: number
  fields: Array<{ field: string; label: string; required?: boolean }>
  consentText?: string | null
  successMessage: string
}

interface Availability {
  days: Array<{ date: string; slots: Array<{ startAt: string; endAt: string }> }>
}

const API = '/api/v1/public/booking'
const visitorZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'omit' })
  if (!response.ok) throw new Error(response.status === 404 ? 'This booking link is not available.' : 'Could not load availability.')
  return await response.json() as T
}

export default function PublicBookingPage() {
  const params = useParams()
  const slug = params.slug ?? ''

  const [config, setConfig] = React.useState<PageConfig | null>(null)
  const [availability, setAvailability] = React.useState<Availability | null>(null)
  const [activeDay, setActiveDay] = React.useState<string | null>(null)
  const [chosen, setChosen] = React.useState<string | null>(null)
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [booked, setBooked] = React.useState<{ startAt: string; message: string } | null>(null)

  React.useEffect(() => {
    if (!slug) return
    let cancelled = false
    void (async () => {
      try {
        const [page, slots] = await Promise.all([
          getJson<PageConfig>(`${API}/${encodeURIComponent(slug)}`),
          getJson<Availability>(`${API}/${encodeURIComponent(slug)}/availability`),
        ])
        if (cancelled) return
        setConfig(page)
        setAvailability(slots)
        setActiveDay(slots.days.find((day) => day.slots.length)?.date ?? null)
      } catch (loadError) {
        if (!cancelled) setError((loadError as Error).message)
      }
    })()
    return () => { cancelled = true }
  }, [slug])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${API}/${encodeURIComponent(slug)}/bookings`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startAt: chosen, answers, timeZone: visitorZone }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        // A 409 means somebody took the slot in the meantime. Refreshing the
        // list matters more than the message — leaving a stale calendar on
        // screen invites them to pick the same gone slot again.
        setError(body?.detail || body?.title || 'That time is no longer available.')
        if (response.status === 409) {
          setChosen(null)
          setAvailability(await getJson<Availability>(`${API}/${encodeURIComponent(slug)}/availability`))
        }
        return
      }
      setBooked({ startAt: chosen, message: body.message || config?.successMessage || 'Booked.' })
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (error && !config) return <main className="booking-public"><div className="booking-card"><p className="booking-error">{error}</p></div></main>
  if (!config) return <main className="booking-public"><div className="booking-card"><p className="muted">Loading…</p></div></main>

  if (booked) {
    const when = new Date(booked.startAt)
    return <main className="booking-public">
      <div className="booking-card booking-done">
        <span className="booking-tick"><Check size={26} /></span>
        <h1>You're booked in</h1>
        <p className="booking-when">
          {when.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          <strong>{when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</strong>
        </p>
        {/* The visitor's own zone is named, so there is no ambiguity later. */}
        <p className="muted">Times shown in your local time ({visitorZone}).</p>
        <p>{booked.message}</p>
      </div>
    </main>
  }

  const day = availability?.days.find((entry) => entry.date === activeDay)
  const hasAny = availability?.days.some((entry) => entry.slots.length)

  return <main className="booking-public">
    <div className="booking-card">
      <header className="booking-head">
        <p className="booking-business">{config.businessName}</p>
        <h1>{config.title}</h1>
        {config.description && <p className="muted">{config.description}</p>}
        <div className="booking-meta">
          <span><Clock size={14} />{config.slotMinutes} minutes</span>
          {config.location && <span><MapPin size={14} />{config.location}</span>}
        </div>
      </header>

      {!hasAny ? <p className="muted">No times are available at the moment. Please check back shortly.</p> : <>
        <section className="booking-step">
          <h2><CalendarDays size={16} />Pick a day</h2>
          <div className="day-strip-picker">
            {availability!.days.filter((entry) => entry.slots.length).map((entry) => {
              const date = new Date(`${entry.date}T12:00:00`)
              return <button
                type="button" key={entry.date}
                className={activeDay === entry.date ? 'day-pill selected' : 'day-pill'}
                onClick={() => { setActiveDay(entry.date); setChosen(null) }}
              >
                <span>{date.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                <strong>{date.getDate()}</strong>
                <span>{date.toLocaleDateString(undefined, { month: 'short' })}</span>
              </button>
            })}
          </div>
        </section>

        <section className="booking-step">
          <h2>Pick a time</h2>
          <div className="slot-grid">
            {(day?.slots ?? []).map((slot) => <button
              type="button" key={slot.startAt}
              className={chosen === slot.startAt ? 'slot selected' : 'slot'}
              onClick={() => setChosen(slot.startAt)}
            >
              {new Date(slot.startAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </button>)}
          </div>
          <p className="muted booking-zone">Times shown in your local time ({visitorZone}).</p>
        </section>

        {chosen && <form className="booking-step booking-form" onSubmit={submit}>
          <h2>Your details</h2>
          {config.fields.map((field) => <label key={field.field}>
            <span>{field.label}{field.required && <em> *</em>}</span>
            {field.field === 'notes'
              ? <textarea rows={3} value={answers[field.field] ?? ''} required={field.required}
                onChange={(event) => setAnswers((current) => ({ ...current, [field.field]: event.target.value }))} />
              : <input
                type={field.field === 'email' ? 'email' : field.field.includes('hone') ? 'tel' : 'text'}
                value={answers[field.field] ?? ''} required={field.required}
                onChange={(event) => setAnswers((current) => ({ ...current, [field.field]: event.target.value }))} />}
          </label>)}

          {/*
            The exact wording shown is stored with the booking, so what somebody
            agreed to survives any later edit of this page.
          */}
          {config.consentText && <p className="booking-consent">{config.consentText}</p>}
          {error && <p className="booking-error">{error}</p>}

          <button type="submit" className="booking-submit" disabled={busy}>
            {busy ? 'Booking…' : `Confirm ${new Date(chosen).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`}
          </button>
        </form>}
      </>}
    </div>
  </main>
}
