import crypto from 'crypto'
import PlatformConnection from '../../models/PlatformConnection'
import CapabilityProbe from '../../models/CapabilityProbe'
import { createConnector } from '../connectors'
import { canonicalJson } from '../canonicalJson'
import {
  CAPABILITIES, CapabilityEvidence, CapabilityKey, CapabilityResolution,
  CapabilityState, ScopeSource, requiredScopeFor, resolveCapability,
} from './capabilityModel'

export type { CapabilityKey, CapabilityResolution, CapabilityState } from './capabilityModel'

/** Capabilities that are probeable read-only. Nothing destructive is ever probed. */
const PROBEABLE: CapabilityKey[] = ['workflow.inventory', 'contact.read']

async function latestProbe(organizationId: string, connectionId: string, capability: CapabilityKey) {
  return CapabilityProbe.findOne({ organizationId, connectionId, capability }).sort({ observedAt: -1 }).lean() as any
}

async function evidenceFor(
  connection: any,
  organizationId: string,
  capability: CapabilityKey,
): Promise<CapabilityEvidence> {
  const probe = await latestProbe(organizationId, String(connection._id), capability)
  return {
    grantedScopes: connection.grantedScopes || [],
    scopeSource: (connection.scopeSource || 'requested_not_confirmed') as ScopeSource,
    probe: probe ? { state: probe.state as CapabilityState, statusCode: probe.statusCode, observedAt: new Date(probe.observedAt), detail: probe.detail } : undefined,
  }
}

/** Resolve one capability for one connection from recorded evidence only. */
export async function connectionCapability(
  organizationId: string,
  connectionId: string,
  capability: CapabilityKey,
): Promise<CapabilityResolution> {
  const connection: any = await PlatformConnection.findOne({ _id: connectionId, organizationId })
    .select('provider grantedScopes scopeSource scopeObservedAt').lean()
  if (!connection) {
    return {
      capability,
      state: 'unavailable',
      reason: 'The connection does not exist in this organisation.',
      evidence: { scopeSource: 'requested_not_confirmed', scopeGranted: false },
    }
  }
  return resolveCapability(String(connection.provider), capability, await evidenceFor(connection, organizationId, capability))
}

/** Resolve every modelled capability for a connection, for API and UI display. */
export async function connectionCapabilityMatrix(organizationId: string, connectionId: string) {
  const connection: any = await PlatformConnection.findOne({ _id: connectionId, organizationId })
    .select('provider grantedScopes scopeSource scopeObservedAt').lean()
  if (!connection) return null
  const entries: CapabilityResolution[] = []
  for (const capability of CAPABILITIES) {
    entries.push(resolveCapability(String(connection.provider), capability, await evidenceFor(connection, organizationId, capability)))
  }
  return {
    connectionId,
    provider: String(connection.provider),
    scopeSource: connection.scopeSource || 'requested_not_confirmed',
    scopeObservedAt: connection.scopeObservedAt,
    probeable: PROBEABLE,
    capabilities: entries,
  }
}

export function isProbeable(capability: CapabilityKey): boolean {
  return PROBEABLE.includes(capability)
}

/**
 * Execute a live, read-only probe and durably record what the provider did.
 *
 * The probe deliberately records `unavailable` on an authorisation refusal and
 * `unverified` on anything ambiguous (timeout, 5xx, transport failure). An
 * inconclusive probe must never be recorded as a confirmation.
 */
export async function runCapabilityProbe(input: {
  organizationId: string
  connectionId: string
  capability: CapabilityKey
  userId?: string
  correlationId?: string
}): Promise<CapabilityResolution> {
  if (!isProbeable(input.capability)) throw new Error(`${input.capability} cannot be probed read-only`)
  const connection: any = await PlatformConnection.findOne({ _id: input.connectionId, organizationId: input.organizationId })
    .select('provider grantedScopes scopeSource').lean()
  if (!connection) throw new Error('Connection not found')
  const provider = String(connection.provider)

  let state: CapabilityState = 'unverified'
  let statusCode: number | undefined
  let detail = ''
  try {
    const connector = await createConnector({ organizationId: input.organizationId, provider: provider as any, connectionId: input.connectionId })
    if (input.capability === 'workflow.inventory') {
      if (typeof connector.listWorkflows !== 'function') throw Object.assign(new Error('unsupported'), { response: { status: 404 } })
      const rows = await connector.listWorkflows()
      state = 'available'
      detail = `Provider returned ${Array.isArray(rows) ? rows.length : 0} workflow records.`
    } else {
      if (typeof connector.listContactsPage !== 'function') throw Object.assign(new Error('unsupported'), { response: { status: 404 } })
      const page = await connector.listContactsPage(undefined, 1)
      state = 'available'
      detail = `Provider returned ${page?.contacts?.length ?? 0} contact records.`
    }
    statusCode = 200
  } catch (error: any) {
    statusCode = Number(error?.response?.status) || undefined
    if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
      state = 'unavailable'
      detail = `Provider refused the read with HTTP ${statusCode}.`
    } else {
      // Timeouts, 5xx and transport faults say nothing about entitlement.
      state = 'unverified'
      detail = statusCode ? `Probe inconclusive: HTTP ${statusCode}.` : 'Probe inconclusive: the request did not complete.'
    }
  }

  const observedAt = new Date()
  const evidenceHash = crypto.createHash('sha256').update(canonicalJson({
    connectionId: input.connectionId, provider, capability: input.capability, state, statusCode, observedAt: observedAt.toISOString(),
  })).digest('hex')

  await CapabilityProbe.create({
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    provider,
    capability: input.capability,
    state,
    statusCode,
    detail: detail.slice(0, 1_000),
    evidenceHash,
    observedAt,
    observedBy: input.userId,
    correlationId: input.correlationId,
  })

  return resolveCapability(provider, input.capability, {
    grantedScopes: connection.grantedScopes || [],
    scopeSource: (connection.scopeSource || 'requested_not_confirmed') as ScopeSource,
    probe: { state, statusCode, observedAt, detail },
  })
}

/**
 * Backward-compatible shim for the original `workflowInventoryCapability`.
 *
 * The original signature took a scope array and answered synchronously, which
 * is precisely what allowed an unconfirmed scope list to gate a feature. It is
 * retained so existing call sites keep compiling, but it can now only ever
 * return `enabled: false` with an instruction to resolve the capability
 * properly — there is no synchronous path to `enabled: true`.
 */
export function workflowInventoryCapabilitySync(provider: string): { enabled: false; reason: string } {
  const scope = requiredScopeFor(provider, 'workflow.inventory')
  return {
    enabled: false,
    reason: typeof scope === 'string'
      ? `Workflow inventory for ${provider} requires the ${scope} scope, confirmed by a provider scope grant or a recorded live probe.`
      : `Workflow inventory is not a confirmed capability for ${provider}.`,
  }
}
