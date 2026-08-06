import { BaseConnector } from './base';
import type { ConnectionCredentialResolver, ConnectorCapabilityManifest, ConnectorTransport, ContactInput, ContactPage, ExternalWorkflow, PlatformConnector, ResolvedConnectionCredential } from './types';
import { pinnedHttpsAgent, validateOutboundUrl } from '../ssrfGuard';

const nextAllowedRequest = new Map<string, number>();
async function throttle(key: string) {
  const now = Date.now(); const allowedAt = Math.max(now, nextAllowedRequest.get(key) || 0);
  nextAllowedRequest.set(key, allowedAt + 205);
  if (allowedAt > now) await new Promise(resolve => setTimeout(resolve, allowedAt - now));
}

export const activeCampaignManifest: ConnectorCapabilityManifest = {
  provider: 'activecampaign', displayName: 'ActiveCampaign', authentication: ['private-api-key'],
  capabilities: { contacts: ['read', 'create', 'update', 'upsert', 'bulk-upsert'], events: ['webhook'], workflows: [] },
  gatedCapabilities: { workflows: ['inventory', 'status', 'snapshot'], reason: 'Connector remains gated until credentials and automation endpoints pass live acceptance' },
  limits: { defaultTimeoutMs: 20_000, maximumBatchSize: 250 },
};

export class ActiveCampaignConnector extends BaseConnector implements PlatformConnector {
  readonly manifest = activeCampaignManifest;
  private baseUrl: string;
  constructor(credential: ResolvedConnectionCredential, resolver: ConnectionCredentialResolver, transport?: ConnectorTransport) {
    super(credential, resolver, transport); this.assertProvider('activecampaign');
    this.baseUrl = String(credential.baseUrl || credential.metadata?.apiUrl || '').replace(/\/$/, '');
    if (!this.baseUrl.startsWith('https://')) throw new Error('ActiveCampaign connection requires its HTTPS account API URL');
    const hostname = new URL(this.baseUrl).hostname.toLowerCase();
    if (!/(^|\.)(api-(us|eu|au)\d+\.com|activehosted\.com)$/.test(hostname)) throw new Error('ActiveCampaign API URL host is not approved');
  }
  private async requestContext() {
    const validated = await validateOutboundUrl(`${this.baseUrl}/api/3/users/me`, { allowedHosts: [new URL(this.baseUrl).hostname] });
    await throttle(this.credential.connectionId || this.baseUrl);
    return { headers: { 'Api-Token': await this.bearerToken(), 'Content-Type': 'application/json', Accept: 'application/json' }, httpsAgent: pinnedHttpsAgent(validated) };
  }
  async health() { const response = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/api/3/users/me`, ...await this.requestContext() }); return { ok: true, account: response.data }; }
  async getContact(id: string) { return (await this.transport.request({ method: 'GET', url: `${this.baseUrl}/api/3/contacts/${encodeURIComponent(id)}`, ...await this.requestContext() })).data; }
  async upsertContact(contact: ContactInput) {
    if (!contact.email) throw new Error('ActiveCampaign contact sync requires email');
    const data: any = { email: contact.email, phone: contact.phone, firstName: contact.firstName, lastName: contact.lastName, ...contact.properties };
    Object.keys(data).forEach(key => data[key] === undefined && delete data[key]);
    return (await this.transport.request({ method: 'POST', url: `${this.baseUrl}/api/3/contact/sync`, ...await this.requestContext(), data: { contact: data } })).data;
  }
  async listContactsPage(cursor?: string, limit = 100): Promise<ContactPage> {
    const offset = Math.max(0, Number(cursor || 0)); const pageSize = Math.min(100, Math.max(1, limit));
    const response: any = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/api/3/contacts`, ...await this.requestContext(), params: { limit: pageSize, offset } });
    const rows = response.data?.contacts || []; const total = Number(response.data?.meta?.total || 0); const nextOffset = offset + rows.length;
    return {
      contacts: rows.map((item: any) => ({ id: String(item.id), email: item.email, phone: item.phone, firstName: item.firstName, lastName: item.lastName })),
      nextCursor: rows.length && (!total || nextOffset < total) ? String(nextOffset) : undefined,
    };
  }
  async listWorkflows(): Promise<ExternalWorkflow[]> {
    const response: any = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/api/3/automations`, ...await this.requestContext(), params: { limit: 100 } });
    return (response.data?.automations || []).map((item: any) => ({ id: String(item.id), name: String(item.name || item.id), status: String(item.status), updatedAt: item.mdate, raw: item }));
  }
  async execute(operation: string, input: any) {
    if (operation === 'contact.upsert') return this.upsertContact(input);
    if (operation === 'contact.get') return this.getContact(String(input?.id || ''));
    throw new Error(`Unsupported ActiveCampaign operation: ${operation}`);
  }
}
