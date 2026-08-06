/**
 * Capability provenance.
 *
 * The failure this module exists to prevent: treating a scope we ASKED for as a
 * scope we WERE GRANTED, and then reporting a dependent feature as available.
 *
 * Every capability answer carries the evidence that produced it. There is no
 * code path that returns `available` without either (a) a scope string the
 * provider itself returned in its token response, or (b) a recorded live probe
 * against the provider's API. Absence of evidence resolves to `unverified`,
 * never to `available`, and `unverified` is surfaced to the operator rather
 * than silently degrading to an empty result set.
 */

export const CAPABILITIES = ['workflow.inventory', 'workflow.snapshot', 'contact.read', 'contact.write', 'contact.merge', 'contact.delete'] as const
export type CapabilityKey = (typeof CAPABILITIES)[number]

export const CAPABILITY_STATES = ['available', 'unavailable', 'unverified'] as const
export type CapabilityState = (typeof CAPABILITY_STATES)[number]

/**
 * How a scope list came to be associated with a connection. Only
 * `provider_token_response` and `live_probe` are evidence. The other two are
 * claims, and a claim can never resolve a capability to `available`.
 */
export const SCOPE_SOURCES = ['provider_token_response', 'live_probe', 'operator_claimed', 'requested_not_confirmed'] as const
export type ScopeSource = (typeof SCOPE_SOURCES)[number]

export const EVIDENTIAL_SCOPE_SOURCES: ReadonlySet<ScopeSource> = new Set<ScopeSource>(['provider_token_response', 'live_probe'])

export interface CapabilityEvidence {
  /** Scope strings the provider itself returned, if any. */
  grantedScopes: string[]
  scopeSource: ScopeSource
  /** Result of the most recent recorded live probe for this capability. */
  probe?: {
    state: CapabilityState
    statusCode?: number
    observedAt: Date
    detail?: string
  }
}

export interface CapabilityResolution {
  capability: CapabilityKey
  state: CapabilityState
  /** Machine-readable reason, safe to render in an API response. */
  reason: string
  /** What an operator must do to move this out of `unverified`. */
  remediation?: string
  evidence: {
    scopeSource: ScopeSource
    requiredScope?: string
    scopeGranted: boolean
    probedAt?: Date
    probeStatusCode?: number
  }
}

/**
 * Scope strings required per provider/capability.
 *
 * These are the values the codebase will TEST FOR in a provider-returned scope
 * list. They are not an assertion that the provider grants them, and a wrong
 * value here degrades to `unverified` (safe) rather than to `available`.
 * `null` means: this provider has no documented scope that confirms the
 * capability, so a scope check can never satisfy it and only a live probe can.
 */
const REQUIRED_SCOPE: Record<string, Partial<Record<CapabilityKey, string | null>>> = {
  ghl: {
    'workflow.inventory': 'workflows.readonly',
    'workflow.snapshot': 'workflows.readonly',
    'contact.read': 'contacts.readonly',
    'contact.write': 'contacts.write',
    'contact.merge': null,
    'contact.delete': null,
  },
  hubspot: {
    'workflow.inventory': 'automation',
    'workflow.snapshot': 'automation',
    'contact.read': 'crm.objects.contacts.read',
    'contact.write': 'crm.objects.contacts.write',
    'contact.merge': null,
    'contact.delete': null,
  },
  klaviyo: {
    'workflow.inventory': 'flows:read',
    'workflow.snapshot': 'flows:read',
    'contact.read': 'profiles:read',
    'contact.write': 'profiles:write',
    'contact.merge': null,
    'contact.delete': null,
  },
  activecampaign: { 'workflow.inventory': null, 'workflow.snapshot': null, 'contact.merge': null, 'contact.delete': null },
  google: { 'workflow.inventory': null, 'workflow.snapshot': null, 'contact.merge': null, 'contact.delete': null },
  generic: {},
}

export function requiredScopeFor(provider: string, capability: CapabilityKey): string | null | undefined {
  return REQUIRED_SCOPE[provider]?.[capability]
}

function normalise(scopes: string[]): Set<string> {
  return new Set(scopes.map((scope) => String(scope).trim().toLowerCase()).filter(Boolean))
}

/**
 * Resolve a single capability from recorded evidence.
 *
 * Precedence: a live probe always outranks a scope inspection, because a probe
 * observes the provider's actual behaviour and a scope list only describes it.
 */
export function resolveCapability(
  provider: string,
  capability: CapabilityKey,
  evidence: CapabilityEvidence,
): CapabilityResolution {
  const requiredScope = requiredScopeFor(provider, capability)
  const granted = normalise(evidence.grantedScopes || [])
  const scopeGranted = typeof requiredScope === 'string' && granted.has(requiredScope.toLowerCase())
  const base = {
    scopeSource: evidence.scopeSource,
    requiredScope: typeof requiredScope === 'string' ? requiredScope : undefined,
    scopeGranted,
    probedAt: evidence.probe?.observedAt,
    probeStatusCode: evidence.probe?.statusCode,
  }

  if (evidence.probe) {
    return {
      capability,
      state: evidence.probe.state,
      reason: evidence.probe.state === 'available'
        ? `A live probe on ${evidence.probe.observedAt.toISOString()} confirmed this capability.`
        : evidence.probe.state === 'unavailable'
          ? `A live probe on ${evidence.probe.observedAt.toISOString()} was refused by ${provider}${evidence.probe.statusCode ? ` with HTTP ${evidence.probe.statusCode}` : ''}.`
          : `The last probe on ${evidence.probe.observedAt.toISOString()} was inconclusive.`,
      remediation: evidence.probe.state === 'available' ? undefined : 'Re-authorise the connection with the required scope, then re-run the capability probe.',
      evidence: base,
    }
  }

  if (requiredScope === null) {
    return {
      capability,
      state: 'unverified',
      reason: `No documented ${provider} scope confirms ${capability}; only a live probe can establish it.`,
      remediation: 'Run a capability probe against a live sandbox connection.',
      evidence: base,
    }
  }

  if (requiredScope === undefined) {
    return {
      capability,
      state: 'unavailable',
      reason: `${capability} is not a modelled capability for ${provider}.`,
      evidence: base,
    }
  }

  if (!EVIDENTIAL_SCOPE_SOURCES.has(evidence.scopeSource)) {
    return {
      capability,
      state: 'unverified',
      reason: evidence.scopeSource === 'requested_not_confirmed'
        ? `${provider} did not return a scope grant, so the requested scopes cannot be treated as granted.`
        : 'The scope list on this connection was supplied by an operator and is not provider evidence.',
      remediation: `Run a capability probe, or reconnect so that ${provider} returns an explicit scope grant.`,
      evidence: base,
    }
  }

  if (!scopeGranted) {
    return {
      capability,
      state: 'unavailable',
      reason: `${provider} did not grant the ${requiredScope} scope.`,
      remediation: `Reconnect and consent to ${requiredScope}.`,
      evidence: base,
    }
  }

  return {
    capability,
    state: 'available',
    reason: `${provider} returned the ${requiredScope} scope in its token response.`,
    evidence: base,
  }
}

/** True only for `available`. Used at every call site that would otherwise assume. */
export function isAvailable(resolution: CapabilityResolution): boolean {
  return resolution.state === 'available'
}
