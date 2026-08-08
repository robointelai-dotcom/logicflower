import React from 'react'
import {
  addEdge, Background, Connection as FlowConnection, Controls, Edge, Handle, MiniMap, Node,
  NodeProps, Position, ReactFlow, useEdgesState, useNodesState,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { ArrowLeft, Beaker, Check, ChevronRight, Clock3, GitBranch, GripVertical, Play, Plus, Save, Settings2, Trash2, Webhook, Workflow as WorkflowIcon, Zap } from 'lucide-react'
import { Link, useNavigate, useParams } from '../router'
import { getList, getOne, send } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, Button, ConfirmDialog, Field, LoadingState, Modal, StatusBadge } from '../components/ui'
import { useAction } from '../hooks/useApi'
import type { UnknownRecord, Workflow, WorkflowNodeData } from '../types'

type FieldType = 'text' | 'number' | 'select' | 'textarea' | 'resource'
type ResourceKind = 'connection' | 'channel' | 'destination'
interface NodeField { key: string; label: string; type: FieldType; resource?: ResourceKind; providers?: string[]; placeholder?: string; hint?: string; options?: Array<{ value: string; label: string }> }
interface NodeSpec { type: string; label: string; description: string; group: 'Triggers' | 'Logic' | 'Transform' | 'Actions'; color: string; fields: NodeField[] }
interface BuilderResource { id: string; name: string; provider?: string; status?: string }
interface BuilderResources { connections: BuilderResource[]; channels: BuilderResource[]; destinations: BuilderResource[] }
interface DryRunResult {
  approvalToken: string
  approvalExpiresAt: string
  planHash: string
  impact: { nodesVisited: number; actions: number; externalActions: number; destructiveActions: number; scheduledContinuations: number; providers: string[] }
  plan: Array<{ nodeId: string; kind: string; effect: string; impact?: { provider?: string; destructive?: boolean } }>
}

