import React from 'react'
import { AlertTriangle, BrainCircuit, CheckCircle2, ExternalLink, Link2, Plug, RefreshCw, ShieldCheck, Unplug, XCircle } from 'lucide-react'
import { useSearchParams } from '../router'
import { getList, getOne, send } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, Button, Card, ConfirmDialog, Field, Modal, PageHeader, SkeletonRows, StatusBadge } from '../components/ui'
import { useAction, useApi } from '../hooks/useApi'
import type { Connection, UnknownRecord } from '../types'
import { formatDate, titleCase } from '../utils/format'

interface CatalogItem extends UnknownRecord { id: string; platform: string; name: string; description?: string; available: boolean; auth: string; capabilities?: string[]; accent?: string }
interface AiProviderCatalog extends UnknownRecord { provider: string; models: string[] }
interface AiCatalog { providers: AiProviderCatalog[]; limits: UnknownRecord; termsVersion?: string }
interface AiConsent extends UnknownRecord { id: string; connectionId: string; provider: string; enabled: boolean; allowedModels: string[]; maxInputTokens?: number; maxOutputTokens?: number; termsVersion?: string }
interface ConnectionData { connections: Connection[]; catalog: CatalogItem[]; aiCatalog: AiCatalog; aiConsents: AiConsent[] }

const defaults: CatalogItem[] = [
  { id: 'ghl', platform: 'ghl', name: 'HighLevel', description: 'Contacts, opportunities, tags, messaging and workflow events.', available: false, auth: 'oauth2', capabilities: ['OAuth', 'Webhooks', 'Batch actions'] },
  { id: 'hubspot', platform: 'hubspot', name: 'HubSpot', description: 'CRM records, lists, properties and event-based actions.', available: false, auth: 'oauth2', capabilities: ['OAuth', 'Webhooks', 'Properties'] },
  { id: 'klaviyo', platform: 'klaviyo', name: 'Klaviyo', description: 'Profiles, events, segments, campaigns and commerce data.', available: true, auth: 'oauth2_or_api_key', capabilities: ['OAuth / API key', 'Events', 'Segments'] },
  { id: 'activecampaign', platform: 'activecampaign', name: 'ActiveCampaign', description: 'Contacts, lists, campaigns and automation events.', available: true, auth: 'api_token', capabilities: ['Approved API token', 'Webhooks', 'Contacts'] },
  { id: 'google', platform: 'google', name: 'Google Sheets', description: 'Use spreadsheets as reviewed batch sources and destinations.', available: false, auth: 'oauth2', capabilities: ['OAuth', 'Read/write', 'Field mapping'] },
]

