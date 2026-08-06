import { BaseConnector } from './base';
import type { ConnectionCredentialResolver, ConnectorCapabilityManifest, ConnectorTransport, ContactInput, ContactPage, ExternalWorkflow, PlatformConnector, ResolvedConnectionCredential } from './types';

export const ghlManifest: ConnectorCapabilityManifest = {
  provider: 'ghl', displayName: 'HighLevel', authentication: ['oauth2', 'private-api-key'],
  capabilities: { contacts: ['read', 'create', 'update', 'upsert'], events: ['webhook'], workflows: [] },
  gatedCapabilities: { workflows: ['inventory', 'status', 'snapshot'], reason: 'Requires approved OAuth scopes and platform contract verification per connection' },
  limits: { defaultTimeoutMs: 20_000, maximumBatchSize: 100 },
};

export class GhlConnector extends BaseConnector implements PlatformConnector {
  readonly manifest = ghlManifest;
  private baseUrl: string;
  constructor(credential: ResolvedConnectionCredential, resolver: ConnectionCredentialResolver, transport?: ConnectorTransport) {
    super(credential, resolver, transport); this.assertProvider('ghl');
    this.baseUrl = 'https://services.leadconnectorhq.com';
  }
  private async headers() { return { Authorization: `Bearer ${await this.bearerToken()}`, Version: '2021-07-28', Accept: 'application/json' }; }
  private locationId(input?: any) {
    const locationId = String(input?.locationId || this.credential.locationId || this.credential.metadata?.locationId || '');
    if (!locationId) throw new Error('HighLevel locationId is required');
    return locationId;
  }
  async health() {
    const response = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/locations/${encodeURIComponent(this.locationId())}`, headers: await this.headers() });
    return { ok: true, account: response.data };
  }
  async getContact(id: string) {
    return (await this.transport.request({ method: 'GET', url: `${this.baseUrl}/contacts/${encodeURIComponent(id)}`, headers: await this.headers() })).data;
  }
  async upsertContact(contact: ContactInput) {
    const data = { ...contact.properties, email: contact.email, phone: contact.phone, firstName: contact.firstName, lastName: contact.lastName, name: contact.name, locationId: this.locationId(contact) };
    Object.keys(data).forEach(key => data[key as keyof typeof data] === undefined && delete data[key as keyof typeof data]);
    return (await this.transport.request({ method: 'POST', url: `${this.baseUrl}/contacts/upsert`, headers: await this.headers(), data })).data;
  }
  async listContactsPage(cursor?: string, limit = 100): Promise<ContactPage> {
    let parsed: any = {};
    if (cursor) { try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new Error('Invalid HighLevel contact cursor'); } }
    const params: Record<string, any> = { locationId: this.locationId(), limit: Math.min(100, Math.max(1, limit)) };
    if (parsed.startAfter) params.startAfter = parsed.startAfter;
    if (parsed.startAfterId) params.startAfterId = parsed.startAfterId;
    const response: any = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/contacts/`, headers: await this.headers(), params });
    const rows = response.data?.contacts || response.data?.data || [];
    const contacts = rows.map((item: any) => ({ id: String(item.id || ''), email: item.email, phone: item.phone, firstName: item.firstName, lastName: item.lastName, name: item.name }));
    const meta = response.data?.meta || {};
    const next = meta.startAfterId ? Buffer.from(JSON.stringify({ startAfter: meta.startAfter, startAfterId: meta.startAfterId })).toString('base64url') : undefined;
    return { contacts, nextCursor: next && next !== cursor ? next : undefined };
  }
  async listWorkflows(): Promise<ExternalWorkflow[]> {
    const response: any = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/workflows/`, headers: await this.headers(), params: { locationId: this.locationId() } });
    return (response.data?.workflows || response.data?.data || []).map((item: any) => ({ id: String(item.id), name: String(item.name || item.id), status: item.status, updatedAt: item.updatedAt, raw: item }));
  }
  async execute(operation: string, input: any) {
    if (operation === 'contact.upsert') return this.upsertContact(input);
    if (operation === 'contact.get') return this.getContact(String(input?.id || ''));
    if (operation === 'contact.update') {
      const id = String(input?.id || input?.contactId || ''); if (!id) throw new Error('contact id is required');
      const { id: _id, contactId: _contactId, ...data } = input;
      return (await this.transport.request({ method: 'PUT', url: `${this.baseUrl}/contacts/${encodeURIComponent(id)}`, headers: await this.headers(), data })).data;
    }
    if (operation === 'contact.addTag' || operation === 'contact.removeTag') {
      const contactId = String(input?.contactId || input?.id || '');
      const tags = Array.isArray(input?.tags) ? input.tags.map(String) : [String(input?.tag || input?.tagId || '')].filter(Boolean);
      if (!contactId || !tags.length) throw new Error('contactId and tags are required');
      const request = operation.endsWith('addTag')
        ? { method: 'POST' as const, url: `${this.baseUrl}/contacts/${encodeURIComponent(contactId)}/tags`, data: { tags } }
        : { method: 'DELETE' as const, url: `${this.baseUrl}/contacts/${encodeURIComponent(contactId)}/tags`, data: { tags } };
      return (await this.transport.request({ ...request, headers: await this.headers() })).data;
    }
    if (operation === 'opportunity.create') return (await this.transport.request({ method: 'POST', url: `${this.baseUrl}/opportunities/`, headers: await this.headers(), data: { ...input, locationId: input?.locationId || this.locationId(input) } })).data;
    if (operation === 'message.send') return (await this.transport.request({ method: 'POST', url: `${this.baseUrl}/conversations/messages`, headers: await this.headers(), data: input })).data;
    throw new Error(`Unsupported HighLevel operation: ${operation}`);
  }
}
