import React from 'react'
import {
  ArrowUpRight, CheckCircle2, Inbox, KanbanSquare, Megaphone, PhoneCall,
  Send, ShieldAlert, Sparkles, Timer, Users,
} from 'lucide-react'
import { getList, getOne } from '../api/client'
import { Link } from '../router'
import { useAuth } from '../auth/AuthContext'
import { Alert, Card, SkeletonRows } from '../components/ui'
import { useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'

/**
 * The daily console.
 *
 * Built for someone who is also doing the actual work — between jobs, between
 * clients, between calls. It answers two questions and deliberately refuses a
 * third:
 *
 *   1. What needs me?
 *   2. What ran on its own while I wasn't looking?
 *
 * It shows no vanity metrics. A small business owner does not need a chart of
 * message volume; they need to know four people replied and nobody has answered
 * them yet.
 *
 * The day strip is the signature, and it earns its place: it encodes this
 * product's actual promise — that it waits reliably and will not contact anyone
 * at 2am. Other consoles show what happened. This one also shows the hours in
 * which nothing will.
 */

interface SchedulerHealth {
  scheduledSteps: { pending: number; overdue: number; outcomeUnknown: number; failed: number }
  sends: { suppressed: number }
}

interface VoiceStatus {
  dialer: { enabled: boolean; dryRun: boolean }
  callingPolicy: {
    label: string
    window: { startMinute: number; endMinute: number; permittedWeekdays: number[] }
  }
}

interface Overview {
  health: SchedulerHealth | null
  unreadThreads: number
  overdueTasks: number
  openDeals: number
  contacts: number
  pendingReviews: number
  scheduledPosts: number
  voice: VoiceStatus | null
}

/** One failed panel should dim, not take the console down with it. */
async function soft<T>(loader: () => Promise<T>): Promise<T | null> {
  try { return await loader() } catch { return null }
}

async function loadConsole(): Promise<Overview> {
  const [health, threads, tasks, deals, contacts, reviews, posts, voice] = await Promise.all([
    soft(() => getOne<SchedulerHealth>('/sequences/operations/health')),
    soft(async () => (await getList<UnknownRecord>('/inbox/conversations?unread=true', ['conversations'])).items.length),
    soft(async () => (await getList<UnknownRecord>('/scheduling/tasks?overdue=true', ['tasks'])).items.length),
    soft(async () => (await getList<UnknownRecord>('/crm/deals?status=open', ['deals'])).items.length),
    soft(async () => (await getList<UnknownRecord>('/crm/contacts', ['contacts'])).items.length),
    soft(async () => (await getList<UnknownRecord>('/social/reviews?publishState=pending', ['reviews'])).items.length),
    soft(async () => (await getList<UnknownRecord>('/social/posts?status=scheduled', ['posts'])).items.length),
    soft(() => getOne<VoiceStatus>('/voice/status')),
  ])
  return {
    health,
    unreadThreads: threads ?? 0,
    overdueTasks: tasks ?? 0,
    openDeals: deals ?? 0,
    contacts: contacts ?? 0,
    pendingReviews: reviews ?? 0,
    scheduledPosts: posts ?? 0,
    voice,
  }
}

/* ------------------------------------------------------------- the day strip */

const STRIP_WIDTH = 960
const stripX = (minute: number) => (minute / 1440) * STRIP_WIDTH

function DayStrip({ startMinute, endMinute, label }: { startMinute: number; endMinute: number; label: string }) {
  const [nowMinute, setNowMinute] = React.useState(() => {
    const now = new Date()
    return now.getHours() * 60 + now.getMinutes()
  })

  React.useEffect(() => {
    // A minute is precise enough at day scale, and avoids waking the tab every
    // second for a marker that would not visibly move.
    const timer = window.setInterval(() => {
      const now = new Date()
      setNowMinute(now.getHours() * 60 + now.getMinutes())
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const open = nowMinute >= startMinute && nowMinute < endMinute
  const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

  return <figure className="daystrip">
    <figcaption>
      <span className="eyebrow">Working hours · {label}</span>
      <span className={open ? 'daystrip-state is-open' : 'daystrip-state is-quiet'}>
        <span className="daystrip-pip" aria-hidden="true" />
        {open ? 'Sending now' : 'Quiet — work is waiting'}
      </span>
    </figcaption>

    <svg viewBox={`0 0 ${STRIP_WIDTH} 74`} preserveAspectRatio="none" role="img"
      aria-label={`Working hours ${clock(startMinute)} to ${clock(endMinute)}. It is currently ${open ? 'inside' : 'outside'} the window.`}>
      <rect x={0} y={8} width={STRIP_WIDTH} height={40} rx={6} className="strip-quiet" />
      <rect x={stripX(startMinute)} y={8} width={stripX(endMinute) - stripX(startMinute)} height={40} rx={6} className="strip-open" />

      {[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => <g key={hour}>
        <line x1={stripX(hour * 60)} y1={8} x2={stripX(hour * 60)} y2={48} className="strip-rule" />
        <text x={stripX(hour * 60) + 7} y={66} className="strip-hour">{String(hour).padStart(2, '0')}</text>
      </g>)}

      <line x1={stripX(nowMinute)} y1={2} x2={stripX(nowMinute)} y2={54} className="strip-now" />
      <circle cx={stripX(nowMinute)} cy={2} r={4.5} className="strip-now-dot" />
    </svg>
  </figure>
}

function NeedsRow({ icon, label, count, to, stopped = false }: {
  icon: React.ReactNode; label: string; count: number; to: string; stopped?: boolean
}) {
  if (!count) return null
  return <Link to={to} className={stopped ? 'needs-row is-stopped' : 'needs-row'}>
    <span className="needs-icon">{icon}</span>
    <span className="needs-label">{label}</span>
    <span className="needs-count">{count}</span>
    <ArrowUpRight size={15} className="needs-go" />
  </Link>
}

export default function ConsolePage() {
  const { session } = useAuth()
  const query = useApi(loadConsole, [])

  if (query.loading) return <SkeletonRows rows={5} columns={3} />

  const data = query.data
  const health = data?.health
  const policy = data?.voice?.callingPolicy

  const needsYou = (data?.unreadThreads ?? 0)
    + (data?.overdueTasks ?? 0)
    + (health?.scheduledSteps.outcomeUnknown ?? 0)
    + (health?.scheduledSteps.failed ?? 0)
    + (data?.pendingReviews ?? 0)

  const firstName = String(session?.user?.name ?? '').split(/\s+/)[0]

  return <>
    <header className="console-head">
      <p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <h1>{firstName ? `Hello, ${firstName}` : 'Today'}</h1>
      <p className="console-sub">
        {needsYou === 0
          ? 'Nothing is waiting on you. Follow-up is running on its own.'
          : `${needsYou} ${needsYou === 1 ? 'thing needs' : 'things need'} a person.`}
      </p>
    </header>

    {query.error && <Alert>{query.error}</Alert>}

    <DayStrip
      startMinute={policy?.window.startMinute ?? 9 * 60}
      endMinute={policy?.window.endMinute ?? 19 * 60}
      label={policy?.label ?? 'Default hours'}
    />

    <div className="console-split">
      <Card className="needs-card">
        <header className="card-head">
          <span className="eyebrow">Needs you</span>
          {needsYou > 0 && <span className="head-count">{needsYou}</span>}
        </header>

        {needsYou === 0 ? <div className="all-clear">
          <CheckCircle2 size={28} />
          <p>All clear</p>
          <span className="muted">Replies, overdue tasks and anything the system could not finish will appear here.</span>
        </div> : <div className="needs-list">
          <NeedsRow icon={<Inbox size={16} />} label="Unread replies" count={data?.unreadThreads ?? 0} to="/inbox" />
          <NeedsRow icon={<Timer size={16} />} label="Overdue tasks" count={data?.overdueTasks ?? 0} to="/pipeline" />
          {/*
            Unknown outcomes sit apart from failures and are never merged with
            them. A failure can be retried; an unknown outcome means a message
            may already have reached someone, and it needs a decision.
          */}
          <NeedsRow icon={<ShieldAlert size={16} />} label="Sends with an unknown outcome" count={health?.scheduledSteps.outcomeUnknown ?? 0} to="/sequences" stopped />
          <NeedsRow icon={<ShieldAlert size={16} />} label="Failed sends" count={health?.scheduledSteps.failed ?? 0} to="/sequences" stopped />
          <NeedsRow icon={<Sparkles size={16} />} label="Reviews awaiting approval" count={data?.pendingReviews ?? 0} to="/social" />
        </div>}
      </Card>

      <Card className="running-card">
        <header className="card-head"><span className="eyebrow">Running on its own</span></header>
        <dl className="running-list">
          <div><dt><Send size={15} />Follow-up waiting</dt><dd>{health?.scheduledSteps.pending ?? 0}</dd></div>
          <div><dt><KanbanSquare size={15} />Open deals</dt><dd>{data?.openDeals ?? 0}</dd></div>
          <div><dt><Users size={15} />Contacts</dt><dd>{data?.contacts ?? 0}</dd></div>
          <div><dt><Megaphone size={15} />Posts queued</dt><dd>{data?.scheduledPosts ?? 0}</dd></div>
        </dl>
        {health && health.scheduledSteps.overdue > 0 && <p className="running-note">
          {health.scheduledSteps.overdue} step{health.scheduledSteps.overdue === 1 ? '' : 's'} past due — the scheduler may be stopped.
        </p>}
      </Card>
    </div>

    <nav className="console-tiles" aria-label="Sections">
      {[
        { to: '/inbox', label: 'Inbox', hint: 'Every reply, one thread per person', icon: <Inbox size={17} /> },
        { to: '/contacts', label: 'Contacts', hint: 'Everyone you can reach', icon: <Users size={17} /> },
        { to: '/pipeline', label: 'Pipeline', hint: 'Move work through its stages', icon: <KanbanSquare size={17} /> },
        { to: '/sequences', label: 'Sequences', hint: 'Follow-up that stops when they reply', icon: <Send size={17} /> },
        { to: '/social', label: 'Social', hint: 'Post once, then collect reviews', icon: <Megaphone size={17} /> },
        { to: '/voice', label: 'Calling', hint: 'Checked against every rule before it dials', icon: <PhoneCall size={17} /> },
      ].map((tile) => <Link key={tile.to} to={tile.to} className="console-tile">
        <span className="tile-icon">{tile.icon}</span>
        <strong>{tile.label}</strong>
        <span className="muted">{tile.hint}</span>
      </Link>)}
    </nav>
  </>
}
