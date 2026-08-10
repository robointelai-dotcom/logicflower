import React from 'react'
import { getOne } from '../api/client'
import {
  Activity, Archive, Bell, ChevronDown, ClipboardList, CreditCard, HeartPulse,
  Building2, CalendarClock, Contact2, Globe, Inbox, KanbanSquare, MessagesSquare, Store, TrendingUp, LayoutDashboard, Layers3, LogOut, Megaphone, Menu, PhoneCall, Plug,
  Send, Settings, ShieldCheck, Star, Sunrise, UserCog, Users,
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

/**
 * Role groups, mirroring the server-side guards.
 *
 * The navigation used to grant nearly every item to the same broad set, so a
 * viewer saw Sequences, Booking, Calling and Workflows and was stopped only
 * when they tried to act. The server was right and the door was wrong.
 *
 * Showing somebody a screen they cannot use is not a security hole — the API
 * refuses them — but it is a worse experience than not showing it, and it makes
 * the least-privilege claim untrue at one of the two layers.
 */
export const EVERYONE: OrganizationRole[] = ['owner', 'admin', 'operator', 'viewer', 'customer']
/** Can act on the workspace: create, edit, publish, send. */
export const OPERATORS: OrganizationRole[] = ['owner', 'admin', 'operator']
/** Can change how the workspace is configured or connected. */
export const MANAGERS: OrganizationRole[] = ['owner', 'admin']

const sections: Array<{ label: string; items: NavItem[] }> = [
  {
    /*
     * Deliberately not called "SEO".
     *
     * A plumber does not want SEO; he wants to be found. It also keeps the
     * promise honest — there is no rank tracking in here, and "SEO" would
     * imply it.
     *
     * "My website" carries the possessive because there is already a
     * corporate-only /website for the marketing site. An agency admin working
     * across both in one afternoon would otherwise conflate them.
     */
    label: 'Getting found',
    items: [
      /*
       * "Where work comes from" pointed at the same attribution report that
       * Results now leads with, so the two were one screen under two names in
       * two sections. Results is the one that survives, because plan usage
       * belongs beside it and this section is about being found rather than
       * about what the work was worth. The route stays live; only the
       * duplicate entry is gone.
       */
      { label: 'My business', to: '/seo/profile', icon: Store, roles: [...OPERATORS] },
      { label: 'Questions', to: '/seo/questions', icon: MessagesSquare, roles: [...OPERATORS] },
      { label: 'My website', to: '/seo/website', icon: Globe, roles: [...OPERATORS] },
    ],
  },
  { label: 'Engage', items: [
    { label: 'Today', to: '/dashboard', icon: Sunrise, roles: [...EVERYONE] },
    { label: 'Inbox', to: '/inbox', icon: Inbox, roles: [...EVERYONE] },
    { label: 'Contacts', to: '/contacts', icon: Contact2, roles: [...EVERYONE] },
    { label: 'Pipeline', to: '/pipeline', icon: KanbanSquare, roles: [...EVERYONE] },
    { label: 'Booking', to: '/booking', icon: CalendarClock, roles: [...OPERATORS] },
    { label: 'Sequences', to: '/sequences', icon: Send, roles: [...OPERATORS] },
    { label: 'Social', to: '/social', icon: Megaphone, roles: [...OPERATORS] },
    /*
     * Reviews is a separate destination from Social because the two have
     * opposite availability. Review collection works today; social publishing
     * cannot work until Meta, LinkedIn, TikTok and Pinterest grant app review,
     * which is months away and not in our gift. Leaving the half that works at
     * the bottom of a screen whose top half says nothing works loses it.
     */
    { label: 'Reviews', to: '/reviews', icon: Star, roles: [...OPERATORS] },
    { label: 'Auto Post', to: '/trypost', icon: Megaphone, roles: [...OPERATORS] },
    { label: 'Calling', to: '/voice', icon: PhoneCall, roles: [...OPERATORS] },
  ] },
  { label: 'Operate', items: [
    { label: 'Platform overview', to: '/platform', icon: LayoutDashboard, roles: [...OPERATORS] },
    { label: 'Connections', to: '/connections', icon: Plug, roles: [...MANAGERS] },
    { label: 'Workflows', to: '/workflows', icon: WorkflowIcon, roles: [...OPERATORS] },
    { label: 'Executions', to: '/executions', icon: Activity, roles: [...OPERATORS] },
    { label: 'Batch jobs', to: '/batches', icon: Layers3, roles: [...OPERATORS] },
  ] },
  { label: 'Protect', items: [
    { label: 'Monitoring', to: '/monitoring', icon: HeartPulse, roles: [...OPERATORS] },
    { label: 'Vault', to: '/vault', icon: Archive, roles: [...MANAGERS] },
    { label: 'Alerts', to: '/notifications', icon: Bell, roles: [...OPERATORS] },
    { label: 'Audit log', to: '/audit', icon: ClipboardList, roles: [...EVERYONE] },
  ] },
  { label: 'Manage', items: [
    { label: 'Results', to: '/reports', icon: TrendingUp, roles: ['owner', 'admin', 'operator', 'viewer', 'billing'] },
    { label: 'Team', to: '/team', icon: Users, roles: ['owner', 'admin'] },
    { label: 'Billing', to: '/billing', icon: CreditCard, roles: ['owner', 'billing'] },
    // Any member can see who from outside can read their data, not admins only.
    { label: 'Who has access', to: '/access-ledger', icon: ShieldCheck },
    { label: 'Settings', to: '/settings', icon: Settings },
  ] },
]

/**
 * Where each role lands after sign-in or a workspace switch.
 *
 * A billing user is refused most of this product, and correctly so — a
 * bookkeeper has no business reading customer conversations. But the role was
 * defined entirely by refusals: they were bounced from screen to screen until
 * they happened to find one that opened. Billing is the screen the role exists
 * for, so it is where they start.
 */
function homeRouteForRole(role?: string): string {
  if (role === 'billing') return '/billing'
  if (role === 'agency_owner') return '/clients'
  return '/dashboard'
}

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
   *
   * The Operate section — Platform overview, Workflows, Executions, Batch jobs,
   * and Monitoring alongside it — belongs to the previous product. Shown to a
   * client it produced two home screens with two disagreeing setup checklists,
   * and a vocabulary (published workflows, batch jobs, open incidents) that no
   * local business uses. It is kept for agency and corporate, where a technical
   * operator recognises the language, and hidden from a client.
   *
   * Connections is the one exception, because the email and text setup lives
   * there and nothing can be sent without it. For a client it moves into Manage
   * under the name that says what it is for.
   */
  const visibleSections = React.useMemo(() => {
    const isClient = Boolean(tier) && tier?.tier !== 'agency' && !tier?.corporate
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
    if (!isClient) return [...extra, ...sections]

    const clientSections = sections
      .filter((section) => section.label !== 'Operate')
      .map((section) => {
        if (section.label === 'Protect') {
          return { ...section, items: section.items.filter((item) => item.to !== '/monitoring') }
        }
        if (section.label === 'Manage') {
          const connections: NavItem = { label: 'How you send', to: '/connections', icon: Plug, roles: [...MANAGERS] }
          const index = section.items.findIndex((item) => item.to === '/team')
          const items = [...section.items]
          items.splice(index < 0 ? items.length : index, 0, connections)
          return { ...section, items }
        }
        return section
      })
    return [...extra, ...clientSections]
  }, [tier])
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [profileOpen, setProfileOpen] = React.useState(false)
  const [switching, setSwitching] = React.useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const role = session?.organization?.role ?? 'viewer'
  const canViewOperations = ['owner', 'admin', 'operator', 'viewer', 'customer'].includes(role)

  React.useEffect(() => { setMobileOpen(false) }, [location.pathname])

  const changeOrganization = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = session?.organizations.find((organization) => organization.id === event.target.value)
    setSwitching(true)
    try { await switchOrganization(event.target.value); navigate(homeRouteForRole(selected?.role)) } finally { setSwitching(false) }
  }

  const sidebar = (
    <>
      <div className="sidebar-brand"><AppLogo /><button className="icon-button mobile-only" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={20} /></button></div>
      <div className="workspace-switcher">
        <label htmlFor="workspace-select">Workspace</label>
        <div><select id="workspace-select" value={session?.organization?.id ?? ''} onChange={(event) => { void changeOrganization(event) }} disabled={switching || (session?.organizations.length ?? 0) < 2}>
          {(session?.organizations ?? []).map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
        </select><ChevronDown size={15} aria-hidden="true" /></div>
        {/*
          The tier is named, not inferred. Somebody who works across a corporate
          account, an agency and a client workspace in one afternoon needs to
          know which one they are acting in — and an agency admin sitting inside
          a client's workspace most of all, because everything they do there is
          recorded against their name and visible to that client.
        */}
        <span>
          {tier?.corporate ? 'Corporate' : tier?.tier === 'agency' ? 'Agency' : null}
          {tier?.corporate || tier?.tier === 'agency' ? ' · ' : ''}
          {role} · {session?.organization?.plan ?? 'Free plan'}
        </span>
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
      {canViewOperations && <div className="sidebar-help"><strong>Setup & support</strong><span>Complete the checklist or open the help center.</span><NavLink to="/onboarding">Continue setup</NavLink><NavLink to="/help">Help center</NavLink></div>}
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
