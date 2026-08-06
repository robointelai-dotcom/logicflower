export type ConnectorProvider = 'ghl' | 'hubspot' | 'klaviyo' | 'activecampaign' | 'google' | 'generic';

export interface ResolvedConnectionCredential {
  organizationId: string;
  connectionId?: string;
  provider: ConnectorProvider;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  baseUrl?: string;
  expiresAt?: Date | string;
  locationId?: string;
  metadata?: Record<string, any>;
  credentialVersion?: number;
}

export interface CredentialResolutionRequest {
  organizationId: string;
  provider: ConnectorProvider;
  connectionId?: string;
}

export interface ConnectionCredentialResolver {
  resolve(request: CredentialResolutionRequest): Promise<ResolvedConnectionCredential>;
  refresh?(credential: ResolvedConnectionCredential): Promise<ResolvedConnectionCredential>;
}

export interface ConnectorCapabilityManifest {
  provider: ConnectorProvider;
  displayName: string;
  authentication: Array<'oauth2' | 'private-api-key'>;
  capabilities: {
    contacts: Array<'read' | 'create' | 'update' | 'upsert' | 'bulk-upsert'>;
    events: Array<'read' | 'create' | 'webhook'>;
    workflows: Array<'inventory' | 'status' | 'snapshot'>;
    sheets?: Array<'read-range' | 'append-rows' | 'update-range'>;
  };
  gatedCapabilities?: { workflows?: Array<'inventory' | 'status' | 'snapshot'>; reason: string };
  limits: { defaultTimeoutMs: number; maximumBatchSize: number; };
}

export interface ConnectorRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, any>;
  data?: any;
  timeoutMs?: number;
  httpsAgent?: any;
}

export interface ConnectorResponse<T = any> { status: number; data: T; headers: Record<string, any>; }

export interface ConnectorTransport {
  request<T = any>(request: ConnectorRequest): Promise<ConnectorResponse<T>>;
}

export interface ContactInput {
  id?: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  properties?: Record<string, any>;
  locationId?: string;
}

export interface ContactScanRecord extends ContactInput { id?: string }
export interface ContactPage { contacts: ContactScanRecord[]; nextCursor?: string; }

export interface ExternalWorkflow {
  id: string;
  name: string;
  status?: string;
  updatedAt?: string;
  raw: any;
}

export interface PlatformConnector {
  readonly manifest: ConnectorCapabilityManifest;
  health(): Promise<{ ok: boolean; account?: any }>;
  getContact(id: string): Promise<any>;
  upsertContact(contact: ContactInput): Promise<any>;
  listWorkflows(): Promise<ExternalWorkflow[]>;
  listContactsPage?(cursor?: string, limit?: number): Promise<ContactPage>;
  execute(operation: string, input: any): Promise<any>;
}