const specs: NodeSpec[] = [
  { type: 'trigger.webhook', label: 'Verified webhook', description: 'Start from a signed inbound event.', group: 'Triggers', color: '#13a47b', fields: [{ key: 'event', label: 'Event name', type: 'text', placeholder: 'contact.updated' }] },
  { type: 'trigger.schedule', label: 'Schedule', description: 'Start on a validated cron schedule.', group: 'Triggers', color: '#13a47b', fields: [{ key: 'cron', label: 'Cron expression', type: 'text', placeholder: '0 9 * * 1-5', hint: 'Runs at 9:00 AM, Monday–Friday.' }, { key: 'timezone', label: 'Timezone', type: 'text', placeholder: 'Asia/Colombo' }] },
  { type: 'trigger.platform_event', label: 'Platform event', description: 'Start from a connected platform event.', group: 'Triggers', color: '#13a47b', fields: [{ key: 'connectionId', label: 'Connection', type: 'resource', resource: 'connection', providers: ['ghl', 'hubspot', 'klaviyo', 'activecampaign'] }, { key: 'event', label: 'Event', type: 'text', placeholder: 'contact.created' }] },
  { type: 'logic.condition', label: 'Condition', description: 'Branch using structured rules.', group: 'Logic', color: '#7c5ce7', fields: [{ key: 'field', label: 'Input field', type: 'text', placeholder: 'contact.country' }, { key: 'operator', label: 'Operator', type: 'select', options: [{ value: 'equals', label: 'Equals' }, { value: 'not_equals', label: 'Does not equal' }, { value: 'contains', label: 'Contains' }, { value: 'exists', label: 'Exists' }, { value: 'greater_than', label: 'Greater than' }, { value: 'less_than', label: 'Less than' }] }, { key: 'value', label: 'Comparison value', type: 'text' }] },
  { type: 'logic.delay', label: 'Wait', description: 'Pause for up to five minutes.', group: 'Logic', color: '#7c5ce7', fields: [{ key: 'ms', label: 'Duration in milliseconds', type: 'number', hint: 'Enter 0–300000 milliseconds.' }] },
  { type: 'logic.split', label: 'Weighted split', description: 'Route records by configured percentages.', group: 'Logic', color: '#7c5ce7', fields: [{ key: 'percentage', label: 'Path A percentage', type: 'number', hint: 'Enter a number from 1 to 99.' }] },
  { type: 'transform.field', label: 'Map field', description: 'Map and format one typed field.', group: 'Transform', color: '#d47a20', fields: [{ key: 'source', label: 'Source field', type: 'text' }, { key: 'target', label: 'Target field', type: 'text' }, { key: 'operation', label: 'Format', type: 'select', options: [{ value: 'copy', label: 'Copy as-is' }, { value: 'lowercase', label: 'Lowercase' }, { value: 'uppercase', label: 'Uppercase' }, { value: 'trim', label: 'Trim whitespace' }, { value: 'number', label: 'Convert to number' }, { value: 'string', label: 'Convert to text' }] }] },
  { type: 'action.contact.update', label: 'Update contact', description: 'Set an approved contact field.', group: 'Actions', color: '#3272d9', fields: [{ key: 'provider', label: 'Platform', type: 'select', options: [{ value: 'ghl', label: 'HighLevel' }, { value: 'hubspot', label: 'HubSpot' }, { value: 'klaviyo', label: 'Klaviyo' }, { value: 'activecampaign', label: 'ActiveCampaign' }] }, { key: 'connectionId', label: 'Connection', type: 'resource', resource: 'connection', providers: ['ghl', 'hubspot', 'klaviyo', 'activecampaign'] }, { key: 'field', label: 'Field', type: 'text' }, { key: 'value', label: 'Value or {{ variable }}', type: 'text' }] },
  { type: 'action.tag.add', label: 'Add HighLevel tag', description: 'Add a HighLevel tag to the record.', group: 'Actions', color: '#3272d9', fields: [{ key: 'connectionId', label: 'HighLevel connection', type: 'resource', resource: 'connection', providers: ['ghl'] }, { key: 'tag', label: 'Tag', type: 'text' }] },
  { type: 'action.tag.remove', label: 'Remove HighLevel tag', description: 'Remove a HighLevel tag from the record.', group: 'Actions', color: '#3272d9', fields: [{ key: 'connectionId', label: 'HighLevel connection', type: 'resource', resource: 'connection', providers: ['ghl'] }, { key: 'tag', label: 'Tag', type: 'text' }] },
  { type: 'action.notification', label: 'Send notification', description: 'Notify through an approved channel.', group: 'Actions', color: '#3272d9', fields: [{ key: 'channelId', label: 'Notification channel', type: 'resource', resource: 'channel' }, { key: 'subject', label: 'Subject', type: 'text' }, { key: 'message', label: 'Message or {{ variable }}', type: 'textarea' }] },
  { type: 'action.approved_webhook', label: 'Approved destination', description: 'Send to a pre-approved HTTPS destination.', group: 'Actions', color: '#3272d9', fields: [{ key: 'destinationId', label: 'Destination', type: 'resource', resource: 'destination', hint: 'Destinations are allow-listed in Settings.' }, { key: 'method', label: 'Method', type: 'select', options: [{ value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }, { value: 'PATCH', label: 'PATCH' }] }] },
  { type: 'action.ai.structured', label: 'Structured AI', description: 'Use owner-approved BYOK AI and accept structured JSON only.', group: 'Actions', color: '#3272d9', fields: [{ key: 'connectionId', label: 'Approved AI connection', type: 'resource', resource: 'connection', providers: ['openai', 'anthropic', 'googleai'], hint: 'Uses an owner-approved encrypted BYOK connection.' }, { key: 'model', label: 'Model', type: 'select', options: [{ value: 'gpt-5-mini', label: 'OpenAI · GPT-5 mini' }, { value: 'gpt-4.1-mini', label: 'OpenAI · GPT-4.1 mini' }, { value: 'gpt-4.1', label: 'OpenAI · GPT-4.1' }, { value: 'claude-haiku-4-5-20251001', label: 'Anthropic · Claude Haiku 4.5' }, { value: 'claude-sonnet-4-5-20250929', label: 'Anthropic · Claude Sonnet 4.5' }, { value: 'gemini-2.5-flash', label: 'Google · Gemini 2.5 Flash' }, { value: 'gemini-2.5-pro', label: 'Google · Gemini 2.5 Pro' }] }, { key: 'systemPrompt', label: 'System instructions', type: 'textarea' }, { key: 'promptTemplate', label: 'Prompt template', type: 'textarea', hint: 'May use approved {{ variables }} from the workflow context.' }, { key: 'outputSchema', label: 'Output JSON Schema', type: 'textarea', hint: 'A JSON object schema is required; free-form text output is rejected.' }, { key: 'saveAs', label: 'Save result as', type: 'text', placeholder: 'aiResult', hint: 'Safe workflow-state key.' }] },
]

