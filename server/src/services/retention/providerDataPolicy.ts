/**
 * Post-disconnection retention policy for provider-derived data.
 *
 * [V11] records an unresolved conflict: some provider developer terms require
 * deletion of cached customer data after an integration is disconnected, while
 * the Vault proposition depends on retaining a history of workflow definitions.
 * The report's instruction is to design the retention model against that
 * constraint before writing the schema.
 *
 * The resolution implemented here is that retention is a per-provider policy
 * with a recorded legal basis, and the default basis is `unreviewed`, which
 * purges immediately. Retaining anything requires a named person to record that
 * counsel reviewed the specific provider's terms. Nothing is retained because a
 * feature would be nicer with it.
 *
 * The customer-held export remains the durable artefact: on disconnection the
 * organisation is offered its Vault export before provider-derived records are
 * purged, which satisfies the product need without vendor-side retention.
 */

export const LEGAL_BASIS = ['unreviewed', 'counsel_confirmed_retention_permitted', 'counsel_confirmed_deletion_required'] as const
export type LegalBasis = (typeof LEGAL_BASIS)[number]

export interface ProviderDataPolicy {
  provider: string
  /**
   * Days that provider-derived records may be retained after disconnection.
   * `0` means purge on disconnection.
   */
  postDisconnectRetentionDays: number
  legalBasis: LegalBasis
  /** Free text recording who confirmed the basis and when. Required to retain. */
  reviewNote: string
}

const DEFAULT_POLICY: Record<string, ProviderDataPolicy> = {
  ghl: {
    provider: 'ghl',
    postDisconnectRetentionDays: 0,
    legalBasis: 'unreviewed',
    reviewNote: 'HighLevel developer terms have not been reviewed for a cached-data deletion obligation ([V11] adjacent). Purging on disconnection until counsel records otherwise.',
  },
  hubspot: {
    provider: 'hubspot',
    postDisconnectRetentionDays: 0,
    legalBasis: 'unreviewed',
    reviewNote: 'HubSpot developer terms are recorded in the feasibility report as containing a cached-data deletion obligation on disconnection ([V11]). Purging on disconnection.',
  },
  klaviyo: {
    provider: 'klaviyo',
    postDisconnectRetentionDays: 0,
    legalBasis: 'unreviewed',
    reviewNote: 'Klaviyo partner terms have not been reviewed ([V22]). Purging on disconnection.',
  },
  activecampaign: {
    provider: 'activecampaign',
    postDisconnectRetentionDays: 0,
    legalBasis: 'unreviewed',
    reviewNote: 'ActiveCampaign licence terms are unreviewed ([V14]). Purging on disconnection.',
  },
  google: {
    provider: 'google',
    postDisconnectRetentionDays: 0,
    legalBasis: 'unreviewed',
    reviewNote: 'Google API Services User Data Policy has not been reviewed for this use. Purging on disconnection.',
  },
}

const FALLBACK: ProviderDataPolicy = {
  provider: 'unknown',
  postDisconnectRetentionDays: 0,
  legalBasis: 'unreviewed',
  reviewNote: 'No policy is recorded for this provider. Purging on disconnection.',
}

export function providerDataPolicy(provider: string): ProviderDataPolicy {
  return DEFAULT_POLICY[String(provider).toLowerCase()] || { ...FALLBACK, provider: String(provider) }
}

/**
 * Retention is only honoured when counsel has explicitly confirmed it is
 * permitted. Any other basis, including a positive retention day count set by
 * mistake, purges immediately.
 */
export function retentionDaysAfterDisconnect(provider: string): number {
  const policy = providerDataPolicy(provider)
  if (policy.legalBasis !== 'counsel_confirmed_retention_permitted') return 0
  return Math.max(0, Math.floor(policy.postDisconnectRetentionDays))
}

export function providerDataPolicySummary(): ProviderDataPolicy[] {
  return Object.keys(DEFAULT_POLICY).sort().map((provider) => DEFAULT_POLICY[provider]!)
}
