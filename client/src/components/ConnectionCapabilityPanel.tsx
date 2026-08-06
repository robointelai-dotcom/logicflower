import React from 'react'
import { AlertTriangle, CheckCircle2, HelpCircle, Play, ShieldAlert, XCircle } from 'lucide-react'
import { getOne, send } from '../api/client'
import { Alert, Button, Card } from './ui'

/**
 * Connection capability panel.
 *
 * The point of this component is that `unverified` is rendered as its own
 * visible state, distinct from both `available` and `unavailable`. Previously
 * an unconfirmed entitlement produced an empty workflow list, which is
 * indistinguishable in the UI from an account that genuinely has no workflows —
 * and that ambiguity is how a monitoring feature reported success while
 * observing nothing.
 */

type CapabilityState = 'available' | 'unavailable' | 'unverified'

interface CapabilityResolution {
  capability: string
  state: CapabilityState
  reason: string
  remediation?: string
  evidence: {
    scopeSource: string
    requiredScope?: string
    scopeGranted: boolean
    probedAt?: string
    probeStatusCode?: number
  }
}

interface CapabilityMatrix {
  connectionId: string
  provider: string
  scopeSource: string
  scopeObservedAt?: string
  probeable: string[]
  capabilities: CapabilityResolution[]
}

const LABELS: Record<string, string> = {
  'workflow.inventory': 'Read workflow inventory',
  'workflow.snapshot': 'Capture workflow snapshots',
  'contact.read': 'Read contacts',
  'contact.write': 'Write contacts',
  'contact.merge': 'Merge duplicate contacts',
  'contact.delete': 'Delete duplicate contacts',
}

const SCOPE_SOURCE_LABELS: Record<string, string> = {
  provider_token_response: 'Confirmed by the provider during authorisation',
  live_probe: 'Confirmed by a live probe',
  operator_claimed: 'Entered manually — not provider evidence',
  requested_not_confirmed: 'Requested but never confirmed by the provider',
}

function StateBadge({ state }: { state: CapabilityState }) {
  if (state === 'available') return <span className="capability-badge capability-available"><CheckCircle2 size={14} />Verified</span>
  if (state === 'unavailable') return <span className="capability-badge capability-unavailable"><XCircle size={14} />Not granted</span>
  return <span className="capability-badge capability-unverified"><HelpCircle size={14} />Unverified</span>
}

export default function ConnectionCapabilityPanel({ connectionId }: { connectionId: string }) {
  const [matrix, setMatrix] = React.useState<CapabilityMatrix | null>(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState('')

  const load = React.useCallback(async () => {
    try {
      setError('')
      setMatrix(await getOne<CapabilityMatrix>(`/connections/${connectionId}/capabilities`))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Capabilities could not be loaded.')
    }
  }, [connectionId])

  React.useEffect(() => { void load() }, [load])

  async function probe(capability: string) {
    setBusy(capability)
    try {
      await send('post', `/connections/${connectionId}/capabilities/${capability}/probe`, {})
      await load()
    } catch (probeError) {
      setError(probeError instanceof Error ? probeError.message : 'The capability probe did not complete.')
    } finally {
      setBusy('')
    }
  }

  if (!matrix) {
    return <Card className="capability-panel">{error ? <Alert>{error}</Alert> : <p>Loading capability evidence…</p>}</Card>
  }

  const unverified = matrix.capabilities.filter((item) => item.state === 'unverified')

  return (
    <Card className="capability-panel">
      <header>
        <h3>Provider capabilities</h3>
        <p className="capability-provenance">
          Scope evidence: {SCOPE_SOURCE_LABELS[matrix.scopeSource] || matrix.scopeSource}
          {matrix.scopeObservedAt ? ` · recorded ${new Date(matrix.scopeObservedAt).toLocaleString()}` : ''}
        </p>
      </header>

      {error && <Alert>{error}</Alert>}

      {unverified.length > 0 && (
        <Alert tone="warning">
          <ShieldAlert size={18} />
          <div>
            <strong>{unverified.length} capabilit{unverified.length === 1 ? 'y is' : 'ies are'} unverified.</strong>
            <p>
              Features that depend on an unverified capability are not running. An unverified capability is not the same as
              an empty account — it means this deployment has never observed the provider permit the operation.
            </p>
          </div>
        </Alert>
      )}

      <ul className="capability-list">
        {matrix.capabilities.map((item) => (
          <li key={item.capability} className={`capability-row capability-row-${item.state}`}>
            <div className="capability-heading">
              <strong>{LABELS[item.capability] || item.capability}</strong>
              <StateBadge state={item.state} />
            </div>
            <p className="capability-reason">{item.reason}</p>
            {item.remediation && (
              <p className="capability-remediation"><AlertTriangle size={13} /> {item.remediation}</p>
            )}
            <dl className="capability-evidence">
              {item.evidence.requiredScope && (
                <><dt>Required scope</dt><dd><code>{item.evidence.requiredScope}</code>{item.evidence.scopeGranted ? ' (granted)' : ' (not granted)'}</dd></>
              )}
              {item.evidence.probedAt && (
                <><dt>Last probe</dt><dd>{new Date(item.evidence.probedAt).toLocaleString()}{item.evidence.probeStatusCode ? ` · HTTP ${item.evidence.probeStatusCode}` : ''}</dd></>
              )}
            </dl>
            {matrix.probeable.includes(item.capability) && (
              <Button
                variant="secondary"
                busy={busy === item.capability}
                onClick={() => { void probe(item.capability) }}
              >
                <Play size={14} />
                {item.evidence.probedAt ? 'Re-run probe' : 'Run read-only probe'}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}
