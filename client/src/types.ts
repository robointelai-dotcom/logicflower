export type Identifier = string
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type UnknownRecord = Record<string, unknown>

export interface User {
  id: Identifier
  email: string
  name: string
  avatarUrl?: string
  mfaEnabled?: boolean
  platformRole?: 'user' | 'support' | 'admin' | 'owner'
}

export type OrganizationRole = 'owner' | 'admin' | 'operator' | 'viewer' | 'billing'

export interface Organization {
  id: Identifier
  name: string
  slug?: string
  role: OrganizationRole
  plan?: string
  memberCount?: number
}

export interface Session {
  user: User
  organizations: Organization[]
  organization?: Organization
  requiresMfa?: boolean
  onboardingComplete?: boolean
}

export interface Connection {
  id: Identifier
  platform: string
  displayName: string
  status: 'connected' | 'attention' | 'disconnected' | 'connecting'
  accountName?: string
  accountExternalId?: string
  scopes?: string[]
  lastSyncAt?: string
  error?: string
}

export interface WorkflowNodeData extends UnknownRecord {
  label: string
  description?: string
  config?: UnknownRecord
}

export interface WorkflowNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: WorkflowNodeData
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  label?: string
}

export interface Workflow {
  id: Identifier
  name: string
  description?: string
  status: 'draft' | 'published' | 'paused' | 'archived'
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  version?: number
  lastRunAt?: string
  updatedAt?: string
  createdAt?: string
}

export interface Execution {
  id: Identifier
  workflowId?: Identifier
  workflowName?: string
  status: 'queued' | 'waiting' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled' | 'partial'
  trigger?: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  steps?: Array<{ id?: string; nodeId?: string; name?: string; type?: string; status?: string; durationMs?: number; error?: string }>
  error?: string
  capabilities?: { retry?: boolean; cancel?: boolean; export?: boolean }
}

export interface BatchJob {
  id: Identifier
  name: string
  operation?: string
  status: 'draft' | 'uploaded' | 'previewing' | 'preview_ready' | 'awaiting_approval' | 'approved' | 'queued' | 'running' | 'paused' | 'cancel_requested' | 'completed' | 'completed_with_errors' | 'partial' | 'failed' | 'cancelled'
  total: number
  processed: number
  succeeded: number
  failed: number
  createdAt?: string
  preview?: { affected: number; unchanged: number; invalid: number; warnings?: string[] }
  previewHash?: string
  rollbackAvailable?: boolean
}

export interface Incident {
  id: Identifier
  title: string
  severity: 'critical' | 'high' | 'medium' | 'warning' | 'low' | 'info'
  status: 'open' | 'acknowledged' | 'resolved'
  source?: string
  message?: string
  createdAt?: string
  resolvedAt?: string
}

export interface VaultSnapshot {
  id: Identifier
  resourceName: string
  platform?: string
  version: number
  changeType?: string
  createdAt?: string
  createdBy?: string
  hash?: string
}

export interface NotificationChannel {
  id: Identifier
  name: string
  type: 'email' | 'slack' | 'webhook'
  enabled: boolean
  verified?: boolean
  destinationMasked?: string
  events?: string[]
  minimumSeverity?: 'info' | 'warning' | 'critical'
}

export interface AuditEvent {
  id: Identifier
  action: string
  actorName?: string
  actorEmail?: string
  entity?: string
  entityId?: string
  ipAddress?: string
  createdAt?: string
  metadata?: UnknownRecord
}

export interface UsageMetric {
  key: string
  label: string
  used: number
  limit?: number | null
  unit?: string
}

export interface Plan {
  id: string
  name: string
  price?: number
  currency?: string
  interval?: string
  description?: string
  features?: string[]
  current?: boolean
  enabled?: boolean
}

export interface PageResult<T> {
  items: T[]
  total: number
  nextCursor?: string
}
