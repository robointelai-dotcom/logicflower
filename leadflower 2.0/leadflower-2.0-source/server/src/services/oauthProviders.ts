import axios from 'axios';
import crypto from 'crypto';
import { env } from '../env';
import { registerConnectionRevoker } from './connectionLifecycle';
import { createConnector, ConnectorProvider } from './connectors';

export type OAuthProvider = 'ghl' | 'hubspot' | 'klaviyo' | 'google';
type Config = { clientId: string; clientSecret: string; redirectUri: string; authorizeUrl: string; tokenUrl: string; scopes: string[]; pkce?: boolean };

function config(provider: OAuthProvider): Config {
  const values: Record<OAuthProvider, Partial<Config>> = {
    ghl: { clientId: env.GHL_CLIENT_ID, clientSecret: env.GHL_CLIENT_SECRET, redirectUri: env.GHL_REDIRECT_URI, authorizeUrl: 'https://marketplace.gohighlevel.com/oauth/chooselocation', tokenUrl: 'https://services.leadconnectorhq.com/oauth/token', scopes: env.GHL_OAUTH_SCOPES.split(/\s+/).filter(Boolean) },
    hubspot: { clientId: env.HUBSPOT_CLIENT_ID, clientSecret: env.HUBSPOT_CLIENT_SECRET, redirectUri: env.HUBSPOT_REDIRECT_URI, authorizeUrl: 'https://app.hubspot.com/oauth/authorize', tokenUrl: 'https://api.hubapi.com/oauth/2026-03/token', scopes: env.HUBSPOT_OAUTH_SCOPES.split(/\s+/).filter(Boolean) },
    klaviyo: { clientId: env.KLAVIYO_CLIENT_ID, clientSecret: env.KLAVIYO_CLIENT_SECRET, redirectUri: env.KLAVIYO_REDIRECT_URI, authorizeUrl: 'https://www.klaviyo.com/oauth/authorize', tokenUrl: 'https://a.klaviyo.com/oauth/token', scopes: env.KLAVIYO_OAUTH_SCOPES.split(/\s+/).filter(Boolean), pkce: true },
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: env.GOOGLE_REDIRECT_URI, authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scopes: ['https://www.googleapis.com/auth/spreadsheets'], pkce: true },
  };
  const item = values[provider]; if (!item.clientId || !item.clientSecret || !item.redirectUri || !item.authorizeUrl || !item.tokenUrl) throw new Error(`${provider} OAuth is not configured`);
  return item as Config;
}
export function oauthPkce() { const verifier = crypto.randomBytes(48).toString('base64url'); const challenge = crypto.createHash('sha256').update(verifier).digest('base64url'); return { verifier, challenge }; }
export function buildAuthorizationUrl(input: { provider: OAuthProvider; state: string; codeChallenge?: string }) {
  const item = config(input.provider); const url = new URL(item.authorizeUrl); url.searchParams.set('response_type', 'code'); url.searchParams.set('client_id', item.clientId); url.searchParams.set('redirect_uri', item.redirectUri); url.searchParams.set('scope', item.scopes.join(' ')); url.searchParams.set('state', input.state);
  if (item.pkce) { if (!input.codeChallenge) throw new Error(`${input.provider} OAuth requires PKCE`); url.searchParams.set('code_challenge_method', 'S256'); url.searchParams.set('code_challenge', input.codeChallenge); }
  if (input.provider === 'google') { url.searchParams.set('access_type', 'offline'); url.searchParams.set('prompt', 'consent'); }
  return { authorizationUrl: url.toString(), scopes: item.scopes, redirectUri: item.redirectUri };
}
export async function exchangeAuthorizationCode(input: { provider: OAuthProvider; code: string; codeVerifier?: string }) {
  const item = config(input.provider); const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, client_id: item.clientId, client_secret: item.clientSecret, redirect_uri: item.redirectUri }); if (item.pkce) { if (!input.codeVerifier) throw new Error('PKCE code verifier is required'); body.set('code_verifier', input.codeVerifier); }
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (input.provider === 'klaviyo') { headers.Authorization = `Basic ${Buffer.from(`${item.clientId}:${item.clientSecret}`).toString('base64')}`; body.delete('client_id'); body.delete('client_secret'); }
  const response = await axios.post(item.tokenUrl, body.toString(), { headers, timeout: 20_000, maxRedirects: 0 });
  const accessToken = String(response.data?.access_token || '');
  if (!accessToken) throw new Error(`${input.provider} OAuth response did not include access_token`);
  const expiresIn = Math.max(60, Number(response.data?.expires_in || 3600));
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1_000);
  const credentials: Record<string, unknown> = {
    accessToken,
    expiresAt: tokenExpiresAt.toISOString(),
    metadata: {
      scope: response.data?.scope,
      companyId: response.data?.companyId ? String(response.data.companyId) : undefined,
      userId: response.data?.userId ? String(response.data.userId) : undefined,
      accountId: response.data?.account_id ? String(response.data.account_id) : undefined,
    },
  };
  if (response.data?.refresh_token) credentials.refreshToken = String(response.data.refresh_token);
  if (response.data?.locationId) credentials.locationId = String(response.data.locationId);
  // A provider that does not echo `scope` has told us nothing about what it
  // granted. Substituting the requested scopes here would manufacture evidence
  // and is the specific defect that made unverified capabilities report as
  // available. The absence is reported instead.
  const returnedScope = typeof response.data?.scope === 'string' ? response.data.scope.trim() : '';
  const grantedScopes = returnedScope ? returnedScope.split(/\s+/).filter(Boolean) : [];
  return {
    credentials,
    tokenExpiresAt,
    grantedScopes,
    requestedScopes: item.scopes,
    scopeSource: (grantedScopes.length ? 'provider_token_response' : 'requested_not_confirmed') as 'provider_token_response' | 'requested_not_confirmed',
    /** @deprecated Use grantedScopes with scopeSource. Retained for callers mid-migration. */
    scopes: grantedScopes,
  };
}
export async function connectorHealth(input: { organizationId: string; provider: ConnectorProvider; connectionId: string }) { return (await createConnector(input)).health(); }

export function registerConnectorRevokers() {
  registerConnectionRevoker('hubspot', async ({ credentials }) => {
    if (!credentials.refreshToken) throw new Error('HubSpot refresh token is unavailable');
    const body = new URLSearchParams({ client_id: String(env.HUBSPOT_CLIENT_ID || ''), client_secret: String(env.HUBSPOT_CLIENT_SECRET || ''), token: credentials.refreshToken, token_type_hint: 'refresh_token' });
    await axios.post('https://api.hubapi.com/oauth/2026-03/token/revoke', body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20_000, maxRedirects: 0 });
  });
  registerConnectionRevoker('klaviyo', async ({ credentials }) => { if (!credentials.refreshToken) throw new Error('Klaviyo refresh token is unavailable'); const item = config('klaviyo'); await axios.post('https://a.klaviyo.com/oauth/revoke', new URLSearchParams({ token: credentials.refreshToken, token_type_hint: 'refresh_token' }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${item.clientId}:${item.clientSecret}`).toString('base64')}` }, timeout: 20_000, maxRedirects: 0 }); });
  registerConnectionRevoker('google', async ({ credentials }) => { const token = credentials.refreshToken || credentials.accessToken; if (!token) throw new Error('Google token is unavailable'); await axios.post('https://oauth2.googleapis.com/revoke', new URLSearchParams({ token }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20_000, maxRedirects: 0 }); });
}
