import axios from 'axios';
import { env } from '../env';
import { acquireCredentialRefreshLease, getConnectionCredential, releaseCredentialRefreshLease, updateConnectionCredential } from './connectionCredentials';
import type { ConnectionCredentialResolver, ResolvedConnectionCredential } from './connectors/types';
import crypto from 'crypto';

type OAuthConfiguration = { clientId?: string; clientSecret?: string; tokenUrl: string; basicAuth?: boolean };

function oauthConfiguration(provider: string): OAuthConfiguration | undefined {
  if (provider === 'ghl') return { clientId: env.GHL_CLIENT_ID, clientSecret: env.GHL_CLIENT_SECRET, tokenUrl: 'https://services.leadconnectorhq.com/oauth/token' };
  if (provider === 'hubspot') return { clientId: env.HUBSPOT_CLIENT_ID, clientSecret: env.HUBSPOT_CLIENT_SECRET, tokenUrl: 'https://api.hubapi.com/oauth/2026-03/token' };
  if (provider === 'klaviyo') return { clientId: env.KLAVIYO_CLIENT_ID, clientSecret: env.KLAVIYO_CLIENT_SECRET, tokenUrl: 'https://a.klaviyo.com/oauth/token', basicAuth: true };
  if (provider === 'google') return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, tokenUrl: 'https://oauth2.googleapis.com/token' };
  return undefined;
}

function adaptCredential(value: any): ResolvedConnectionCredential {
  return {
    ...value,
    provider: value.provider,
    organizationId: String(value.organizationId),
    connectionId: String(value.connectionId),
    expiresAt: value.expiresAt,
    metadata: value.metadata || {},
  };
}

export const platformConnectionCredentialResolver: ConnectionCredentialResolver = {
  async resolve(request) {
    const credential = await getConnectionCredential(request as any);
    return adaptCredential(credential);
  },
  async refresh(credential) {
    if (!credential.refreshToken || !credential.connectionId) throw new Error(`${credential.provider} connection requires reauthorization`);
    const owner = crypto.randomUUID();
    const acquired = await acquireCredentialRefreshLease({ organizationId: credential.organizationId, connectionId: credential.connectionId, provider: credential.provider as any, owner, leaseMs: 30_000 });
    if (!acquired) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 125));
        const winner: any = await getConnectionCredential({ organizationId: credential.organizationId, provider: credential.provider as any, connectionId: credential.connectionId });
        if (winner.accessToken && winner.accessToken !== credential.accessToken) return adaptCredential(winner);
      }
      throw new Error(`${credential.provider} credential refresh is already in progress`);
    }
    try {
    const config = oauthConfiguration(credential.provider);
    if (!config?.clientId || !config.clientSecret) throw new Error(`${credential.provider} OAuth client is not configured`);
    const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refreshToken });
    if (!config.basicAuth) { params.set('client_id', config.clientId); params.set('client_secret', config.clientSecret); }
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (config.basicAuth) headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
    const response = await axios.post(config.tokenUrl, params.toString(), { headers, timeout: 20_000, maxRedirects: 0 });
    const accessToken = String(response.data?.access_token || '');
    if (!accessToken) throw new Error(`${credential.provider} refresh response did not include an access token`);
    const expiresIn = Math.max(60, Number(response.data?.expires_in || 3600));
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const next = {
      accessToken,
      refreshToken: String(response.data?.refresh_token || credential.refreshToken),
      expiresAt: expiresAt.toISOString(),
      metadata: { ...(credential.metadata || {}), scope: response.data?.scope || credential.metadata?.scope },
    };
    try {
      const credentialVersion = await updateConnectionCredential({
        organizationId: credential.organizationId,
        connectionId: credential.connectionId,
        provider: credential.provider as any,
        credentials: next,
        tokenExpiresAt: expiresAt,
        status: 'active',
        expectedVersion: credential.credentialVersion,
      });
      return { ...credential, ...next, credentialVersion };
    } catch (error: any) {
      if (!/credential version conflict|update conflicted/i.test(String(error?.message || ''))) throw error;
      const winner: any = await getConnectionCredential({ organizationId: credential.organizationId, provider: credential.provider as any, connectionId: credential.connectionId });
      if (!winner.accessToken) throw error;
      return adaptCredential(winner);
    }
    } finally {
      await releaseCredentialRefreshLease({ organizationId: credential.organizationId, connectionId: credential.connectionId, provider: credential.provider as any, owner }).catch(() => undefined);
    }
  },
};