async function loadConnections(): Promise<ConnectionData> {
  const [connectionResult, catalogResult, aiCatalogResult, consentResult] = await Promise.allSettled([
    getList<Connection & UnknownRecord>('/connections', ['connections']),
    getList<CatalogItem>('/connections/catalog', ['connectors', 'catalog']),
    getOne<UnknownRecord>('/ai/catalog'),
    getList<AiConsent>('/ai/consents', ['consents']),
  ])
  if (connectionResult.status === 'rejected') throw connectionResult.reason
  const nameMap: Record<string, string> = { ghl: 'HighLevel', hubspot: 'HubSpot', klaviyo: 'Klaviyo', activecampaign: 'ActiveCampaign', google: 'Google Sheets', openai: 'OpenAI', anthropic: 'Anthropic', googleai: 'Google AI', generic: 'Generic HTTPS API' }
  const descriptionMap = Object.fromEntries(defaults.map((item) => [item.platform, item.description]))
  const connections = connectionResult.value.items.filter((item) => String(item.status ?? '') !== 'revoked').map((item) => {
    const raw = item as UnknownRecord
    const platform = String(raw.provider ?? item.platform ?? '')
    const rawStatus = String(item.status ?? 'disconnected')
    const status: Connection['status'] = rawStatus === 'active' ? 'connected' : ['degraded', 'error'].includes(rawStatus) ? 'attention' : ['pending', 'disconnecting'].includes(rawStatus) ? 'connecting' : 'disconnected'
    return { ...item, platform, displayName: String(raw.name ?? item.displayName ?? nameMap[platform] ?? platform), accountExternalId: String(raw.externalAccountId ?? item.accountExternalId ?? ''), lastSyncAt: String(raw.lastHealthyAt ?? item.lastSyncAt ?? ''), error: typeof raw.lastError === 'string' ? raw.lastError : item.error, status }
  })
  const catalog = catalogResult.status === 'fulfilled' && catalogResult.value.items.length ? catalogResult.value.items.map((item) => {
    const raw = item as UnknownRecord
    const platform = String(raw.provider ?? item.platform ?? item.id)
    const auth = String(raw.auth ?? 'credential')
    return { ...item, id: platform, platform, auth, name: nameMap[platform] ?? titleCase(platform), description: descriptionMap[platform] ?? `Secure ${nameMap[platform] ?? titleCase(platform)} connection.`, available: Boolean(raw.enabled) || auth !== 'oauth2', capabilities: auth === 'oauth2' ? ['OAuth', 'Encrypted tokens'] : ['Encrypted credential', 'Restricted scopes'] }
  }) : defaults
  const aiCatalogBody = aiCatalogResult.status === 'fulfilled' ? aiCatalogResult.value : {}
  const rawProviders = Array.isArray(aiCatalogBody.providers) ? aiCatalogBody.providers : []
  const aiCatalog: AiCatalog = {
    providers: rawProviders.map((value) => { const item = value as UnknownRecord; return { ...item, provider: String(item.provider ?? ''), models: Array.isArray(item.models) ? item.models.map(String) : [] } }).filter((item) => item.provider),
    limits: aiCatalogBody.limits && typeof aiCatalogBody.limits === 'object' && !Array.isArray(aiCatalogBody.limits) ? aiCatalogBody.limits as UnknownRecord : {},
    termsVersion: typeof aiCatalogBody.termsVersion === 'string' ? aiCatalogBody.termsVersion : undefined,
  }
  const aiConsents = consentResult.status === 'fulfilled' ? consentResult.value.items.map((item) => ({ ...item, connectionId: String(item.connectionId ?? ''), provider: String(item.provider ?? ''), enabled: Boolean(item.enabled), allowedModels: Array.isArray(item.allowedModels) ? item.allowedModels.map(String) : [] })) : []
  return { connections, catalog, aiCatalog, aiConsents }
}

function providerMonogram(platform: string): string {
  const value: Record<string, string> = { ghl: 'HL', hubspot: 'HS', klaviyo: 'K', activecampaign: 'AC', google: 'GS', openai: 'AI', anthropic: 'AN', googleai: 'GA', generic: 'API' }
  return value[platform] ?? platform.slice(0, 2).toUpperCase()
}

