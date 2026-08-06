import type { ConnectionCredentialResolver, ConnectorProvider, ConnectorTransport, ResolvedConnectionCredential } from './types';
import { AxiosConnectorTransport } from './transport';

export abstract class BaseConnector {
  protected credential: ResolvedConnectionCredential;
  protected resolver: ConnectionCredentialResolver;
  protected transport: ConnectorTransport;

  constructor(credential: ResolvedConnectionCredential, resolver: ConnectionCredentialResolver, transport: ConnectorTransport = new AxiosConnectorTransport()) {
    this.credential = credential;
    this.resolver = resolver;
    this.transport = transport;
  }

  protected async bearerToken() {
    const expiry = this.credential.expiresAt ? new Date(this.credential.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
    if (expiry - Date.now() < 60_000 && this.resolver.refresh) this.credential = await this.resolver.refresh(this.credential);
    const token = this.credential.accessToken || this.credential.apiKey;
    if (!token) throw new Error(`${this.credential.provider} connection has no usable credential`);
    return token;
  }

  protected assertProvider(provider: ConnectorProvider) {
    if (this.credential.provider !== provider) throw new Error(`Expected ${provider} connection, received ${this.credential.provider}`);
  }
}
