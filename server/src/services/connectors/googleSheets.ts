import { BaseConnector } from './base';
import type { ConnectionCredentialResolver, ConnectorCapabilityManifest, ConnectorTransport, ContactInput, ExternalWorkflow, PlatformConnector, ResolvedConnectionCredential } from './types';

export const googleSheetsManifest: ConnectorCapabilityManifest = {
  provider: 'google', displayName: 'Google Sheets', authentication: ['oauth2'],
  capabilities: { contacts: [], events: [], workflows: [], sheets: ['read-range', 'append-rows', 'update-range'] },
  limits: { defaultTimeoutMs: 20_000, maximumBatchSize: 1_000 },
};

export class GoogleSheetsConnector extends BaseConnector implements PlatformConnector {
  readonly manifest = googleSheetsManifest;
  private baseUrl = 'https://sheets.googleapis.com/v4';
  constructor(credential: ResolvedConnectionCredential, resolver: ConnectionCredentialResolver, transport?: ConnectorTransport) {
    super(credential, resolver, transport); this.assertProvider('google');
  }
  private async headers() { return { Authorization: `Bearer ${await this.bearerToken()}`, 'Content-Type': 'application/json' }; }
  async health() {
    const spreadsheetId = String(this.credential.metadata?.healthSpreadsheetId || this.credential.metadata?.spreadsheetId || '');
    if (!spreadsheetId) throw new Error('Google Sheets health check requires metadata.healthSpreadsheetId or metadata.spreadsheetId');
    const response = await this.transport.request({ method: 'GET', url: `${this.baseUrl}/spreadsheets/${encodeURIComponent(spreadsheetId)}`, headers: await this.headers(), params: { fields: 'spreadsheetId,properties.title' } });
    return { ok: true, account: response.data };
  }
  async getContact(_id: string): Promise<any> { throw new Error('Google Sheets does not expose contacts'); }
  async upsertContact(_contact: ContactInput): Promise<any> { throw new Error('Google Sheets does not expose contact upsert'); }
  async listWorkflows(): Promise<ExternalWorkflow[]> { return []; }
  private requireSheet(input: any) {
    const spreadsheetId = String(input?.spreadsheetId || this.credential.metadata?.spreadsheetId || '');
    const range = String(input?.range || '');
    if (!spreadsheetId || !range) throw new Error('spreadsheetId and range are required');
    return { spreadsheetId, range };
  }
  async execute(operation: string, input: any) {
    const { spreadsheetId, range } = this.requireSheet(input);
    const encodedRange = encodeURIComponent(range);
    if (operation === 'range.read') return (await this.transport.request({ method: 'GET', url: `${this.baseUrl}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodedRange}`, headers: await this.headers(), params: { majorDimension: input.majorDimension || 'ROWS', valueRenderOption: input.valueRenderOption || 'UNFORMATTED_VALUE' } })).data;
    if (operation === 'rows.append') {
      if (!Array.isArray(input?.values)) throw new Error('values must be an array of rows');
      return (await this.transport.request({ method: 'POST', url: `${this.baseUrl}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodedRange}:append`, headers: await this.headers(), params: { valueInputOption: input.valueInputOption || 'USER_ENTERED', insertDataOption: input.insertDataOption || 'INSERT_ROWS' }, data: { range, majorDimension: 'ROWS', values: input.values } })).data;
    }
    if (operation === 'range.update') {
      if (!Array.isArray(input?.values)) throw new Error('values must be an array of rows');
      return (await this.transport.request({ method: 'PUT', url: `${this.baseUrl}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodedRange}`, headers: await this.headers(), params: { valueInputOption: input.valueInputOption || 'USER_ENTERED' }, data: { range, majorDimension: input.majorDimension || 'ROWS', values: input.values } })).data;
    }
    throw new Error(`Unsupported Google Sheets operation: ${operation}`);
  }
}