export default function ConnectionsPage() {
  const { session } = useAuth()
  const query = useApi(loadConnections, [])
  const action = useAction()
  const [disconnect, setDisconnect] = React.useState<Connection | null>(null)
  const [credentialProvider, setCredentialProvider] = React.useState<CatalogItem | null>(null)
  const [editingConnection, setEditingConnection] = React.useState<Connection | null>(null)
  const [consentTarget, setConsentTarget] = React.useState<Connection | null>(null)
  const [credential, setCredential] = React.useState({ name: '', externalAccountId: '', apiKey: '', baseUrl: '', webhookSecret: '', webhookHeaderName: 'x-logicflower-signature' })
  const [aiConsent, setAiConsent] = React.useState({ allowedModels: [] as string[], maxInputTokens: '8192', maxOutputTokens: '1024', acknowledgeExternalProcessing: false })
  const [params, setParams] = useSearchParams()
  const canManage = ['owner', 'admin'].includes(session?.organization?.role ?? '')
  const isAiProvider = (provider: string) => ['openai', 'anthropic', 'googleai'].includes(provider)
  React.useEffect(() => {
    if (params.get('connected') === 'true') { void query.reload(); params.delete('connected'); setParams(params, { replace: true }) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const beginOAuth = async (platform: string, connectionId?: string) => {
    const result = await action.run(() => send<{ authorizationUrl?: string; url?: string }>('post', `/connections/${encodeURIComponent(platform)}/oauth/start`, { redirectTo: '/connections?connected=true', ...(connectionId ? { connectionId } : {}) }))
    const url = result?.authorizationUrl ?? result?.url
    if (url) window.location.assign(url)
    else if (result) await query.reload()
  }
  const openCredential = (provider: CatalogItem, connection?: Connection) => { setCredentialProvider(provider); setEditingConnection(connection ?? null); setCredential({ name: connection?.displayName ?? `${provider.name} connection`, externalAccountId: connection?.accountExternalId ?? '', apiKey: '', baseUrl: '', webhookSecret: '', webhookHeaderName: 'x-logicflower-signature' }) }
  const closeCredential = () => { setCredentialProvider(null); setEditingConnection(null); setCredential({ name: '', externalAccountId: '', apiKey: '', baseUrl: '', webhookSecret: '', webhookHeaderName: 'x-logicflower-signature' }) }
  const connectProvider = (provider: CatalogItem) => { if (provider.auth === 'oauth2') void beginOAuth(provider.platform); else openCredential(provider) }
  const saveCredential = async (event: React.FormEvent) => {
    event.preventDefault(); if (!credentialProvider) return
    const credentials: UnknownRecord = {}
    if (credential.apiKey) credentials.apiKey = credential.apiKey
    if (credentialProvider.platform === 'activecampaign' && credential.baseUrl) credentials.accountBaseUrl = credential.baseUrl
    if (credentialProvider.platform === 'generic' && credential.baseUrl) credentials.baseUrl = credential.baseUrl
    if (['activecampaign', 'klaviyo'].includes(credentialProvider.platform) && credential.webhookSecret) credentials.metadata = { webhookSecret: credential.webhookSecret, ...(credentialProvider.platform === 'activecampaign' ? { webhookHeaderName: credential.webhookHeaderName } : {}) }
    const body = editingConnection ? { name: credential.name, ...(Object.keys(credentials).length ? { credentials } : {}) } : { provider: credentialProvider.platform, name: credential.name, ...(credential.externalAccountId ? { externalAccountId: credential.externalAccountId } : {}), credentials, scopes: [] }
    const result = await action.run(() => send(editingConnection ? 'patch' : 'post', editingConnection ? `/connections/${editingConnection.id}` : '/connections', body), editingConnection ? 'Connection credential updated.' : 'Connection created securely.')
    if (result !== undefined) { closeCredential(); await query.reload() }
  }
  const disconnectNow = async () => {
    if (!disconnect) return
    const complete = await action.run(async () => { await send('post', `/connections/${encodeURIComponent(disconnect.id)}/disconnect`); return true }, 'Connection removed safely.')
    if (complete) { setDisconnect(null); await query.reload() }
  }
  const openAiConsent = (connection: Connection) => {
    const existing = query.data?.aiConsents.find((item) => item.connectionId === connection.id)
    const models = query.data?.aiCatalog.providers.find((item) => item.provider === connection.platform)?.models ?? []
    setConsentTarget(connection)
    setAiConsent({
      allowedModels: (existing?.allowedModels ?? []).filter((model) => models.includes(model)),
      maxInputTokens: String(existing?.maxInputTokens ?? 8192),
      maxOutputTokens: String(existing?.maxOutputTokens ?? 1024),
      acknowledgeExternalProcessing: false,
    })
  }
  const saveAiConsent = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!consentTarget || !aiConsent.acknowledgeExternalProcessing || !aiConsent.allowedModels.length) return
    const result = await action.run(() => send('put', `/ai/consents/${consentTarget.id}`, {
      enabled: true,
      acknowledgeExternalProcessing: true,
      allowedModels: aiConsent.allowedModels,
      maxInputTokens: Number(aiConsent.maxInputTokens),
      maxOutputTokens: Number(aiConsent.maxOutputTokens),
    }), 'Structured AI processing enabled for this connection.')
    if (result !== undefined) { setConsentTarget(null); await query.reload() }
  }
  const disableAiConsent = async () => {
    if (!consentTarget) return
    const result = await action.run(() => send('put', `/ai/consents/${consentTarget.id}`, { enabled: false }), 'Structured AI processing disabled.')
    if (result !== undefined) { setConsentTarget(null); await query.reload() }
  }
  const toggleModel = (model: string) => setAiConsent((current) => ({ ...current, allowedModels: current.allowedModels.includes(model) ? current.allowedModels.filter((item) => item !== model) : [...current.allowedModels, model] }))
  const selectedAiConsent = consentTarget ? query.data?.aiConsents.find((item) => item.connectionId === consentTarget.id) : undefined
  const selectedAiPolicy = consentTarget ? query.data?.aiCatalog.providers.find((item) => item.provider === consentTarget.platform) : undefined
  const maxInputTokens = Number(query.data?.aiCatalog.limits.maxInputTokens ?? 32768)
  const maxOutputTokens = Number(query.data?.aiCatalog.limits.maxOutputTokens ?? 4096)

  return <>
    <PageHeader eyebrow="Platform access" title="Connections" description="Manage approved OAuth and encrypted API credential connections." actions={<Button onClick={() => { void query.reload() }} busy={query.loading}><RefreshCw size={16} />Refresh</Button>} />
    {action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}{action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}
    <Card className="security-note"><ShieldCheck size={21} /><div><strong>Least-privilege connection policy</strong><p>LogicFlower asks only for required scopes. Disconnecting revokes platform access and starts verified credential deletion.</p></div></Card>
    {query.loading && !query.data ? <SkeletonRows rows={5} columns={4} /> : query.error ? <Alert>{query.error}</Alert> : <div className="connection-grid">{(query.data?.catalog ?? defaults).map((provider) => {
      const matches = query.data?.connections.filter((item) => item.platform === provider.platform) ?? []
      return <Card key={provider.id} className="connection-card">
        <div className="provider-head"><span className={`provider-logo provider-${provider.platform}`}>{providerMonogram(provider.platform)}</span><div><h2>{provider.name}</h2><p>{provider.description}</p></div></div>
        <div className="capability-list">{(provider.capabilities ?? []).map((item) => <span key={item}><CheckCircle2 size={13} />{item}</span>)}</div>
        {matches.length ? <div className="connection-instances">{matches.map((connection) => {
          const consent = query.data?.aiConsents.find((item) => item.connectionId === connection.id)
          return <div key={connection.id} className="connection-instance">
            <div className="connection-info"><span className={`health-icon health-${connection.status}`}>{connection.status === 'connected' ? <CheckCircle2 /> : connection.status === 'attention' ? <AlertTriangle /> : <XCircle />}</span><div><strong>{connection.displayName || connection.accountName || provider.name}</strong><small>{connection.accountName && connection.displayName !== connection.accountName ? connection.accountName : connection.accountExternalId || 'Connected account'}</small></div><StatusBadge status={connection.status} /></div>
            {connection.error && <p className="connection-error">{connection.error}</p>}
            <div className="connection-meta"><span>Last healthy {formatDate(connection.lastSyncAt)}</span><span>{connection.scopes?.length ?? 0} approved scopes</span></div>
            {isAiProvider(connection.platform) && <div className="ai-consent-state"><span><BrainCircuit size={15} />Structured AI</span><StatusBadge status={consent?.enabled ? 'active' : 'paused'} label={consent?.enabled ? 'Owner approved' : 'Disabled by default'} /></div>}
            {canManage && <div className="connection-actions">{isAiProvider(connection.platform) && ['connected', 'attention'].includes(connection.status) && <Button size="sm" onClick={() => openAiConsent(connection)}><BrainCircuit size={14} />AI consent</Button>}{['activecampaign', 'klaviyo'].includes(connection.platform) && ['connected', 'attention'].includes(connection.status) && <Button size="sm" onClick={() => openCredential(provider, connection)}><ShieldCheck size={14} />Webhook signing</Button>}{connection.status === 'attention' && <Button size="sm" onClick={() => provider.auth === 'oauth2' ? void beginOAuth(provider.platform, connection.id) : openCredential(provider, connection)}><Link2 size={14} />Reconnect</Button>}{['connected', 'attention'].includes(connection.status) && <Button size="sm" variant="ghost" onClick={() => setDisconnect(connection)}><Unplug size={14} />Disconnect</Button>}</div>}
          </div>
        })}</div> : <div className="connection-empty"><span>{provider.available ? 'No account connected' : 'Connector not configured'}</span>{canManage && <Button variant="primary" size="sm" disabled={!provider.available} onClick={() => connectProvider(provider)}><Plug size={15} />Connect {provider.name}</Button>}</div>}
      </Card>
    })}</div>}
    <ConfirmDialog open={Boolean(disconnect)} title={`Disconnect ${disconnect?.displayName ?? 'account'}?`} description="New events and actions will stop immediately. Encrypted tokens will be revoked and deleted. Existing audit history remains." confirmLabel="Disconnect account" danger busy={action.loading} onClose={() => setDisconnect(null)} onConfirm={() => { void disconnectNow() }} />
    <Modal open={Boolean(credentialProvider)} title={`${editingConnection ? 'Update' : 'Connect'} ${credentialProvider?.name ?? 'platform'}`} description="Credentials and webhook signing secrets are sent once over HTTPS, encrypted server-side and never returned." onClose={closeCredential} footer={<><Button onClick={closeCredential}>Cancel</Button><Button variant="primary" type="submit" form="credential-form" busy={action.loading}>{editingConnection ? 'Update secure settings' : 'Create connection'}</Button></>}><form id="credential-form" className="form-stack" onSubmit={saveCredential}><Field label="Connection name" required><input value={credential.name} onChange={(event) => setCredential((current) => ({ ...current, name: event.target.value }))} required autoFocus /></Field>{credentialProvider?.platform === 'activecampaign' || credentialProvider?.platform === 'generic' ? <Field label="Public HTTPS account URL" required={!editingConnection}><input type="url" pattern="https://.*" value={credential.baseUrl} onChange={(event) => setCredential((current) => ({ ...current, baseUrl: event.target.value }))} placeholder={editingConnection ? 'Leave blank to keep the encrypted account URL' : 'https://account.example.com'} required={!editingConnection} /></Field> : null}<Field label={credentialProvider?.platform === 'activecampaign' ? 'API token' : 'API key'} hint={editingConnection ? 'Leave blank to keep the existing encrypted credential.' : 'This value is cleared immediately after submission or when this dialog closes.'} required={!editingConnection}><input type="password" autoComplete="off" value={credential.apiKey} onChange={(event) => setCredential((current) => ({ ...current, apiKey: event.target.value }))} required={!editingConnection} /></Field>{['activecampaign', 'klaviyo'].includes(credentialProvider?.platform ?? '') && <><Field label="Webhook signing secret" hint={editingConnection ? 'Enter the provider-configured secret to replace the current encrypted value.' : 'Required before provider event triggers can verify incoming webhooks.'} required={!editingConnection}><input type="password" minLength={16} maxLength={512} autoComplete="off" value={credential.webhookSecret} onChange={(event) => setCredential((current) => ({ ...current, webhookSecret: event.target.value }))} required={!editingConnection} /></Field>{credentialProvider?.platform === 'activecampaign' && <Field label="Signature header name" hint="Must match the custom header configured in ActiveCampaign."><input pattern="x-[A-Za-z0-9-]{2,80}" value={credential.webhookHeaderName} onChange={(event) => setCredential((current) => ({ ...current, webhookHeaderName: event.target.value.toLowerCase() }))} required /></Field>}</>}{!editingConnection && <Field label="External account ID" hint="Optional reference shown in the connection list."><input value={credential.externalAccountId} onChange={(event) => setCredential((current) => ({ ...current, externalAccountId: event.target.value }))} /></Field>}</form></Modal>
    <Modal open={Boolean(consentTarget)} title="Owner-approved structured AI" description={`${consentTarget?.displayName ?? 'This BYOK connection'} is disabled for AI processing until explicitly approved.`} onClose={() => setConsentTarget(null)} footer={<>{selectedAiConsent?.enabled && <Button variant="danger" busy={action.loading} onClick={() => { void disableAiConsent() }}>Disable AI</Button>}<Button onClick={() => setConsentTarget(null)}>Cancel</Button><Button variant="primary" type="submit" form="ai-consent-form" busy={action.loading} disabled={!selectedAiPolicy?.models.length || !aiConsent.allowedModels.length || !aiConsent.acknowledgeExternalProcessing}>{selectedAiConsent?.enabled ? 'Update approval' : 'Enable structured AI'}</Button></>}>
      <form id="ai-consent-form" className="form-stack" onSubmit={saveAiConsent}>
        <Alert tone="warning"><strong>External processing acknowledgement</strong><p>Workflow prompt data will be sent to {titleCase(consentTarget?.platform ?? 'the selected provider')} using your organization’s encrypted API key. Only schema-constrained JSON output is accepted; provider URLs and credentials cannot be placed in a workflow.</p></Alert>
        {selectedAiPolicy?.models.length ? <Field label="Allowed models" hint="Workflows may use only the models selected here." required><div className="model-choice-list">{selectedAiPolicy.models.map((model) => <label className="check" key={model}><input type="checkbox" checked={aiConsent.allowedModels.includes(model)} onChange={() => toggleModel(model)} />{model}</label>)}</div></Field> : <Alert>No allowlisted models are available for this provider. Refresh the page or contact a platform administrator.</Alert>}
        <div className="form-grid"><Field label="Maximum input tokens" required><input type="number" min={512} max={maxInputTokens} step={1} value={aiConsent.maxInputTokens} onChange={(event) => setAiConsent((current) => ({ ...current, maxInputTokens: event.target.value }))} required /></Field><Field label="Maximum output tokens" required><input type="number" min={1} max={maxOutputTokens} step={1} value={aiConsent.maxOutputTokens} onChange={(event) => setAiConsent((current) => ({ ...current, maxOutputTokens: event.target.value }))} required /></Field></div>
        <label className="check consent-check"><input type="checkbox" checked={aiConsent.acknowledgeExternalProcessing} onChange={(event) => setAiConsent((current) => ({ ...current, acknowledgeExternalProcessing: event.target.checked }))} /><span>I acknowledge that selected workflow data is processed by this external AI provider under our organization’s account and policies.</span></label>
        <small>Policy version {query.data?.aiCatalog.termsVersion ?? 'current'} · Disabled by default and revocable at any time.</small>
      </form>
    </Modal>
  </>
}

export function OAuthReturnPage() {
  const [params] = useSearchParams()
  const success = params.get('success') !== 'false' && !params.get('error')
  React.useEffect(() => {
    if (window.opener) { window.opener.postMessage({ type: 'logicflower:oauth', success }, window.location.origin); window.setTimeout(() => window.close(), 1200) }
  }, [success])
  return <div className="narrow-page"><Card className="oauth-result">{success ? <CheckCircle2 className="success-text" size={40} /> : <XCircle className="danger-text" size={40} />}<h1>{success ? 'Connection complete' : 'Connection failed'}</h1><p>{success ? 'The platform account is connected securely. You can return to LogicFlower.' : params.get('error_description') ?? params.get('error') ?? 'The provider did not approve the connection.'}</p><a className="button button-primary" href="/connections">Return to connections <ExternalLink size={15} /></a></Card></div>
}
