import React from 'react'
import { Clock3, MailPlus, Plus, ShieldCheck, Trash2, UserRoundPlus, Users } from 'lucide-react'
import { getList, send } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, Button, Card, ConfirmDialog, EmptyState, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { OrganizationRole, UnknownRecord } from '../types'
import { formatDate, titleCase } from '../utils/format'
import { roleLabel } from '../hooks/usePermissions'

interface Member extends UnknownRecord { id: string; name?: string; email: string; role: OrganizationRole; status?: string; joinedAt?: string; lastActiveAt?: string }
interface Invitation extends UnknownRecord { id: string; email: string; role: OrganizationRole; status?: string; expiresAt?: string; createdAt?: string }
interface TeamData { members: Member[]; invitations: Invitation[] }

async function loadTeam(): Promise<TeamData> {
  const [members, invitations] = await Promise.all([
    getList<Member>('/organizations/current/members', ['members']),
    getList<Invitation>('/organizations/current/invitations', ['invitations']),
  ])
  return { members: members.items.map((member) => {
    const user = member.user && typeof member.user === 'object' && !Array.isArray(member.user) ? member.user as UnknownRecord : {}
    return { ...member, name: String(member.name ?? user.displayName ?? user.name ?? ''), email: String(member.email ?? user.email ?? ''), status: String(member.status ?? user.status ?? 'active'), lastActiveAt: String(member.lastActiveAt ?? user.lastLoginAt ?? ''), role: member.role }
  }), invitations: invitations.items.filter((invitation) => !invitation.acceptedAt && !invitation.revokedAt && (!invitation.expiresAt || new Date(invitation.expiresAt).getTime() > Date.now())) }
}

const roles: OrganizationRole[] = ['owner', 'admin', 'operator', 'viewer', 'billing', 'customer']

export default function TeamPage() {
  const { session } = useAuth()
  const query = useApi(loadTeam, [session?.organization?.id])
  const action = useAction()
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [invite, setInvite] = React.useState({ email: '', role: 'operator' as OrganizationRole })
  const [remove, setRemove] = React.useState<Member | null>(null)
  const canManageOwners = session?.organization?.role === 'owner'

  const submitInvite = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = await action.run(() => send('post', '/organizations/current/invitations', invite), 'Invitation sent.')
    if (result !== undefined) { setInviteOpen(false); setInvite({ email: '', role: 'operator' }); await query.reload() }
  }
  const updateRole = async (member: Member, role: OrganizationRole) => {
    await action.run(() => send('patch', `/organizations/current/members/${encodeURIComponent(member.id)}`, { role }), `${member.name ?? member.email} is now ${roleLabel(role)}.`)
    await query.reload()
  }
  const removeMember = async () => {
    if (!remove) return
    const result = await action.run(async () => { await send('delete', `/organizations/current/members/${encodeURIComponent(remove.id)}`); return true }, 'Member removed.')
    if (result) { setRemove(null); await query.reload() }
  }
  const revokeInvite = async (id: string) => { const result = await action.run(async () => { await send('delete', `/organizations/current/invitations/${encodeURIComponent(id)}`); return true }, 'Invitation revoked.'); if (result) await query.reload() }
  const resendInvite = async (id: string) => { await action.run(() => send('post', `/organizations/current/invitations/${encodeURIComponent(id)}/resend`), 'Invitation sent again.') }

  return <>
    <PageHeader eyebrow="Workspace access" title="Team & roles" description="Control who can access this workspace and exactly what they can do." actions={<Button variant="primary" onClick={() => setInviteOpen(true)}><UserRoundPlus size={16} />Invite member</Button>} />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}{action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}
    <Card title="Members" subtitle={`${query.data?.members.length ?? 0} people in ${session?.organization?.name ?? 'this workspace'}`}>
      {query.loading ? <SkeletonRows rows={4} columns={4} /> : query.error ? <Alert>{query.error}</Alert> : query.data?.members.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Last active</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{query.data.members.map((member) => <tr key={member.id}><td><div className="person-cell"><span className="avatar avatar-small">{(member.name ?? member.email).slice(0, 2).toUpperCase()}</span><div><strong>{member.name ?? 'Invited member'}</strong><span>{member.email}</span></div></div></td><td>{member.role === 'owner' && !canManageOwners ? <span className="owner-role"><ShieldCheck size={15} />Owner</span> : <select className="table-select" value={member.role} aria-label={`Role for ${member.email}`} onChange={(event) => { void updateRole(member, event.target.value as OrganizationRole) }} disabled={action.loading}>{roles.filter((role) => role !== 'owner' || canManageOwners).map((role) => <option value={role} key={role}>{roleLabel(role)}</option>)}</select>}</td><td><StatusBadge status={member.status ?? 'active'} /></td><td>{formatDate(member.lastActiveAt ?? member.joinedAt)}</td><td className="action-cell">{(member.role !== 'owner' || canManageOwners) && <button className="icon-button danger-hover" onClick={() => setRemove(member)} aria-label={`Remove ${member.email}`}><Trash2 size={16} /></button>}</td></tr>)}</tbody></table></div> : <EmptyState icon={<Users />} title="No team members yet" description="Invite collaborators and assign least-privilege roles." action={<Button onClick={() => setInviteOpen(true)}><Plus size={16} />Invite member</Button>} />}
    </Card>
    <Card title="Pending invitations" subtitle="Invitations expire automatically for safety.">
      {query.loading ? <SkeletonRows rows={2} columns={4} /> : query.data?.invitations.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Email</th><th>Role</th><th>Sent</th><th>Expires</th><th>Actions</th></tr></thead><tbody>{query.data.invitations.map((item) => <tr key={item.id}><td><span className="with-icon"><MailPlus size={16} />{item.email}</span></td><td>{titleCase(item.role)}</td><td>{formatDate(item.createdAt)}</td><td><span className="with-icon muted"><Clock3 size={15} />{formatDate(item.expiresAt)}</span></td><td><div className="inline-actions"><Button size="sm" variant="ghost" onClick={() => { void resendInvite(item.id) }}>Resend</Button><Button size="sm" variant="ghost" onClick={() => { void revokeInvite(item.id) }}>Revoke</Button></div></td></tr>)}</tbody></table></div> : <EmptyState title="No pending invitations" description="New invitations will appear here until accepted." />}
    </Card>
    <Modal open={inviteOpen} title="Invite a team member" description="They will receive an email with a secure, expiring link." onClose={() => setInviteOpen(false)} footer={<><Button onClick={() => setInviteOpen(false)}>Cancel</Button><Button type="submit" form="invite-form" variant="primary" busy={action.loading}>Send invitation</Button></>}><form id="invite-form" className="form-stack" onSubmit={submitInvite}><Field label="Work email" required><input type="email" autoComplete="email" value={invite.email} onChange={(event) => setInvite((current) => ({ ...current, email: event.target.value }))} required autoFocus /></Field><Field label="Role" hint="Operators can create and change records. Viewer, Billing and Guest are read-only." required><select value={invite.role} onChange={(event) => setInvite((current) => ({ ...current, role: event.target.value as OrganizationRole }))}>{roles.filter((role) => role !== 'owner' || canManageOwners).map((role) => <option value={role} key={role}>{roleLabel(role)}</option>)}</select></Field></form></Modal>
    <ConfirmDialog open={Boolean(remove)} title="Remove team member?" description={`${remove?.name ?? remove?.email ?? 'This person'} will immediately lose access to this workspace. Their historical audit events will remain.`} confirmLabel="Remove member" danger busy={action.loading} onClose={() => setRemove(null)} onConfirm={() => { void removeMember() }} />
  </>
}
