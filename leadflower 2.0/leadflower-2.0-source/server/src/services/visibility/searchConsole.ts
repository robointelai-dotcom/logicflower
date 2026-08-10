/**
 * Google Search Console, behind an adapter.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * Search Console requires no application to Google and no approval. The
 * customer authorises us against their own verified property with OAuth, the
 * way they would connect a calendar. It supplies the search queries that make
 * the attribution report meaningful.
 *
 * The Business Profile API — reading and replying to Google reviews, editing a
 * listing — is a different thing entirely. It is granted per application, takes
 * weeks to months, and can be refused. It is NOT part of this module, and
 * conflating the two means waiting for an approval this feature never needed.
 *
 * WHY AN ADAPTER
 *
 * Nothing here has been exercised against Google's live API from a development
 * environment without credentials. The adapter keeps that honest: the
 * unconfigured implementation refuses clearly rather than returning empty
 * results that look like "no traffic".
 */

export interface SearchQueryRow {
  query: string
  page?: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface SearchConsoleProvider {
  readonly name: string
  /** Whether this deployment is configured to talk to Google at all. */
  isConfigured(): boolean
  /** Where to send the customer to authorise. */
  authorizationUrl(input: { organizationId: string; redirectUri: string; state: string }): string
  exchangeCode(input: { code: string; redirectUri: string }): Promise<{
    refreshToken: string
    accessToken: string
    expiresAt: Date
    email?: string
  }>
  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }>
  listSites(accessToken: string): Promise<Array<{ siteUrl: string; permissionLevel: string }>>
  queryAnalytics(input: {
    accessToken: string
    siteUrl: string
    from: Date
    to: Date
    rowLimit?: number
  }): Promise<SearchQueryRow[]>
}

export class SearchConsoleNotConfiguredError extends Error {
  constructor() {
    super(
      'Search Console is not configured for this deployment. Set GOOGLE_OAUTH_CLIENT_ID and '
      + 'GOOGLE_OAUTH_CLIENT_SECRET, then add the redirect URI to the OAuth client in the Google Cloud console.',
    )
    this.name = 'SearchConsoleNotConfiguredError'
  }
}

/**
 * The implementation used when no OAuth client is configured.
 *
 * Every method throws with an actionable message rather than returning an empty
 * array. An empty array here would render as "no search traffic", the operator
 * would conclude their site has no visibility, and nobody would discover that
 * the integration was never switched on.
 */
export class UnconfiguredSearchConsoleProvider implements SearchConsoleProvider {
  readonly name = 'google-search-console-unconfigured'

  isConfigured(): boolean {
    return false
  }

  authorizationUrl(): string {
    throw new SearchConsoleNotConfiguredError()
  }

  async exchangeCode(): Promise<never> {
    throw new SearchConsoleNotConfiguredError()
  }

  async refreshAccessToken(): Promise<never> {
    throw new SearchConsoleNotConfiguredError()
  }

  async listSites(): Promise<never> {
    throw new SearchConsoleNotConfiguredError()
  }

  async queryAnalytics(): Promise<never> {
    throw new SearchConsoleNotConfiguredError()
  }
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const API_BASE = 'https://searchconsole.googleapis.com/webmasters/v3'

/** Read-only. We never need to change anything in their Search Console. */
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'

export class GoogleSearchConsoleProvider implements SearchConsoleProvider {
  readonly name = 'google-search-console'

  constructor(private readonly clientId: string, private readonly clientSecret: string) {}

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret)
  }

  authorizationUrl(input: { organizationId: string; redirectUri: string; state: string }): string {
    if (!this.isConfigured()) throw new SearchConsoleNotConfiguredError()
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: SCOPE,
      // Required to receive a refresh token at all. Without `offline` the
      // connection dies the first time the access token expires, and the
      // customer has to reconnect every hour.
      access_type: 'offline',
      // Forces the consent screen so a refresh token is issued even on a
      // re-authorisation, which Google otherwise omits.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: input.state,
    })
    return `${AUTH_ENDPOINT}?${params.toString()}`
  }

  async exchangeCode(input: { code: string; redirectUri: string }) {
    if (!this.isConfigured()) throw new SearchConsoleNotConfiguredError()

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    if (!response.ok) {
      // The body is not surfaced to the operator: it can carry the client
      // secret back in an error description.
      throw new Error(`Google refused the authorisation (${response.status}). Check the redirect URI matches the OAuth client exactly.`)
    }
    const body: any = await response.json()
    if (!body.refresh_token) {
      throw new Error('Google returned no refresh token. The account may already have authorised this application — revoke it in the Google account permissions and try again.')
    }

    return {
      refreshToken: String(body.refresh_token),
      accessToken: String(body.access_token),
      expiresAt: new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000),
      email: undefined,
    }
  }

  async refreshAccessToken(refreshToken: string) {
    if (!this.isConfigured()) throw new SearchConsoleNotConfiguredError()
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
      }),
    })
    if (!response.ok) {
      // A revoked token is a 400 here. Distinguished by the caller so the
      // connection is marked revoked rather than retried forever.
      throw new Error(`Could not refresh the Search Console connection (${response.status}). The customer may have revoked access in their Google account.`)
    }
    const body: any = await response.json()
    return {
      accessToken: String(body.access_token),
      expiresAt: new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000),
    }
  }

  async listSites(accessToken: string) {
    const response = await fetch(`${API_BASE}/sites`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw new Error(`Could not list Search Console properties (${response.status})`)
    const body: any = await response.json()
    return (body.siteEntry ?? []).map((entry: any) => ({
      siteUrl: String(entry.siteUrl),
      permissionLevel: String(entry.permissionLevel ?? 'unknown'),
    }))
  }

  async queryAnalytics(input: { accessToken: string; siteUrl: string; from: Date; to: Date; rowLimit?: number }) {
    const response = await fetch(`${API_BASE}/sites/${encodeURIComponent(input.siteUrl)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: input.from.toISOString().slice(0, 10),
        endDate: input.to.toISOString().slice(0, 10),
        dimensions: ['query', 'page'],
        rowLimit: Math.min(input.rowLimit ?? 500, 25_000),
      }),
    })
    if (!response.ok) throw new Error(`Search Console refused the query (${response.status})`)
    const body: any = await response.json()

    return (body.rows ?? []).map((row: any) => ({
      query: String(row.keys?.[0] ?? ''),
      page: row.keys?.[1] ? String(row.keys[1]) : undefined,
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      ctr: Number(row.ctr ?? 0),
      position: Number(row.position ?? 0),
    }))
  }
}

/**
 * The provider for this deployment.
 *
 * Returns the unconfigured implementation when no OAuth client is set, so the
 * failure is a clear refusal rather than silence.
 */
export function searchConsoleProvider(): SearchConsoleProvider {
  const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim()
  const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim()
  if (!clientId || !clientSecret) return new UnconfiguredSearchConsoleProvider()
  return new GoogleSearchConsoleProvider(clientId, clientSecret)
}
