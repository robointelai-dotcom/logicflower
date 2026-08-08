import React from 'react'
import { getOne } from '../api/client'
import {
  Activity, Archive, BarChart3, Bell, ChevronDown, ClipboardList, CreditCard, HeartPulse,
  Building2, CalendarClock, Contact2, Globe, Inbox, KanbanSquare, LayoutDashboard, Layers3, LogOut, Megaphone, Menu, PhoneCall, Plug,
  Send, Settings, ShieldCheck, Sunrise, UserCog, Users,
  Workflow as WorkflowIcon, X,
  type LucideIcon,
} from 'lucide-react'
import { NavLink, Outlet, useLocation, useNavigate } from '../router'
import { useAuth } from '../auth/AuthContext'
import type { OrganizationRole } from '../types'
import { AppLogo, Button } from './ui'

interface NavItem {
  label: string
  to: string
  icon: LucideIcon
  roles?: OrganizationRole[]
}

const sections: Array<{ label: string; items: NavItem[] }> = [
  { label: 'Engage', items: [
    { label: 'Today', to: '/dashboard', icon: Sunrise, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Inbox', to: '/inbox', icon: Inbox, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Contacts', to: '/contacts', icon: Contact2, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Pipeline', to: '/pipeline', icon: KanbanSquare, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Booking', to: '/booking', icon: CalendarClock, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Sequences', to: '/sequences', icon: Send, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Social', to: '/social', icon: Megaphone, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Auto Post', to: '/trypost', icon: Megaphone, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Calling', to: '/voice', icon: PhoneCall, roles: ['owner', 'admin', 'operator'] },
  ] },
  { label: 'Operate', items: [
    { label: 'Platform overview', to: '/platform', icon: LayoutDashboard, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Connections', to: '/connections', icon: Plug, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Workflows', to: '/workflows', icon: WorkflowIcon, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Executions', to: '/executions', icon: Activity, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Batch jobs', to: '/batches', icon: Layers3, roles: ['owner', 'admin', 'operator', 'viewer'] },
  ] },
  { label: 'Protect', items: [
    { label: 'Monitoring', to: '/monitoring', icon: HeartPulse, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Vault', to: '/vault', icon: Archive, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Alerts', to: '/notifications', icon: Bell, roles: ['owner', 'admin', 'operator', 'viewer'] },
    { label: 'Audit log', to: '/audit', icon: ClipboardList, roles: ['owner', 'admin', 'operator', 'viewer'] },
  ] },
  { label: 'Manage', items: [
    { label: 'Reports & usage', to: '/reports', icon: BarChart3, roles: ['owner', 'admin', 'operator', 'viewer', 'billing'] },
    { label: 'Team', to: '/team', icon: Users, roles: ['owner', 'admin'] },
    { label: 'Billing', to: '/billing', icon: CreditCard, roles: ['owner', 'billing'] },
    // Any member can see who from outside can read their data, not admins only.
    { label: 'Who has access', to: '/access-ledger', icon: ShieldCheck },
    { label: 'Settings', to: '/settings', icon: Settings },
  ] },
]

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'LF'
}

/**
 * Which tier is signed in.
 *
 * A client must see no evidence that an agency sits above them: a business
 * owner logging in should see their business, not their position in somebody
 * else's portfolio. So this returns `client` for them and the extra sections
 * simply are not rendered.
 */
function useTier() {
  const [tier, setTier] = React.useState<{ tier: string; corporate: boolean } | null>(null)
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const context = await getOne<{ tier: string; corporate: boolean }>('/hierarchy/context')
        if (!cancelled) setTier(context)
      } catch {
        // A failure here must not blank the navigation; a client view is the
        // safe default because it shows the least.
        if (!cancelled) setTier({ tier: 'client', corporate: false })
      }
    })()
    return () => { cancelled = true }
  }, [])
  return tier
}

