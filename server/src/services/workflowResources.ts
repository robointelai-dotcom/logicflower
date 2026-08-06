import { Types } from 'mongoose'
import AiConnectionConsent from '../models/AiConnectionConsent'
import Destination from '../models/Destination'
import NotificationChannel from '../models/NotificationChannel'
import PlatformConnection, { PlatformProvider } from '../models/PlatformConnection'
import { HttpError } from '../http/problem'
import { aiProviderForModel } from './aiPolicy'

type ConnectionRequirement = { id: string; providers?: PlatformProvider[]; nodeId: string; kind: string; aiConsent?: boolean }

function expectedProviders(kind: string, config: any): PlatformProvider[] | undefined {
  if (kind.startsWith('action.ghl.') || kind.startsWith('trigger.ghl.') || kind === 'action.tag.add' || kind === 'action.tag.remove') return ['ghl']
  if (kind.startsWith('action.hubspot.') || kind.startsWith('trigger.hubspot.')) return ['hubspot']
  if (kind.startsWith('action.klaviyo.') || kind.startsWith('trigger.klaviyo.')) return ['klaviyo']
  if (kind.startsWith('action.activecampaign.') || kind.startsWith('trigger.activecampaign.')) return ['activecampaign']
  if (kind.startsWith('action.googleSheets.')) return ['google']
  if (kind === 'action.contact.update') {
    const provider = String(config?.provider || '') as PlatformProvider
    return ['ghl', 'hubspot', 'klaviyo', 'activecampaign'].includes(provider) ? [provider] : ['ghl', 'hubspot', 'klaviyo', 'activecampaign']
  }
  if (kind === 'action.ai.structured') {
    const provider = aiProviderForModel(String(config?.model || ''))
    return provider ? [provider] : ['openai', 'anthropic', 'googleai']
  }
  return undefined
}

function requiresConnection(kind: string): boolean {
  return kind === 'trigger.platform_event' || kind === 'action.contact.update' || kind === 'action.tag.add' || kind === 'action.tag.remove' ||
    kind === 'action.ai.structured' || /^(action|trigger)\.(ghl|hubspot|klaviyo|activecampaign)\./.test(kind) || kind.startsWith('action.googleSheets.')
}

export async function assertWorkflowResources(input: {
  organizationId: string
  workflow: any
  requireOperational?: boolean
}): Promise<void> {
  const nodes = Array.isArray(input.workflow?.nodes) ? input.workflow.nodes : []
  const connections: ConnectionRequirement[] = []
  const destinations: Array<{ id: string; nodeId: string }> = []
  const channels: Array<{ id: string; nodeId: string }> = []
  for (const node of nodes) {
    const nodeId = String(node?.id || '')
    const kind = String(node?.data?.kind || '')
    const config = node?.data?.config || {}
    if (requiresConnection(kind)) {
      const id = String(config.connectionId || '')
      if (!Types.ObjectId.isValid(id)) throw new HttpError(422, 'Invalid workflow resource', `Node ${nodeId} requires a valid connection reference`)
      connections.push({ id, providers: expectedProviders(kind, config), nodeId, kind, aiConsent: kind === 'action.ai.structured' })
    }
    if (kind === 'action.approved_webhook') {
      const id = String(config.destinationId || '')
      if (!Types.ObjectId.isValid(id)) throw new HttpError(422, 'Invalid workflow resource', `Node ${nodeId} requires a valid destination reference`)
      destinations.push({ id, nodeId })
    }
    if (kind === 'action.notification') {
      const id = String(config.channelId || '')
      if (!Types.ObjectId.isValid(id)) throw new HttpError(422, 'Invalid workflow resource', `Node ${nodeId} requires a valid notification channel reference`)
      channels.push({ id, nodeId })
    }
  }

  const connectionRows: any[] = connections.length ? await PlatformConnection.find({
    _id: { $in: connections.map((item) => item.id) }, organizationId: input.organizationId,
    status: input.requireOperational ? { $in: ['active', 'degraded'] } : { $in: ['pending', 'active', 'degraded', 'error'] },
  }).select('_id provider status').lean() : []
  const connectionMap = new Map(connectionRows.map((row) => [String(row._id), row]))
  for (const requirement of connections) {
    const row = connectionMap.get(requirement.id)
    if (!row || (requirement.providers && !requirement.providers.includes(row.provider))) {
      throw new HttpError(422, 'Unavailable workflow connection', `Node ${requirement.nodeId} references a connection that is unavailable, belongs to another workspace, or has the wrong provider`)
    }
  }

  if (input.requireOperational) {
    const aiIds = [...new Set(connections.filter((item) => item.aiConsent).map((item) => item.id))]
    if (aiIds.length) {
      const enabled = new Set((await AiConnectionConsent.find({
        organizationId: input.organizationId, connectionId: { $in: aiIds }, enabled: true,
      }).select('connectionId').lean()).map((row: any) => String(row.connectionId)))
      if (aiIds.some((id) => !enabled.has(id))) throw new HttpError(422, 'AI consent required', 'Every structured AI node requires active owner consent before publishing or execution')
    }
  }

  const destinationIds = destinations.map((item) => item.id)
  if (destinationIds.length) {
    const found = new Set((await Destination.find({ _id: { $in: destinationIds }, organizationId: input.organizationId, status: 'verified' }).select('_id').lean()).map((row: any) => String(row._id)))
    const missing = destinations.find((item) => !found.has(item.id))
    if (missing) throw new HttpError(422, 'Unavailable workflow destination', `Node ${missing.nodeId} requires a verified destination in this workspace`)
  }
  const channelIds = channels.map((item) => item.id)
  if (channelIds.length) {
    const query: any = { _id: { $in: channelIds }, organizationId: input.organizationId }
    if (input.requireOperational) query.enabled = true
    const found = new Set((await NotificationChannel.find(query).select('_id').lean()).map((row: any) => String(row._id)))
    const missing = channels.find((item) => !found.has(item.id))
    if (missing) throw new HttpError(422, 'Unavailable notification channel', `Node ${missing.nodeId} references an unavailable notification channel`)
  }
}
