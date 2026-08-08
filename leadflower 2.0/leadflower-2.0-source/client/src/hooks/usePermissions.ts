import { useAuth } from '../auth/AuthContext'

/**
 * What the signed-in user may actually do, in one place.
 *
 * Several pages computed `['owner','admin','operator'].includes(role)` inline;
 * many more computed nothing at all and rendered "New contact", "Publish",
 * "Reply" and "Archive" to every role. The backend refused those writes
 * correctly, so nothing was ever wrongly saved — but a read-only user could
 * fill in a form, submit it, and receive a bare 403. Being shown a door that is
 * locked is worse than not being shown the door: the user cannot tell whether
 * they lack permission or the product is broken.
 *
 * These predicates mirror `server/src/middleware/rbac.ts`. They are a UI
 * convenience and NOT a security control — the server remains the only
 * authority, and every one of these actions is independently gated there.
 */

export type WorkspaceRole =
  | 'agency_owner' | 'owner' | 'admin' | 'operator' | 'viewer' | 'billing' | 'customer'

/**
 * Roles that may only look.
 *
 * `customer` sits here despite its name. It is not the role a paying customer
 * gets — ordinary registration creates an `owner` — and it grants read access
 * and nothing else. It is a guest role wearing a misleading label; see
 * `roleLabel` below.
 */
export const READ_ONLY_ROLES: readonly WorkspaceRole[] = ['viewer', 'billing', 'customer']

export interface Permissions {
  role: WorkspaceRole | null
  /** Create and change operational records: contacts, deals, sequences, posts. */
  canOperate: boolean
  /** Manage the workspace: team, connections, alerts, settings. */
  canManage: boolean
  /** Owner-only: billing, closing the workspace, changing another owner. */
  isOwner: boolean
  /** Billing and invoices. */
  canBill: boolean
  /** True when the user may only read, so a page can say so once and clearly. */
  isReadOnly: boolean
}

export function usePermissions(): Permissions {
  const { session } = useAuth()
  const role = (session?.organization?.role ?? null) as WorkspaceRole | null
  const canOperate = role !== null && ['owner', 'admin', 'operator'].includes(role)
  const canManage = role !== null && ['owner', 'admin'].includes(role)
  return {
    role,
    canOperate,
    canManage,
    isOwner: role === 'owner',
    canBill: role !== null && ['owner', 'billing'].includes(role),
    isReadOnly: role !== null && READ_ONLY_ROLES.includes(role),
  }
}

/**
 * How a role should be NAMED to a user.
 *
 * `customer` is displayed as "Guest (read-only)" because that is what it does.
 * Calling it Customer in the team picker invites an administrator to assign it
 * to their actual paying customer, who then finds they cannot edit a contact in
 * their own workspace. Renaming the stored value is a migration; renaming what
 * people READ costs nothing and removes the trap today.
 */
export function roleLabel(role: string): string {
  switch (role) {
    case 'agency_owner': return 'Agency owner'
    case 'owner': return 'Owner'
    case 'admin': return 'Admin'
    case 'operator': return 'Operator'
    case 'viewer': return 'Viewer (read-only)'
    case 'billing': return 'Billing'
    case 'customer': return 'Guest (read-only)'
    default: return role
  }
}

/** One sentence explaining why the controls are absent, for a read-only user. */
export function readOnlyNotice(role: string): string {
  if (role === 'billing') return 'Your Billing role can view this workspace and manage payment details, but cannot change records.'
  return 'Your role has read-only access to this workspace. Ask an owner or admin if you need to make changes.'
}
