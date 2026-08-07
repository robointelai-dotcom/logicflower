import type { ConnectionCredentialResolver, ConnectorProvider, ConnectorTransport, PlatformConnector } from './types';
import { GhlConnector, ghlManifest } from './ghl';
import { HubSpotConnector, hubspotManifest } from './hubspot';
import { KlaviyoConnector, klaviyoManifest } from './klaviyo';
import { ActiveCampaignConnector, activeCampaignManifest } from './activeCampaign';
import { GoogleSheetsConnector, googleSheetsManifest } from './googleSheets';
import { platformConnectionCredentialResolver } from '../platformConnectionCredentialResolver';
import { AxiosConnectorTransport } from './transport';
import { PolicyConnectorTransport } from './policyTransport';
import { HttpError, problemType } from '../../http/problem';
import { canRead, canWrite, connectorReleaseReason } from './releaseState';

let credentialResolver: ConnectionCredentialResolver | undefined = platformConnectionCredentialResolver;

export function registerConnectionCredentialResolver(resolver: ConnectionCredentialResolver) { credentialResolver = resolver; }
export function getConnectionCredentialResolver() {
  if (!credentialResolver) throw new Error('Connection credential resolver has not been registered');
  return credentialResolver;
}

export const connectorManifests = [ghlManifest, hubspotManifest, klaviyoManifest, activeCampaignManifest, googleSheetsManifest];

/** Methods that mutate provider-side state. Gated by connector release policy. */
const WRITE_METHODS = new Set(['execute', 'upsertContact', 'mergeContacts', 'deleteContact']);

/**
 * Wrap a connector so that a quarantined provider cannot perform writes.
 *
 * Enforcing at the factory rather than at each call site means a new workflow
 * node or batch operation added later inherits the gate automatically, instead
 * of relying on an engineer remembering to check.
 */
function applyReleasePolicy(provider: string, connector: PlatformConnector): PlatformConnector {
  if (canWrite(provider)) return connector;
  return new Proxy(connector, {
    get(target: any, property: string | symbol, receiver: unknown) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property === 'string' && WRITE_METHODS.has(property) && typeof value === 'function') {
        return () => {
          throw new HttpError(
            451,
            'Connector write blocked',
            connectorReleaseReason(provider) || `The ${provider} connector cannot perform writes in this deployment.`,
            problemType('connector-quarantined'),
          );
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PlatformConnector;
}

export async function createConnector(input: { organizationId: string; provider: ConnectorProvider; connectionId?: string; transport?: ConnectorTransport }): Promise<PlatformConnector> {
  if (!canRead(input.provider)) {
    throw new HttpError(
      451,
      'Connector disabled',
      connectorReleaseReason(input.provider) || `The ${input.provider} connector is disabled in this deployment.`,
      problemType('connector-disabled'),
    );
  }
  const resolver = getConnectionCredentialResolver();
  const credential = await resolver.resolve({ organizationId: input.organizationId, provider: input.provider, connectionId: input.connectionId });
  if (credential.organizationId !== input.organizationId) throw new Error('Credential resolver returned a cross-tenant connection');
  if (!credential.connectionId) throw new Error('Credential resolver returned a connection without an identifier');
  const transport = input.transport || new PolicyConnectorTransport(new AxiosConnectorTransport(), {
    organizationId: input.organizationId,
    connectionId: credential.connectionId,
    provider: input.provider,
  });
  switch (input.provider) {
    case 'ghl': return applyReleasePolicy(input.provider, new GhlConnector(credential, resolver, transport));
    case 'hubspot': return applyReleasePolicy(input.provider, new HubSpotConnector(credential, resolver, transport));
    case 'klaviyo': return applyReleasePolicy(input.provider, new KlaviyoConnector(credential, resolver, transport));
    case 'activecampaign': return applyReleasePolicy(input.provider, new ActiveCampaignConnector(credential, resolver, transport));
    case 'google': return applyReleasePolicy(input.provider, new GoogleSheetsConnector(credential, resolver, transport));
    default: throw new Error(`Unsupported connector provider: ${input.provider}`);
  }
}

export * from './types';
