import { env } from '../env'
import { connectionCapability } from './capability/capabilityService'

/**
 * [V3] contingency mode.
 *
 * The feasibility report's section 6.3 contingency: if full workflow
 * definitions cannot be read from HighLevel, the product reduces to Batch
 * processing plus connection-health Watch. That is still a business — but only
 * if the application degrades to it deliberately rather than by throwing
 * wherever a workflow read was assumed.
 *
 * Two independent switches, and both must permit an operation:
 *
 *  1. `FEATURE_WATCH_WORKFLOWS_ENABLED` — a deployment-wide kill switch. Set it
 *     false the moment the scope is refused, and workflow monitoring disappears
 *     cleanly from the API and the UI instead of erroring per connection.
 *  2. Per-connection capability evidence — even with the feature on, a
 *     connection whose capability is not `available` does not attempt the read.
 *
 * The kill switch is separate from the capability check because they answer
 * different questions. Capability asks "can this connection do it"; the flag
 * asks "does this product ship it at all". Conflating them is how a global
 * outcome ends up encoded as thousands of per-record failures.
 */

export const WATCH_MODES = ['full', 'connection_health_only'] as const
export type WatchMode = (typeof WATCH_MODES)[number]

export interface WatchCapabilityDecision {
  mode: WatchMode
  workflowMonitoringEnabled: boolean
  reason: string
  /** Features that remain fully available in this mode. */
  availableFeatures: string[]
  /** Features suppressed, with the reason an operator can act on. */
  suppressedFeatures: string[]
}

const ALWAYS_AVAILABLE = [
  'batch.processing',
  'batch.deduplication_report',
  'connection.health_monitoring',
  'connection.credential_expiry_alerts',
  'webhook.ingestion',
  'reports.usage',
  'audit.history',
]

const WORKFLOW_DEPENDENT = [
  'watch.workflow_inventory',
  'watch.workflow_change_detection',
  'watch.workflow_health_dashboard',
  'vault.workflow_snapshots',
  'vault.structural_diff',
]

/** Deployment-wide mode, independent of any particular connection. */
export function watchMode(): WatchMode {
  return env.FEATURE_WATCH_WORKFLOWS_ENABLED ? 'full' : 'connection_health_only'
}

export function deploymentWatchDecision(): WatchCapabilityDecision {
  if (watchMode() === 'full') {
    return {
      mode: 'full',
      workflowMonitoringEnabled: true,
      reason: 'Workflow monitoring is enabled for this deployment. Availability is still resolved per connection from recorded capability evidence.',
      availableFeatures: [...ALWAYS_AVAILABLE, ...WORKFLOW_DEPENDENT],
      suppressedFeatures: [],
    }
  }
  return {
    mode: 'connection_health_only',
    workflowMonitoringEnabled: false,
    reason: 'This deployment runs in Batch plus connection-health mode because provider workflow-read access is unavailable ([V3]). Workflow monitoring is not offered.',
    availableFeatures: ALWAYS_AVAILABLE,
    suppressedFeatures: WORKFLOW_DEPENDENT,
  }
}

/**
 * Resolve whether workflow monitoring may run for one connection.
 *
 * Returns a decision in every case and never throws. A caller that receives
 * `workflowMonitoringEnabled: false` should skip the read and report the
 * reason, not treat it as an error condition.
 */
export async function connectionWatchDecision(organizationId: string, connectionId: string): Promise<WatchCapabilityDecision> {
  const deployment = deploymentWatchDecision()
  if (!deployment.workflowMonitoringEnabled) return deployment

  try {
    const capability = await connectionCapability(organizationId, connectionId, 'workflow.inventory')
    if (capability.state === 'available') return deployment
    return {
      mode: 'connection_health_only',
      workflowMonitoringEnabled: false,
      reason: capability.reason,
      availableFeatures: ALWAYS_AVAILABLE,
      suppressedFeatures: WORKFLOW_DEPENDENT,
    }
  } catch {
    // An error resolving capability is not evidence that the capability exists.
    // Degrading is the safe direction: the customer loses a feature, not data.
    return {
      mode: 'connection_health_only',
      workflowMonitoringEnabled: false,
      reason: 'Capability evidence could not be resolved for this connection; workflow monitoring is suppressed until it can be.',
      availableFeatures: ALWAYS_AVAILABLE,
      suppressedFeatures: WORKFLOW_DEPENDENT,
    }
  }
}