const specByType = new Map(specs.map((spec) => [spec.type, spec]))
const allowedTypes = new Set(specs.map((spec) => spec.type))

function SafeNode({ data, selected }: NodeProps<WorkflowNodeData>) {
  const kind = String(data.kind ?? '')
  const spec = specByType.get(kind)
  const isTrigger = spec?.group === 'Triggers'
  const isBranch = kind === 'logic.condition' || kind === 'logic.split'
  const positiveHandle = kind === 'logic.split' ? 'A' : 'yes'
  const negativeHandle = kind === 'logic.split' ? 'B' : 'no'
  return <div className={`flow-node ${selected ? 'selected' : ''}`} style={{ '--node-color': spec?.color ?? '#64748b' } as React.CSSProperties}>{!isTrigger && <Handle type="target" position={Position.Left} />}<div className="flow-node-top"><span className="node-grip"><GripVertical size={14} /></span><span className="node-symbol">{isTrigger ? <Zap /> : spec?.group === 'Logic' ? <GitBranch /> : spec?.group === 'Transform' ? <Settings2 /> : <Webhook />}</span><div><strong>{data.label}</strong><small>{spec?.group ?? 'Node'}</small></div></div>{isBranch ? <><Handle type="source" id={positiveHandle} position={Position.Right} style={{ top: '38%' }} /><Handle type="source" id={negativeHandle} position={Position.Right} style={{ top: '72%' }} /></> : <Handle type="source" position={Position.Right} />}</div>
}

// ReactFlow's visual component type is deliberately separate from the executor
// kind. The server executes only the allow-listed `data.kind` value.
const nodeTypes = { safeNode: SafeNode }

function newId(prefix: string): string { return `${prefix.replace(/[^a-z]/g, '-')}-${crypto.randomUUID()}` }

function initialConfig(spec: NodeSpec): UnknownRecord {
  const config: UnknownRecord = {}
  for (const field of spec.fields) config[field.key] = field.options?.[0]?.value ?? (field.type === 'number' ? 1 : '')
  if (spec.type === 'trigger.schedule') config.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (spec.type === 'logic.split') config.percentage = 50
  if (spec.type === 'action.ai.structured') {
    config.outputSchema = '{\n  "type": "object",\n  "properties": {},\n  "required": [],\n  "additionalProperties": false\n}'
    config.saveAs = 'aiResult'
  }
  return config
}

function normalizeWorkflow(raw: Workflow): Workflow {
  const allNodes = Array.isArray(raw.nodes) ? raw.nodes : []
  const nodes = allNodes.flatMap((node) => {
    const kind = String(node.data?.kind ?? '')
    if (!allowedTypes.has(kind)) return []
    const config = node.data?.config && typeof node.data.config === 'object' && !Array.isArray(node.data.config) ? { ...node.data.config } : {}
    if (kind === 'action.ai.structured' && config.outputSchema && typeof config.outputSchema === 'object') config.outputSchema = JSON.stringify(config.outputSchema, null, 2)
    return [{ ...node, type: 'safeNode', data: { ...node.data, kind, label: node.data?.label || specByType.get(kind)?.label || kind, config } }]
  })
  const ids = new Set(nodes.map((node) => node.id))
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  return { ...raw, nodes, edges }
}