export default function Shell() {
  const { session, logout, switchOrganization } = useAuth()
  const tier = useTier()

  /**
   * Sections the signed-in tier should see.
   *
   * Built rather than filtered, so a client's navigation contains no hidden
   * items that a stray CSS change could reveal.
   */
  const visibleSections = React.useMemo(() => {
    const extra: Array<{ label: string; items: NavItem[] }> = []
    if (tier?.corporate) {
      extra.push({ label: 'Corporate', items: [
        { label: 'Estate', to: '/estate', icon: Building2 },
        { label: 'Website', to: '/website', icon: Globe },
      ] })
    }
    if (tier?.tier === 'agency') {
      extra.push({ label: 'Agency', items: [
        { label: 'Clients', to: '/clients', icon: Building2 },
      ] })
    }
    return [...extra, ...sections]
  }, [tier])
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [profileOpen, setProfileOpen] = React.useState(false)
  const [switching, setSwitching] = React.useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const role = session?.organization?.role ?? 'viewer'
  const canViewOperations = ['owner', 'admin', 'operator', 'viewer'].includes(role)

  React.useEffect(() => { setMobileOpen(false) }, [location.pathname])

  const changeOrganization = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = session?.organizations.find((organization) => organization.id === event.target.value)
    setSwitching(true)
    try { await switchOrganization(event.target.value); navigate(selected?.role === 'billing' ? '/reports' : '/dashboard') } finally { setSwitching(false) }
  }

  const sidebar = (
    <>
      <div className="sidebar-brand"><AppLogo /><button className="icon-button mobile-only" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={20} /></button></div>
      <div className="workspace-switcher">
        <label htmlFor="workspace-select">Workspace</label>
        <div><select id="workspace-select" value={session?.organization?.id ?? ''} onChange={(event) => { void changeOrganization(event) }} disabled={switching || (session?.organizations.length ?? 0) < 2}>
          {(session?.organizations ?? []).map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
        </select><ChevronDown size={15} aria-hidden="true" /></div>
        <span>{role} · {session?.organization?.plan ?? 'Free plan'}</span>
      </div>
      <nav className="sidebar-nav" aria-label="Primary navigation">
        {visibleSections.map((section) => {
          const visible = section.items.filter((item) => !item.roles || item.roles.includes(role))
          if (!visible.length) return null
          return <div className="nav-section" key={section.label}><p>{section.label}</p>{visible.map((item) => <NavLink key={item.to} to={item.to} end={item.to === '/dashboard'} className={({ isActive }) => isActive ? 'active' : ''}><item.icon size={18} aria-hidden="true" /><span>{item.label}</span></NavLink>)}</div>
        })}
      </nav>
      {(['owner', 'admin'].includes(session?.user.platformRole ?? 'user') && session?.user.mfaEnabled) && (
        <div className="sidebar-admin"><NavLink to="/admin"><ShieldCheck size={18} /><span>Admin portal</span></NavLink></div>
      )}
      {canViewOperations && <div className="sidebar-help"><strong>Setup & support</strong><span>Complete the checklist or open the help centre.</span><NavLink to="/onboarding">Continue setup</NavLink><NavLink to="/help">Help centre</NavLink></div>}
    </>
  )

  return (
    <div className="app-shell">
      <aside className="sidebar desktop-sidebar">{sidebar}</aside>
      {mobileOpen && <div className="mobile-nav-backdrop" onMouseDown={() => setMobileOpen(false)}><aside className="sidebar mobile-sidebar" onMouseDown={(event) => event.stopPropagation()}>{sidebar}</aside></div>}
      <div className="app-main">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={21} /></button>
          <div className="topbar-title"><span className="topbar-workspace">{session?.organization?.name}</span><NavLink to="/status"><span className="connection-dot" />Service status</NavLink></div>
          <div className="topbar-actions">
            {canViewOperations && <NavLink className="icon-button" to="/notifications" aria-label="Notifications"><Bell size={19} /><span className="notification-dot" /></NavLink>}
            <div className="profile-menu">
              <button className="profile-button" onClick={() => setProfileOpen((open) => !open)} aria-expanded={profileOpen} aria-haspopup="menu">
                <span className="avatar">{initials(session?.user.name ?? '')}</span><span className="profile-copy"><strong>{session?.user.name}</strong><small>{role}</small></span><ChevronDown size={15} />
              </button>
              {profileOpen && <div className="profile-popover" role="menu"><div><strong>{session?.user.name}</strong><span>{session?.user.email}</span></div><NavLink to="/settings" role="menuitem" onClick={() => setProfileOpen(false)}><UserCog size={16} />Profile & security</NavLink><Button variant="ghost" size="sm" onClick={() => { void logout().then(() => navigate('/login')) }}><LogOut size={16} />Log out</Button></div>}
            </div>
          </div>
        </header>
        <main className="page" key={session?.organization?.id ?? 'no-organization'}><Outlet /></main>
      </div>
    </div>
  )
}
