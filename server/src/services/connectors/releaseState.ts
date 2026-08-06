import { env } from '../../env'

/**
 * Connector release gating.
 *
 * [V14] records that ActiveCampaign's API licence may contain a competitive-use
 * restriction that has not been read by counsel. The feasibility report's
 * position is to deprioritise it indefinitely. Shipping the adapter while that
 * question is open is only defensible if the adapter cannot be used until the
 * question is closed, and if closing it is a configuration decision made by an
 * accountable person rather than a code change made by an engineer.
 *
 * States:
 *  - `general`     usable normally.
 *  - `quarantined` no new connections; existing connections are read-only.
 *                  Write operations are refused with HTTP 451.
 *  - `disabled`    no use at all, including reads.
 *
 * Defaults are deliberately restrictive. A connector whose legal position is
 * unresolved defaults to `quarantined`, and reaching `general` requires an
 * explicit entry in CONNECTOR_RELEASE_STATES.
 */
export const CONNECTOR_RELEASE_STATES = ['general', 'quarantined', 'disabled'] as const
export type ConnectorReleaseState = (typeof CONNECTOR_RELEASE_STATES)[number]

/**
 * Built-in defaults. `activecampaign` is quarantined pending the [V14] licence
 * review. Changing this line is not the intended mechanism — set the
 * CONNECTOR_RELEASE_STATES environment variable after counsel signs off.
 */
const DEFAULT_STATE: Record<string, ConnectorReleaseState> = {
  ghl: 'general',
  hubspot: 'general',
  klaviyo: 'general',
  google: 'general',
  generic: 'general',
  openai: 'general',
  anthropic: 'general',
  googleai: 'general',
  activecampaign: 'quarantined',
}

const REASON: Record<string, string> = {
  activecampaign: 'The ActiveCampaign API licence has not been reviewed for competitive-use restrictions ([V14]). The connector is available for inspection but cannot perform writes until that review is recorded.',
}

let cache: Record<string, ConnectorReleaseState> | null = null

function parseOverrides(raw: string): Record<string, ConnectorReleaseState> {
  const parsed: Record<string, ConnectorReleaseState> = {}
  for (const entry of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
    const [provider, state] = entry.split(':').map((value) => value.trim().toLowerCase())
    if (!provider || !state) continue
    if (!(CONNECTOR_RELEASE_STATES as readonly string[]).includes(state)) continue
    parsed[provider] = state as ConnectorReleaseState
  }
  return parsed
}

function states(): Record<string, ConnectorReleaseState> {
  if (!cache) cache = { ...DEFAULT_STATE, ...parseOverrides(env.CONNECTOR_RELEASE_STATES || '') }
  return cache
}

/** Test seam. Production code never calls this. */
export function resetConnectorReleaseStateCache(): void {
  cache = null
}

export function connectorReleaseState(provider: string): ConnectorReleaseState {
  return states()[String(provider).toLowerCase()] || 'quarantined'
}

export function connectorReleaseReason(provider: string): string | undefined {
  const state = connectorReleaseState(provider)
  if (state === 'general') return undefined
  return REASON[String(provider).toLowerCase()]
    || `The ${provider} connector is ${state} in this deployment pending provider or legal acceptance.`
}

export function canCreateConnection(provider: string): boolean {
  return connectorReleaseState(provider) === 'general'
}

export function canRead(provider: string): boolean {
  return connectorReleaseState(provider) !== 'disabled'
}

export function canWrite(provider: string): boolean {
  return connectorReleaseState(provider) === 'general'
}

export function connectorReleaseSummary() {
  const current = states()
  return Object.keys(current).sort().map((provider) => ({
    provider,
    state: current[provider]!,
    reason: connectorReleaseReason(provider),
  }))
}
