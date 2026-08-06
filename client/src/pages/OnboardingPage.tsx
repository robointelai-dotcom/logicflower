import React from 'react'
import { Bell, Check, CheckCircle2, DatabaseZap, Plug, Rocket, ShieldCheck, Users, Workflow } from 'lucide-react'
import { Link, useNavigate } from '../router'
import { getList, getOne, send } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, AppLogo, Button, Card, PageHeader, Progress } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { UnknownRecord } from '../types'

interface SetupStep { key: string; title: string; description: string; complete: boolean; required: boolean; to: string; icon: React.ReactNode }

async function loadSetup(): Promise<UnknownRecord> {
  const [onboarding, organization, connections, members, workflows, channels] = await Promise.allSettled([
    getOne<UnknownRecord>('/organizations/onboarding'),
    getOne<UnknownRecord>('/organizations/current'),
    getList<UnknownRecord>('/connections', ['connections']),
    getList<UnknownRecord>('/organizations/current/members', ['members']),
    getList<UnknownRecord>('/workflows', ['workflows']),
    getList<UnknownRecord>('/notifications/channels', ['channels']),
  ])
  const remote = onboarding.status === 'fulfilled' ? onboarding.value : {}
  const allComplete = remote.completed === true
  return {
    ...remote,
    workspaceComplete: allComplete || Boolean((remote.steps as UnknownRecord | undefined)?.workspace) || organization.status === 'fulfilled',
    connectionComplete: allComplete || Boolean((remote.steps as UnknownRecord | undefined)?.connection) || (connections.status === 'fulfilled' && connections.value.items.length > 0),
    scanComplete: allComplete || Boolean((remote.steps as UnknownRecord | undefined)?.scan),
    teamComplete: allComplete || Boolean((remote.steps as UnknownRecord | undefined)?.team) || (members.status === 'fulfilled' && members.value.items.length > 1),
    workflowComplete: allComplete || Boolean((remote.steps as UnknownRecord | undefined)?.workflow) || (workflows.status === 'fulfilled' && workflows.value.items.length > 0),
    alertsComplete: allComplete || Boolean((remote.steps as UnknownRecord | undefined)?.alerts) || (channels.status === 'fulfilled' && channels.value.items.length > 0),
  }
}

export default function OnboardingPage() {
  const { session } = useAuth()
  const navigate = useNavigate()
  const query = useApi(loadSetup, [])
  const action = useAction()
  const remote = query.data ?? {}
  const completed = new Set(Array.isArray(remote.completed) ? remote.completed.map(String) : [])
  const steps: SetupStep[] = [
    { key: 'workspace', title: 'Workspace basics', description: 'Confirm name, timezone and retention policy.', complete: completed.has('workspace') || Boolean(remote.workspaceComplete), required: true, to: '/settings', icon: <ShieldCheck /> },
    { key: 'connection', title: 'Connect a platform', description: 'Authorize HighLevel, HubSpot, Klaviyo or another approved source.', complete: completed.has('connection') || Boolean(remote.connectionComplete), required: true, to: '/connections', icon: <Plug /> },
    { key: 'scan', title: 'Review the automatic data scan', description: 'LogicFlower safely samples the connected CRM and identifies duplicate contacts without writing data.', complete: completed.has('scan') || Boolean(remote.scanComplete), required: true, to: '/connections', icon: <DatabaseZap /> },
    { key: 'team', title: 'Invite your team', description: 'Optional: assign least-privilege roles for operators and reviewers.', complete: completed.has('team') || Boolean(remote.teamComplete), required: false, to: '/team', icon: <Users /> },
    { key: 'workflow', title: 'Build a safe workflow', description: 'Create a structured workflow and complete a no-write impact preview.', complete: completed.has('workflow') || Boolean(remote.workflowComplete), required: true, to: '/workflows', icon: <Workflow /> },
    { key: 'alerts', title: 'Configure alerts', description: 'Choose how critical incidents reach your team.', complete: completed.has('alerts') || Boolean(remote.alertsComplete), required: true, to: '/notifications', icon: <Bell /> },
  ]
  const requiredSteps = steps.filter((step) => step.required)
  const count = requiredSteps.filter((step) => step.complete).length
  const progress = Math.round((count / requiredSteps.length) * 100)
  const canComplete = ['owner', 'admin'].includes(session?.organization?.role ?? '')
  const finish = async () => { const result = await action.run(() => send('post', '/organizations/onboarding/complete'), 'Workspace setup complete.'); if (result !== undefined) navigate('/dashboard') }
  const scan = remote.scan && typeof remote.scan === 'object' ? remote.scan as UnknownRecord : null
  return <div className="onboarding-page"><div className="onboarding-brand"><AppLogo /></div><PageHeader eyebrow="Guided setup" title={progress === 100 ? 'Your workspace is ready' : 'Set up LogicFlower'} description="Review these checks before running production operations." /><Card className="onboarding-progress"><div><strong>{count} of {requiredSteps.length} required checks complete</strong><span>{progress === 100 ? 'Ready for controlled production use' : 'Progress is derived from live workspace resources'}</span></div><Progress value={progress} /></Card>{query.error && <Alert tone="warning">Live setup status could not be loaded. You can still open each step.</Alert>}{action.error && <Alert>{action.error}</Alert>}{scan?.status === 'completed' && <Alert tone="success"><strong>First value report:</strong> scanned {Number(scan.scannedCount ?? 0).toLocaleString()} contacts and found {Number(scan.duplicateRecords ?? 0).toLocaleString()} records in {Number(scan.duplicateGroups ?? 0).toLocaleString()} potential duplicate groups. This was read-only{scan.truncated ? ' and limited to the first 5,000 contacts' : ''}.</Alert>}{scan && ['queued', 'running'].includes(String(scan.status)) && <Alert tone="warning">Your automatic read-only contact scan is {String(scan.status)}. Refresh this page after the worker finishes.</Alert>}<div className="setup-steps">{steps.map((step, index) => <Link key={step.key} to={step.to} className={step.complete ? 'complete' : ''}><span className="step-number">{step.complete ? <Check /> : index + 1}</span><span className="step-icon">{step.icon}</span><div><strong>{step.title}{!step.required ? ' (optional)' : ''}</strong><p>{step.description}</p></div><span className="step-state">{step.complete ? <><CheckCircle2 size={16} />Complete</> : 'Open step'}</span></Link>)}</div><div className="onboarding-actions"><Link className="button button-secondary" to="/dashboard">Return to overview</Link><Button onClick={() => { void query.reload() }}>Refresh checks</Button>{canComplete && <Button variant="primary" busy={action.loading} disabled={progress !== 100} onClick={() => { void finish() }}><Rocket size={16} />Finish setup</Button>}</div></div>
}
