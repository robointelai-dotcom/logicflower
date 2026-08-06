import React from 'react'
import { Building2, LifeBuoy, Search, ShieldCheck, Users } from 'lucide-react'
import { getList, getOne, send } from '../api/client'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'
import { formatDate, formatNumber } from '../utils/format'

interface ManagedOrganization extends UnknownRecord {
  id: string
  name: string
  slug?: string
  status?: string
  timezone?: string
  createdAt?: string
  onboardingCompletedAt?: string
}
interface AdminData { overview: UnknownRecord; organizations: ManagedOrganization[] }

async function loadAdmin(): Promise<AdminData> {
  const [overview, organizations] = await Promise.allSettled([
    getOne<UnknownRecord>('/admin/overview'),
    getList<ManagedOrganization>('/admin/organizations', ['organizations']),
  ])
  if (overview.status === 'rejected' && organizations.status === 'rejected') throw overview.reason
  return {
    overview: overview.status === 'fulfilled' ? overview.value : {},
    organizations: organizations.status === 'fulfilled' ? organizations.value.items : [],
  }
}

export default function AdminPage() {
  const query = useApi(loadAdmin, [])
  const action = useAction()
  const [search, setSearch] = React.useState('')
  const [support, setSupport] = React.useState<ManagedOrganization | null>(null)
  const [reason, setReason] = React.useState('')
  const organizations = (query.data?.organizations ?? []).filter((item) => `${item.name} ${item.slug ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  const requestAccess = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!support) return
    const result = await action.run(() => send('post', `/admin/organizations/${support.id}/support-access`, { reason }), 'A time-limited owner-consent request was created. No data access was granted.')
    if (result !== undefined) { setSupport(null); setReason('') }
  }
  const value = (key: string) => formatNumber(Number(query.data?.overview[key] ?? 0))

  return <>
    <PageHeader eyebrow="Platform operations" title="Administration" description="Platform-wide workspace inventory and consent-gated support operations." />
    <Alert tone="warning"><strong>Privileged area.</strong> Platform administrators must use MFA. Every support request is audited and requires workspace-owner consent.</Alert>
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}{action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}
    {query.loading ? <SkeletonRows rows={5} columns={5} /> : query.error ? <Alert>{query.error}</Alert> : <>
      <div className="metric-grid admin-metrics">
        <AdminMetric icon={<Building2 />} label="Organizations" value={value('organizations')} />
        <AdminMetric icon={<Users />} label="Active users" value={value('users')} />
        <AdminMetric icon={<Users />} label="Memberships" value={value('memberships')} />
        <AdminMetric icon={<ShieldCheck />} label="Impersonation" value={query.data?.overview.supportImpersonationEnabled ? 'Enabled' : 'Disabled'} />
      </div>
      <Card title="Customer organizations" subtitle="Platform inventory only; customer data is not exposed here.">
        <div className="table-toolbar"><div className="search-input"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search organizations" aria-label="Search organizations" /></div></div>
        {organizations.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Organization</th><th>Status</th><th>Timezone</th><th>Onboarding</th><th>Created</th><th>Support</th></tr></thead><tbody>{organizations.map((organization) => <tr key={organization.id}><td><div className="entity-name"><span className="entity-icon"><Building2 size={17} /></span><div><strong>{organization.name}</strong><span>{organization.slug ?? organization.id}</span></div></div></td><td><StatusBadge status={organization.status ?? 'active'} /></td><td>{organization.timezone ?? 'UTC'}</td><td><StatusBadge status={organization.onboardingCompletedAt ? 'completed' : 'pending'} /></td><td>{formatDate(organization.createdAt)}</td><td><Button size="sm" variant="ghost" onClick={() => setSupport(organization)}><LifeBuoy size={14} />Request access</Button></td></tr>)}</tbody></table></div> : <EmptyState icon={<Building2 />} title="No organizations found" description="Try a different search term." />}
      </Card>
    </>}
    <Modal open={Boolean(support)} title="Request support access" description={`Create a customer-consent request for ${support?.name ?? 'this workspace'}.`} onClose={() => setSupport(null)} footer={<><Button onClick={() => setSupport(null)}>Cancel</Button><Button variant="primary" type="submit" form="support-form" busy={action.loading}>Create consent request</Button></>}>
      <form id="support-form" className="form-stack" onSubmit={requestAccess}><div className="consent-note"><ShieldCheck size={19} /><p>This does not grant impersonation or data access. The workspace owner must approve the audited, expiring request separately.</p></div><Field label="Support reason" hint="Do not include passwords, tokens or sensitive personal data." required><textarea rows={4} minLength={10} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} required autoFocus placeholder="Describe the specific issue being investigated…" /></Field></form>
    </Modal>
  </>
}

function AdminMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <Card className="metric-card"><div className="metric-top"><span>{icon}</span></div><strong>{value}</strong><h2>{label}</h2></Card>
}