function validateStructuredAi(nodes: Node<WorkflowNodeData>[]): string[] {
  const errors: string[] = []
  for (const node of nodes) {
    if (node.data.kind !== 'action.ai.structured') continue
    const config = node.data.config && typeof node.data.config === 'object' ? node.data.config : {}
    for (const field of ['connectionId', 'model', 'promptTemplate', 'outputSchema', 'saveAs']) if (!String(config[field] ?? '').trim()) errors.push(`“${String(node.data.label)}” requires ${field}.`)
    try {
      const schema = typeof config.outputSchema === 'string' ? JSON.parse(config.outputSchema) : config.outputSchema
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) errors.push(`“${String(node.data.label)}” outputSchema must be a JSON object.`)
      else {
        const objectSchema = schema as UnknownRecord
        if (objectSchema.type !== 'object' || !objectSchema.properties || typeof objectSchema.properties !== 'object' || Array.isArray(objectSchema.properties) || objectSchema.additionalProperties !== false || !Array.isArray(objectSchema.required)) errors.push(`“${String(node.data.label)}” outputSchema must define an object with properties, required, and additionalProperties: false.`)
      }
    } catch { errors.push(`“${String(node.data.label)}” outputSchema must be valid JSON.`) }
    const saveAs = String(config.saveAs ?? '')
    // Bounded above before matching. The alternation is linear: each segment
    // must start with a character the separator cannot match, so a backtracking
    // engine has no ambiguous split to explore.
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored segments; bounded above
    if (saveAs.length > 240 || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(saveAs)) errors.push(`“${String(node.data.label)}” saveAs must be a safe workflow-state path.`)
  }
  return errors
}

function validate(nodes: Node<WorkflowNodeData>[], edges: Edge[], publishing: boolean): string[] {
  const errors: string[] = []
  if (!nodes.length) errors.push('Add at least one trigger and one action.')
  const triggers = nodes.filter((node) => specByType.get(String(node.data.kind ?? ''))?.group === 'Triggers')
  if (publishing && triggers.length !== 1) errors.push('A published workflow must have exactly one trigger.')
  if (publishing && nodes.length < 2) errors.push('A published workflow must contain at least one step after the trigger.')
  const targets = new Set(edges.map((edge) => edge.target))
  if (publishing) for (const node of nodes) if (!triggers.some((trigger) => trigger.id === node.id) && !targets.has(node.id)) errors.push(`“${String(node.data.label)}” is not connected to the workflow.`)
  const graph = new Map<string, string[]>()
  for (const node of nodes) graph.set(node.id, [])
  for (const edge of edges) graph.get(edge.source)?.push(edge.target)
  const visiting = new Set<string>(); const visited = new Set<string>()
  const cycle = (id: string): boolean => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); for (const next of graph.get(id) ?? []) if (cycle(next)) return true; visiting.delete(id); visited.add(id); return false }
  if (nodes.some((node) => cycle(node.id))) errors.push('Loops are not allowed in this workflow. Use a bounded batch operation instead.')
  errors.push(...validateStructuredAi(nodes))
  return [...new Set(errors)]
}

function canonicalConfig(node: Node<WorkflowNodeData>): UnknownRecord {
  const config = node.data.config && typeof node.data.config === 'object' ? { ...node.data.config } : {}
  if (node.data.kind === 'action.ai.structured' && typeof config.outputSchema === 'string') config.outputSchema = JSON.parse(config.outputSchema)
  return config
}

