import { BaseConnector } from './base';
import type { ConnectionCredentialResolver, ConnectorCapabilityManifest, ConnectorTransport, ContactInput, ContactPage, ExternalWorkflow, PlatformConnector, ResolvedConnectionCredential } from './types';

export const hubspotManifest: ConnectorCapabilityManifest = {
  provider: 'hubspot', displayName: 'HubSpot', authentication: ['oauth2', 'private-api-key'],
  capabilities: { contacts: ['read', 'create', 'update', 'upsert', 'bulk-upsert'], events: ['webhook'], workflows: [] },
  gatedCapabilities: { workflows: ['inventory', 'status', 'snapshot'], reason: 'Requires HubSpot automation scope availability for the installed app' },
  limits: { defaultTimeoutMs: 20_000, maximumBatchSize: 100 },
};

export class HubSpotConnector extends BaseConnector implements PlatformConnector {
  readonly manifest = hubspotManifest;
  private baseUrl = 'https://api.hubapi.com';
  constructor(credential: ResolvedConnectionCredential, resolver: ConnectionCredentialResolver, transport?: ConnectorTransport) {
    super(credential, resolver, transport); this.assertProvider('hubspot');
    this.baseUrl = 'https://api.hubapi.com';
  }
  private async headers() { return { Authorization: `Bearer ${await this.bearerToken()}`, 'Content-Type': 'application/json' }; }
  async health() {
    const response = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/crm/v3/objects/contacts`, headers: await this.headers(), params: { limit: 1, archived: false } });
    return { ok: true, account: response.data };
  }
  async getContact(id: string) { return (await this.transport.request({ method: 'GET', url: `${this.baseUrl}/crm/v3/objects/contacts/${encodeURIComponent(id)}`, headers: await this.headers() })).data; }
  private properties(contact: ContactInput) {
    return { ...contact.properties, email: contact.email, phone: contact.phone, firstname: contact.firstName, lastname: contact.lastName };
  }
  async upsertContact(contact: ContactInput) {
    const properties: any = this.properties(contact);
    Object.keys(properties).forEach(key => properties[key] === undefined && delete properties[key]);
    if (contact.id) return (await this.transport.request({ method: 'PATCH', url: `${this.baseUrl}/crm/v3/objects/contacts/${encodeURIComponent(contact.id)}`, headers: await this.headers(), data: { properties } })).data;
    if (!contact.email) throw new Error('HubSpot contact upsert requires id or email');
    const search: any = await this.transport.request({ method: 'POST', url: `${this.baseUrl}/crm/v3/objects/contacts/search`, headers: await this.headers(), data: { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: contact.email }] }], limit: 1 } });
    const existing = search.data?.results?.[0];
    if (existing?.id) return (await this.transport.request({ method: 'PATCH', url: `${this.baseUrl}/crm/v3/objects/contacts/${encodeURIComponent(existing.id)}`, headers: await this.headers(), data: { properties } })).data;
    return (await this.transport.request({ method: 'POST', url: `${this.baseUrl}/crm/v3/objects/contacts`, headers: await this.headers(), data: { properties } })).data;
  }
  async listContactsPage(cursor?: string, limit = 100): Promise<ContactPage> {
    const response: any = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/crm/v3/objects/contacts`, headers: await this.headers(), params: { limit: Math.min(100, Math.max(1, limit)), after: cursor || undefined, archived: false, properties: 'email,phone,firstname,lastname' } });
    return {
      contacts: (response.data?.results || []).map((item: any) => ({ id: String(item.id), email: item.properties?.email, phone: item.properties?.phone, firstName: item.properties?.firstname, lastName: item.properties?.lastname })),
      nextCursor: response.data?.paging?.next?.after ? String(response.data.paging.next.after) : undefined,
    };
  }
  async listWorkflows(): Promise<ExternalWorkflow[]> {
    const response: any = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/automation/v4/flows`, headers: await this.headers() });
    return (response.data?.results || response.data?.flows || []).map((item: any) => ({ id: String(item.id), name: String(item.name || item.id), status: item.isEnabled === false ? 'inactive' : item.status || 'active', updatedAt: item.updatedAt, raw: item }));
  }
  async execute(operation: string, input: any) {
    if (operation === 'contact.upsert') return this.upsertContact(input);
    if (operation === 'contact.get') return this.getContact(String(input?.id || ''));
    throw new Error(`Unsupported HubSpot operation: ${operation}`);
  }
}
