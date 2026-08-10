import React from 'react'
import { Building2, Plus, Trash2 } from 'lucide-react'
import { getOne, send } from '../api/client'
import { Alert, Button, Card, Field, PageHeader, SkeletonRows } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'

/**
 * The customer's business, described so search engines can read it.
 *
 * One form. Grouped in the order somebody would actually answer, and with a
 * preview underneath showing what the result looks like in a search result —
 * not the raw JSON-LD, which nobody reads.
 */

const DAYS = [
  { key: 'mon', label: 'Monday' }, { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' }, { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' }, { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
]

export default function BusinessProfilePage() {
  const action = useAction()
  const [profile, setProfile] = React.useState<any>(null)
  const [loaded, setLoaded] = React.useState(false)

  const types = useApi(async () => (await getOne<{ types: any[] }>('/visibility/business-types')).types, [])
  const query = useApi(async () => await getOne<{ profile: any; preview: any }>('/visibility/profile'), [])

  React.useEffect(() => {
    if (loaded || query.loading) return
    setProfile(query.data?.profile ?? {
      openingHours: DAYS.map((day) => ({ day: day.key, opens: '09:00', closes: '17:00', closed: day.key === 'sun' })),
      serviceAreaKind: 'none', businessType: 'LocalBusiness', credentials: [], hoursExceptions: [],
    })
    setLoaded(true)
  }, [query.loading, query.data, loaded])

  const set = (key: string, value: unknown) => setProfile((current: any) => ({ ...current, [key]: value }))

  const save = async () => {
    const result = await action.run(() => send('put', '/visibility/profile', profile), 'Saved.')
    if (result !== undefined) await query.reload()
  }

  if (!loaded) return <SkeletonRows rows={5} columns={2} />

  const grouped = (types.data ?? []).reduce((groups: Record<string, any[]>, type: any) => {
    ;(groups[type.group] ??= []).push(type)
    return groups
  }, {})

  return <>
    <PageHeader
      eyebrow="Getting found"
      title="My business"
      description="What search engines need to know about you. Fill this in once."
      actions={<Button variant="primary" busy={action.loading} onClick={() => { void save() }}>Save</Button>}
    />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}
    {action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}

    <div className="editor-layout">
      <div className="editor-steps">
        <Card title="What you do">
          <div className="field-row">
            <Field label="Business name" required>
              <input value={profile.tradingName ?? ''} onChange={(event) => set('tradingName', event.target.value)} placeholder="Ridgeway Plumbing" />
            </Field>
            <Field label="Trade" hint="Pick the closest. It changes what search engines understand about you.">
              <select value={profile.businessType ?? 'LocalBusiness'} onChange={(event) => set('businessType', event.target.value)}>
                {Object.entries(grouped).map(([group, entries]) => <optgroup key={group} label={group}>
                  {(entries as any[]).map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </optgroup>)}
              </select>
            </Field>
          </div>
          <Field label="Registered name" hint="Only if different from the name customers know.">
            <input value={profile.legalName ?? ''} onChange={(event) => set('legalName', event.target.value)} />
          </Field>
          <Field label="What you offer" hint="Comma separated. Boiler repair, bathroom fitting, emergency callout.">
            <input value={(profile.services ?? []).join(', ')}
              onChange={(event) => set('services', event.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))} />
          </Field>
        </Card>

        <Card title="Where you are">
          <Field label="Address"><input value={profile.addressLine1 ?? ''} onChange={(event) => set('addressLine1', event.target.value)} /></Field>
          <div className="field-row">
            <Field label="Town or city"><input value={profile.city ?? ''} onChange={(event) => set('city', event.target.value)} /></Field>
            <Field label="Postcode"><input value={profile.postalCode ?? ''} onChange={(event) => set('postalCode', event.target.value)} /></Field>
          </div>
          <div className="field-row">
            <Field label="Region or state"><input value={profile.region ?? ''} onChange={(event) => set('region', event.target.value)} /></Field>
            <Field label="Country"><input value={profile.country ?? ''} onChange={(event) => set('country', event.target.value)} /></Field>
          </div>
        </Card>

        {/*
          Where they work is often not where they are. A plumber has a home
          address and covers thirty miles; a salon has a shop people come to.
        */}
        <Card title="Where you work" subtitle="Often not the same as where you are based.">
          <Field label="How you cover it">
            <select value={profile.serviceAreaKind ?? 'none'} onChange={(event) => set('serviceAreaKind', event.target.value)}>
              <option value="none">Customers come to me</option>
              <option value="named">I cover specific areas</option>
              <option value="radius">I travel a distance</option>
            </select>
          </Field>
          {profile.serviceAreaKind === 'named' && <Field label="Areas you cover" hint="Comma separated.">
            <input value={(profile.serviceAreaPlaces ?? []).join(', ')}
              onChange={(event) => set('serviceAreaPlaces', event.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))} />
          </Field>}
          {profile.serviceAreaKind === 'radius' && <div className="field-row">
            <Field label="How far, in km"><input type="number" value={profile.serviceAreaRadiusKm ?? 0} onChange={(event) => set('serviceAreaRadiusKm', Number(event.target.value))} /></Field>
            <Field label="From" hint="Latitude and longitude of your base.">
              <div className="wait-row">
                <input type="number" step="0.0001" value={profile.latitude ?? ''} onChange={(event) => set('latitude', Number(event.target.value))} placeholder="Lat" />
                <input type="number" step="0.0001" value={profile.longitude ?? ''} onChange={(event) => set('longitude', Number(event.target.value))} placeholder="Long" />
              </div>
            </Field>
          </div>}
        </Card>

        <Card title="When you're open">
          <div className="hours-grid">
            {DAYS.map((day) => {
              const entry = (profile.openingHours ?? []).find((h: any) => h.day === day.key) ?? { day: day.key }
              const update = (patch: any) => set('openingHours', DAYS.map((d) => {
                const existing = (profile.openingHours ?? []).find((h: any) => h.day === d.key) ?? { day: d.key }
                return d.key === day.key ? { ...existing, ...patch } : existing
              }))
              return <div key={day.key} className="hours-row">
                <span>{day.label}</span>
                <label className="toggle-row">
                  <input type="checkbox" checked={!entry.closed} onChange={(event) => update({ closed: !event.target.checked })} />
                  <span>Open</span>
                </label>
                <input type="time" value={entry.opens ?? '09:00'} disabled={entry.closed} onChange={(event) => update({ opens: event.target.value })} />
                <input type="time" value={entry.closes ?? '17:00'} disabled={entry.closed} onChange={(event) => update({ closes: event.target.value })} />
              </div>
            })}
          </div>

          {/*
            Holidays matter more than they look. Showing "open" on a bank
            holiday sends somebody on a wasted journey and earns a one-star
            review — the opposite of what this whole section is for.
          */}
          <Field label="Days you're closed" hint="Bank holidays and one-offs. Worth doing — showing open when you're shut costs you a review.">
            <div className="restricted-list">
              {(profile.hoursExceptions ?? []).map((entry: any, index: number) => <div key={index} className="restricted-row">
                <input type="date" value={entry.date ?? ''}
                  onChange={(event) => set('hoursExceptions', profile.hoursExceptions.map((e: any, i: number) => i === index ? { ...e, date: event.target.value } : e))} />
                <input value={entry.note ?? ''} placeholder="Christmas Day"
                  onChange={(event) => set('hoursExceptions', profile.hoursExceptions.map((e: any, i: number) => i === index ? { ...e, note: event.target.value } : e))} />
                <Button size="sm" variant="ghost" aria-label="Remove"
                  onClick={() => set('hoursExceptions', profile.hoursExceptions.filter((_: any, i: number) => i !== index))}><Trash2 size={13} /></Button>
              </div>)}
            </div>
            <Button size="sm" onClick={() => set('hoursExceptions', [...(profile.hoursExceptions ?? []), { date: '', closed: true, note: '' }])}>
              <Plus size={14} />Add a closed day
            </Button>
          </Field>
        </Card>

        <Card title="Registrations and memberships" subtitle="Only what you actually hold — these are published as claims about your business.">
          <div className="restricted-list">
            {(profile.credentials ?? []).map((credential: any, index: number) => <div key={index} className="restricted-row">
              <input value={credential.name ?? ''} placeholder="Gas Safe registered"
                onChange={(event) => set('credentials', profile.credentials.map((c: any, i: number) => i === index ? { ...c, name: event.target.value } : c))} />
              <input value={credential.identifier ?? ''} placeholder="Registration number"
                onChange={(event) => set('credentials', profile.credentials.map((c: any, i: number) => i === index ? { ...c, identifier: event.target.value } : c))} />
              <Button size="sm" variant="ghost" aria-label="Remove"
                onClick={() => set('credentials', profile.credentials.filter((_: any, i: number) => i !== index))}><Trash2 size={13} /></Button>
            </div>)}
          </div>
          <Button size="sm" onClick={() => set('credentials', [...(profile.credentials ?? []), { name: '', identifier: '' }])}>
            <Plus size={14} />Add one
          </Button>
        </Card>
      </div>

      <aside className="editor-side">
        <Card title="How to reach you">
          <Field label="Phone"><input value={profile.telephone ?? ''} onChange={(event) => set('telephone', event.target.value)} /></Field>
          <Field label="Email"><input type="email" value={profile.email ?? ''} onChange={(event) => set('email', event.target.value)} /></Field>
          <Field label="Website" hint="Where your schema will be installed."><input value={profile.website ?? ''} onChange={(event) => set('website', event.target.value)} placeholder="https://" /></Field>
          <Field label="Typical prices" hint="A rough band, e.g. ££ or $$">
            <input value={profile.priceRange ?? ''} onChange={(event) => set('priceRange', event.target.value)} />
          </Field>
        </Card>

        {/*
          "What Google sees" as a mocked-up result, not raw JSON-LD. An operator
          who can see the output understands why the fields matter; nobody reads
          a structured-data blob.
        */}
        <Card title="What Google sees" subtitle="Roughly how you appear once this is on your website.">
          {profile.tradingName ? <div className="serp-preview">
            <span className="serp-title">{profile.tradingName}</span>
            <span className="serp-url">{profile.website || 'your-website.example'}</span>
            <span className="serp-meta">
              {[types.data?.find((t: any) => t.value === profile.businessType)?.label, profile.city].filter(Boolean).join(' · ')}
            </span>
            {Boolean(profile.credentials?.filter((c: any) => c.name).length) && <span className="serp-credential">
              {profile.credentials.filter((c: any) => c.name).map((c: any) => c.name).join(' · ')}
            </span>}
          </div> : <p className="muted"><Building2 size={14} /> Add your business name to see this.</p>}
        </Card>
      </aside>
    </div>
  </>
}