export default function WorkflowBuilderPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { session } = useAuth()
  const canEdit = ['owner', 'admin', 'operator'].includes(session?.organization?.role ?? '')
  const [workflow, setWorkflow] = React.useState<Workflow | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNodeData>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [dirty, setDirty] = React.useState(false)
  const [removedNodes, setRemovedNodes] = React.useState(0)
  const [validationErrors, setValidationErrors] = React.useState<string[]>([])
  const [testOpen, setTestOpen] = React.useState(false)
  const [testPayload, setTestPayload] = React.useState('{\n  "contactId": "sample-contact"\n}')
  const [dryRunResult, setDryRunResult] = React.useState<DryRunResult | null>(null)
  const [executionConfirmation, setExecutionConfirmation] = React.useState('')
  const [leaveOpen, setLeaveOpen] = React.useState(false)
  const [resources, setResources] = React.useState<BuilderResources>({ connections: [], channels: [], destinations: [] })
  const [resourceError, setResourceError] = React.useState<string | null>(null)
  const pendingDestination = React.useRef<string | null>(null)
  const action = useAction()

  React.useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      try {
        if (!id || id === 'new') {
          if (!canEdit) {
            setLoadError('Your organization role can review workflows but cannot create them.')
            return
          }
          const created = await send<Workflow>('post', '/workflows', { name: 'Untitled workflow', description: '', nodes: [], edges: [], status: 'draft' })
          if (active) navigate(`/workflows/${created.id}/builder`, { replace: true })
          return
        }
        const raw = await getOne<Workflow>(`/workflows/${encodeURIComponent(id)}`)
        const safe = normalizeWorkflow(raw)
        if (!active) return
        setRemovedNodes((raw.nodes?.length ?? 0) - safe.nodes.length)
        setWorkflow(safe); setNodes(safe.nodes as Node<WorkflowNodeData>[]); setEdges(safe.edges as Edge[]); setLoadError(null); setDirty(false)
      } catch (error) { if (active) setLoadError(error instanceof Error ? error.message : 'Could not load this workflow.') } finally { if (active) setLoading(false) }
    }
    void load(); return () => { active = false }
  }, [canEdit, id, navigate, setEdges, setNodes])

  React.useEffect(() => {
    let active = true
    async function loadResources() {
      const [connectionResult, channelResult, destinationResult] = await Promise.allSettled([
        getList<UnknownRecord>('/connections'),
        getList<UnknownRecord>('/notifications/channels'),
        getList<UnknownRecord>('/connections/destinations'),
      ])
      if (!active) return
      const connections = connectionResult.status === 'fulfilled' ? connectionResult.value.items.filter((item) => ['active', 'degraded'].includes(String(item.status ?? ''))).map((item) => ({ id: item.id, name: String(item.name ?? item.displayName ?? item.provider ?? 'Connection'), provider: String(item.provider ?? ''), status: String(item.status ?? '') })) : []
      const channels = channelResult.status === 'fulfilled' ? channelResult.value.items.filter((item) => item.enabled !== false).map((item) => ({ id: item.id, name: String(item.name ?? item.type ?? 'Notification channel'), status: String(item.status ?? 'active') })) : []
      const destinations = destinationResult.status === 'fulfilled' ? destinationResult.value.items.filter((item) => item.status === 'verified').map((item) => ({ id: item.id, name: `${String(item.name ?? 'Destination')} · ${String(item.hostname ?? '')}`, status: String(item.status ?? '') })) : []
      setResources({ connections, channels, destinations })
      setResourceError([connectionResult, channelResult, destinationResult].some((result) => result.status === 'rejected') ? 'Some workspace resources could not be loaded. Refresh before publishing.' : null)
    }
    void loadResources(); return () => { active = false }
  }, [session?.organization?.id])

  React.useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', listener); return () => window.removeEventListener('beforeunload', listener)
  }, [dirty])

  const selected = nodes.find((node) => node.id === selectedId) ?? null
  const markNodesChanged = React.useCallback((changes: Parameters<typeof onNodesChange>[0]) => { onNodesChange(changes); if (canEdit) setDirty(true) }, [canEdit, onNodesChange])
  const markEdgesChanged = React.useCallback((changes: Parameters<typeof onEdgesChange>[0]) => { onEdgesChange(changes); if (canEdit) setDirty(true) }, [canEdit, onEdgesChange])
  const connect = React.useCallback((connection: FlowConnection) => { if (!canEdit) return; setEdges((current) => addEdge({ ...connection, type: 'smoothstep' }, current)); setDirty(true) }, [canEdit, setEdges])
  const addNode = (spec: NodeSpec) => {
    if (!canEdit) return
    const node: Node<WorkflowNodeData> = { id: newId(spec.type), type: 'safeNode', position: { x: 120 + nodes.length * 35, y: 100 + (nodes.length % 5) * 90 }, data: { kind: spec.type, label: spec.label, description: spec.description, config: initialConfig(spec) } }
    setNodes((current) => [...current, node]); setSelectedId(node.id); setDirty(true)
  }
  const updateSelected = (updates: Partial<WorkflowNodeData>) => { if (!selected || !canEdit) return; setNodes((current) => current.map((node) => node.id === selected.id ? { ...node, data: { ...node.data, ...updates } } : node)); setDirty(true) }
  const deleteSelected = () => { if (!selected || !canEdit) return; setNodes((current) => current.filter((node) => node.id !== selected.id)); setEdges((current) => current.filter((edge) => edge.source !== selected.id && edge.target !== selected.id)); setSelectedId(null); setDirty(true) }

  const persist = async (publish = false) => {
    if (!workflow) return false
    const errors = validate(nodes, edges, publish)
    setValidationErrors(errors)
    if ((errors.length && publish) || validateStructuredAi(nodes).length) return false
    const body = { schemaVersion: 2, name: workflow.name, description: workflow.description, nodes: nodes.map((node) => ({ id: node.id, type: 'workflowNode', position: node.position, data: { ...node.data, kind: String(node.data.kind ?? ''), config: canonicalConfig(node) } })), edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle, label: edge.label })), status: publish ? 'published' : 'draft', comment: publish ? 'Published from structured builder' : 'Saved as canonical draft' }
    const updated = await action.run(() => send<Workflow>('put', `/workflows/${workflow.id}`, body), publish ? 'Workflow published.' : 'Draft saved.')
    if (!updated) return false
    setWorkflow((current) => current ? { ...current, ...updated, status: publish ? 'published' : updated.status } : current); setDirty(false); return true
  }
  const runDryTest = async () => {
    if (!workflow) return
    const aiErrors = validateStructuredAi(nodes)
    if (aiErrors.length) { setValidationErrors(aiErrors); return }
    let payload: unknown
    try { payload = JSON.parse(testPayload) } catch { action.clear(); setValidationErrors(['Test payload must be valid JSON.']); return }
    const saved = dirty ? await persist(false) : true
    if (!saved) return
    const result = await action.run(() => send<DryRunResult>('post', `/workflows/${workflow.id}/dry-run`, { payload }), 'Dry run completed. Review the exact impact before executing.')
    if (result) { setDryRunResult(result); setExecutionConfirmation('') }
  }
  const executeApprovedTest = async () => {
    if (!workflow || !dryRunResult || executionConfirmation !== 'EXECUTE') return
    let payload: unknown
    try { payload = JSON.parse(testPayload) } catch { setDryRunResult(null); setValidationErrors(['Test payload changed and is no longer valid JSON. Run the dry test again.']); return }
    const result = await action.run(() => send<{ executionId: string }>('post', `/workflows/${workflow.id}/run-test`, { payload, approvalToken: dryRunResult.approvalToken, confirmation: executionConfirmation }), 'Approved test queued.')
    if (result) { setTestOpen(false); setDryRunResult(null); setExecutionConfirmation(''); navigate('/executions') }
  }
  const closeTest = () => { setTestOpen(false); setDryRunResult(null); setExecutionConfirmation('') }
  const requestBack = () => { if (!dirty) navigate('/workflows'); else { pendingDestination.current = '/workflows'; setLeaveOpen(true) } }

  if (loading) return <div className="builder-loading"><LoadingState label="Loading workflow builder" /></div>
  if (loadError || !workflow) return <div className="narrow-page"><Alert>{loadError ?? 'Workflow not found.'}</Alert><Link className="button button-secondary" to="/workflows"><ArrowLeft size={16} />Back to workflows</Link></div>
  return <div className="builder-page">
    <header className="builder-toolbar"><div className="builder-title"><button className="icon-button" onClick={requestBack} aria-label="Back to workflows"><ArrowLeft size={19} /></button><div><input aria-label="Workflow name" value={workflow.name} disabled={!canEdit} onChange={(event) => { setWorkflow((current) => current ? { ...current, name: event.target.value } : current); setDirty(true) }} /><span><StatusBadge status={workflow.status} />{dirty ? 'Unsaved changes' : 'All changes saved'}</span></div></div><div className="builder-actions">{canEdit && <><Button onClick={() => setTestOpen(true)} disabled={!nodes.length}><Beaker size={16} />Dry run</Button><Button busy={action.loading} onClick={() => { void persist(false) }}><Save size={16} />Save draft</Button><Button variant="primary" busy={action.loading} onClick={() => { void persist(true) }}><Play size={16} />Publish</Button></>}</div></header>
    {(action.error || action.success || resourceError || removedNodes > 0 || validationErrors.length > 0) && <div className="builder-messages">{action.error && <Alert onDismiss={action.clear}>{action.error}</Alert>}{action.success && <Alert tone="success" onDismiss={action.clear}>{action.success}</Alert>}{resourceError && <Alert tone="warning">{resourceError}</Alert>}{removedNodes > 0 && <Alert tone="warning"><strong>{removedNodes} unsupported or unsafe node{removedNodes === 1 ? '' : 's'} excluded.</strong> This builder never executes arbitrary JavaScript.</Alert>}{validationErrors.length > 0 && <Alert tone="warning"><strong>Review before publishing:</strong><ul>{validationErrors.map((error) => <li key={error}>{error}</li>)}</ul></Alert>}</div>}
    <div className="builder-workspace">
      <aside className="node-palette"><div className="panel-heading"><div><h2>Add a step</h2><p>Only approved structured nodes</p></div></div>{(['Triggers', 'Logic', 'Transform', 'Actions'] as const).map((group) => <section key={group}><h3>{group}</h3>{specs.filter((spec) => spec.group === group).map((spec) => <button key={spec.type} disabled={!canEdit} onClick={() => addNode(spec)}><span style={{ background: spec.color }}><Plus size={14} /></span><div><strong>{spec.label}</strong><small>{spec.description}</small></div><ChevronRight size={15} /></button>)}</section>)}</aside>
      <div className="flow-canvas"><ReactFlow nodes={nodes} edges={edges} onNodesChange={markNodesChanged} onEdgesChange={markEdgesChanged} onConnect={connect} onNodeClick={(_, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId(null)} nodeTypes={nodeTypes} fitView minZoom={0.25} maxZoom={1.75} nodesDraggable={canEdit} nodesConnectable={canEdit} deleteKeyCode={canEdit ? ['Backspace', 'Delete'] : null} proOptions={{ hideAttribution: true }}><Background color="#cad5df" gap={24} size={1} /><MiniMap nodeColor={(node) => specByType.get(String(node.data.kind ?? ''))?.color ?? '#64748b'} maskColor="rgba(244, 248, 247, .7)" /><Controls showInteractive={false} /></ReactFlow>{!nodes.length && <div className="canvas-empty"><span><WorkflowIcon /></span><h2>Build your workflow</h2><p>Add a verified trigger, then connect structured logic and actions.</p></div>}</div>
      <aside className="node-inspector"><div className="panel-heading"><div><h2>Configuration</h2><p>{selected ? 'Structured values only' : 'Select a node to edit it'}</p></div>{selected && canEdit && <button className="icon-button danger-hover" onClick={deleteSelected} aria-label="Delete selected node"><Trash2 size={17} /></button>}</div>{selected ? <Inspector node={selected} onChange={updateSelected} readOnly={!canEdit} resources={resources} /> : <div className="inspector-empty"><Settings2 size={28} /><p>Select any step on the canvas to review its configuration.</p></div>}</aside>
    </div>
    <Modal open={testOpen} title={dryRunResult ? 'Review approved execution' : 'Run a safe dry test'} description={dryRunResult ? 'This one-time approval is bound to the saved workflow and exact payload for 15 minutes.' : 'Validates each step and calculates expected changes without writing to connected platforms.'} onClose={closeTest} footer={dryRunResult ? <><Button onClick={() => { setDryRunResult(null); setExecutionConfirmation('') }}>Edit and preview again</Button><Button variant="primary" busy={action.loading} disabled={executionConfirmation !== 'EXECUTE'} onClick={() => { void executeApprovedTest() }}><Play size={16} />Execute approved test</Button></> : <><Button onClick={closeTest}>Cancel</Button><Button variant="primary" busy={action.loading} onClick={() => { void runDryTest() }}><Beaker size={16} />Run dry test</Button></>}>
      <Field label="Sample event payload" hint="JSON only. Secrets are redacted from execution records."><textarea className="code-area" rows={dryRunResult ? 5 : 9} value={testPayload} disabled={Boolean(dryRunResult)} onChange={(event) => { setTestPayload(event.target.value); setDryRunResult(null) }} spellCheck={false} /></Field>
      {dryRunResult && <div className="form-stack"><Alert tone={dryRunResult.impact.destructiveActions ? 'warning' : 'success'}><strong>{dryRunResult.impact.destructiveActions} destructive and {dryRunResult.impact.externalActions} external action{dryRunResult.impact.externalActions === 1 ? '' : 's'}.</strong> {dryRunResult.impact.nodesVisited} nodes were evaluated{dryRunResult.impact.providers.length ? ` across ${dryRunResult.impact.providers.join(', ')}` : ''}. No write occurred during this preview.</Alert><div className="compact-list">{dryRunResult.plan.map((step) => <div key={step.nodeId}><span><code>{step.kind}</code></span><small>{step.effect}{step.impact?.destructive ? ' · changes external data' : ''}</small></div>)}</div><Field label="Execution confirmation" hint="Type EXECUTE. This approval can be used once and expires at the time shown below."><input value={executionConfirmation} onChange={(event) => setExecutionConfirmation(event.target.value)} placeholder="EXECUTE" autoComplete="off" /></Field><small><Clock3 size={13} /> Approval expires {new Date(dryRunResult.approvalExpiresAt).toLocaleTimeString()} · Plan {dryRunResult.planHash.slice(0, 12)}</small></div>}
    </Modal>
    <ConfirmDialog open={leaveOpen} title="Discard unsaved changes?" description="Your latest canvas changes have not been saved. They will be lost if you leave now." confirmLabel="Discard and leave" danger onClose={() => setLeaveOpen(false)} onConfirm={() => { setLeaveOpen(false); navigate(pendingDestination.current ?? '/workflows') }} />
  </div>
}

