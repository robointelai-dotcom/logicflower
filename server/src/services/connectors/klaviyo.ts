import { BaseConnector } from './base';
import type { ConnectionCredentialResolver, ConnectorCapabilityManifest, ConnectorTransport, ContactInput, ContactPage, ExternalWorkflow, PlatformConnector, ResolvedConnectionCredential } from './types';

export const klaviyoManifest: ConnectorCapabilityManifest = {
  provider: 'klaviyo', displayName: 'Klaviyo', authentication: ['oauth2', 'private-api-key'],
  capabilities: { contacts: ['read', 'create', 'update', 'upsert', 'bulk-upsert'], events: ['create', 'webhook'], workflows: [] },
  gatedCapabilities: { workflows: ['inventory', 'status', 'snapshot'], reason: 'Requires flows:read and per-connection monitoring approval' },
  limits: { defaultTimeoutMs: 20_000, maximumBatchSize: 10_000 },
};

export class KlaviyoConnector extends BaseConnector implements PlatformConnector {
  readonly manifest = klaviyoManifest;
  private baseUrl = 'https://a.klaviyo.com';
  constructor(credential: ResolvedConnectionCredential, resolver: ConnectionCredentialResolver, transport?: ConnectorTransport) {
    super(credential, resolver, transport); this.assertProvider('klaviyo');
    this.baseUrl = 'https://a.klaviyo.com';
  }
  private async headers() {
    const token = await this.bearerToken();
    const authorization = this.credential.accessToken ? `Bearer ${token}` : `Klaviyo-API-Key ${token}`;
    return { Authorization: authorization, accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json', revision: '2026-07-15' };
  }
  async health() { const response = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/api/accounts`, headers: await this.headers() }); return { ok: true, account: response.data }; }
  async getContact(id: string) { return (await this.transport.request({ method: 'GET', url: `${this.baseUrl}/api/profiles/${encodeURIComponent(id)}`, headers: await this.headers() })).data; }
  async upsertContact(contact: ContactInput) {
    const attributes: any = { ...contact.properties, email: contact.email, phone_number: contact.phone, first_name: contact.firstName, last_name: contact.lastName };
    Object.keys(attributes).forEach(key => attributes[key] === undefined && delete attributes[key]);
    const data: any = { type: 'profile', attributes };
    if (contact.id) data.id = contact.id;
    return (await this.transport.request({ method: 'POST', url: `${this.baseUrl}/api/profile-import`, headers: await this.headers(), data: { data } })).data;
  }
  async listContactsPage(cursor?: string, limit = 100): Promise<ContactPage> {
    const response: any = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/api/profiles`, headers: await this.headers(), params: { 'page[size]': Math.min(100, Math.max(1, limit)), 'page[cursor]': cursor || undefined, 'fields[profile]': 'email,phone_number,first_name,last_name' } });
    let nextCursor: string | undefined;
    if (response.data?.links?.next) {
      try { nextCursor = new URL(String(response.data.links.next)).searchParams.get('page[cursor]') || undefined; } catch { nextCursor = undefined; }
    }
    return {
      contacts: (response.data?.data || []).map((item: any) => ({ id: String(item.id), email: item.attributes?.email, phone: item.attributes?.phone_number, firstName: item.attributes?.first_name, lastName: item.attributes?.last_name })),
      nextCursor,
    };
  }
  async listWorkflows(): Promise<ExternalWorkflow[]> {
    const response: any = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/api/flows`, headers: await this.headers(), params: { 'page[size]': 100 } });
    return (response.data?.data || []).map((item: any) => ({ id: String(item.id), name: String(item.attributes?.name || item.id), status: item.attributes?.status, updatedAt: item.attributes?.updated, raw: item }));
  }
  async execute(operation: string, input: any) {
    if (operation === 'profile.upsert' || operation === 'contact.upsert') return this.upsertContact(input);
    if (operation === 'profile.get' || operation === 'contact.get') return this.getContact(String(input?.id || ''));
    if (operation === 'event.create') {
      if (!input?.metric?.name && !input?.metricName) throw new Error('Klaviyo event metric name is required');
      const attributes = input?.attributes || { profile: { data: { type: 'profile', attributes: input.profile } }, metric: { data: { type: 'metric', attributes: { name: input.metricName || input.metric?.name } } }, properties: input.properties || {}, time: input.time };
      return (await this.transport.request({ method: 'POST', url: `${this.baseUrl}/api/events`, headers: await this.headers(), data: { data: { type: 'event', attributes } } })).data;
    }
    throw new Error(`Unsupported Klaviyo operation: ${operation}`);
  }
}