function Inspector({ node, onChange, readOnly, resources }: { node: Node<WorkflowNodeData>; onChange: (updates: Partial<WorkflowNodeData>) => void; readOnly: boolean; resources: BuilderResources }) {
  const kind = String(node.data.kind ?? '')
  const spec = specByType.get(kind)
  const config = node.data.config && typeof node.data.config === 'object' ? node.data.config : {}
  const setConfig = (key: string, value: string | number) => onChange({ config: { ...config, [key]: value } })
  return <div className="inspector-form"><Field label="Step name"><input value={node.data.label} disabled={readOnly} onChange={(event) => onChange({ label: event.target.value })} /></Field><div className="node-type-summary"><span style={{ background: spec?.color }} />{spec?.label}<small>{kind}</small></div>{spec?.fields.map((field) => {
    let resourceOptions: BuilderResource[] = []
    if (field.resource === 'connection') resourceOptions = resources.connections.filter((item) => (!field.providers?.length || field.providers.includes(String(item.provider))) && (field.key !== 'connectionId' || !config.provider || item.provider === config.provider || kind !== 'action.contact.update'))
    else if (field.resource === 'channel') resourceOptions = resources.channels
    else if (field.resource === 'destination') resourceOptions = resources.destinations
    return <Field key={field.key} label={field.label} hint={field.hint}>{field.type === 'resource' ? <select value={String(config[field.key] ?? '')} disabled={readOnly} onChange={(event) => setConfig(field.key, event.target.value)}><option value="">Select a workspace resource</option>{resourceOptions.map((item) => <option value={item.id} key={item.id}>{item.name}{item.provider ? ` · ${item.provider}` : ''}</option>)}</select> : field.type === 'select' ? <select value={String(config[field.key] ?? '')} disabled={readOnly} onChange={(event) => setConfig(field.key, event.target.value)}>{field.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select> : field.type === 'textarea' ? <textarea rows={4} value={String(config[field.key] ?? '')} disabled={readOnly} onChange={(event) => setConfig(field.key, event.target.value)} /> : <input type={field.type} value={String(config[field.key] ?? '')} min={field.key === 'percentage' ? 1 : field.key === 'ms' ? 0 : undefined} max={field.key === 'percentage' ? 99 : field.key === 'ms' ? 300000 : undefined} disabled={readOnly} placeholder={field.placeholder} onChange={(event) => setConfig(field.key, field.type === 'number' ? Number(event.target.value) : event.target.value)} />}</Field>
  }) ?? <Alert tone="warning">This node type is not supported.</Alert>}<div className="inspector-safety"><Check size={15} /><span>Schema validated · No arbitrary code</span></div></div>
}
