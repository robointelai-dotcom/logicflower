import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import CustomFieldDefinition from '../../models/CustomFieldDefinition'
import HostedForm from '../../models/HostedForm'
import Pipeline from '../../models/Pipeline'
import Sequence from '../../models/Sequence'
import crypto from 'crypto'
import { HttpError, problemType } from '../../http/problem'
import { recordAudit } from '../audit'
import { canonicaliseStages } from '../crm/pipelines'
import { validateDefinition } from '../crm/customFields'
import { publishSequenceVersion } from '../sequences/enrolmentService'
import pino from '../../logger'

/**
 * Industry snapshots.
 *
 * A snapshot is **configuration data, not code**: custom field definitions, a
 * pipeline template, sequence templates, form templates. Adding a vertical is
 * writing a JSON file and shipping it; it is not a release with a code path per
 * industry, because that is how a "supports 12 industries" product becomes
 * twelve half-maintained special cases.
 *
 * Applied once at onboarding and **fully editable afterwards.** Nothing here
 * marks a record as snapshot-owned in a way that would let a later snapshot
 * update overwrite an operator's edits — the snapshot seeds, it does not
 * manage. `source: 'snapshot:<id>'` is provenance, not ownership.
 *
 * Applying is additive and idempotent by name: an existing custom field,
 * pipeline, sequence or form of the same name is left exactly as the operator
 * has it and reported as skipped, never overwritten.
 */

const stepSchema = z.object({
  channel: z.enum(['email', 'sms', 'whatsapp']),
  wait: z.object({
    kind: z.enum(['immediate', 'duration', 'time_of_day']),
    minutes: z.number().int().min(0).optional(),
    hour: z.number().int().min(0).max(23).optional(),
    minute: z.number().int().min(0).max(59).optional(),
    afterMinutes: z.number().int().min(0).optional(),
  }),
  subjectTemplate: z.string().max(998).optional(),
  bodyTemplate: z.string().max(20_000).optional(),
  whatsappTemplate: z.object({
    name: z.string(),
    languageCode: z.string(),
    variables: z.array(z.string()).default([]),
  }).optional(),
})

export const snapshotSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,48}$/, 'id must be lowercase, alphanumeric with dashes or underscores'),
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  version: z.number().int().min(1),
  customFields: z.array(z.object({
    key: z.string(),
    label: z.string(),
    type: z.enum(['text', 'longtext', 'number', 'boolean', 'date', 'email', 'phone', 'url', 'single_select', 'multi_select', 'timezone']),
    required: z.boolean().optional(),
    options: z.array(z.string()).optional(),
    helpText: z.string().optional(),
  })).max(60).default([]),
  pipeline: z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(1_000).optional(),
    stages: z.array(z.object({
      name: z.string().min(1).max(80),
      outcome: z.enum(['open', 'won', 'lost']).optional(),
      probability: z.number().min(0).max(100).optional(),
      taskTemplates: z.array(z.object({
        title: z.string().min(1).max(200),
        dueInHours: z.number().min(0).max(8_760).nullable().optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
      })).max(5).optional(),
    })).min(1).max(20),
  }).optional(),
  sequences: z.array(z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(1_000).optional(),
    steps: z.array(stepSchema).min(1).max(50),
    quietHours: z.object({
      enabled: z.boolean(),
      startMinute: z.number().int().min(0).max(1_439),
      endMinute: z.number().int().min(0).max(1_439),
    }).optional(),
    defaultTimeZone: z.string().optional(),
  })).max(10).default([]),
  forms: z.array(z.object({
    name: z.string().min(1).max(120),
    fields: z.array(z.object({
      field: z.string(),
      label: z.string(),
      required: z.boolean().optional(),
      placeholder: z.string().optional(),
    })).min(1).max(40),
    successMessage: z.string().max(500).optional(),
    consentText: z.string().max(2_000).optional(),
  })).max(10).default([]),
  /**
   * Notes shown to the operator when the snapshot is applied. Used for
   * vertical-specific cautions that are the operator's responsibility rather
   * than the software's.
   */
  operatorNotes: z.array(z.string().max(1_000)).max(10).default([]),
})

export type IndustrySnapshot = z.infer<typeof snapshotSchema>

/**
 * Forbidden compliance assertions.
 *
 * A snapshot is data, which means it is the easiest place for a marketing
 * claim to enter the product without passing a code review. The build
 * specification forbids asserting these certifications anywhere, and a
 * Healthcare snapshot is exactly where someone will eventually be tempted to
 * write "HIPAA-compliant intake form". This check runs at load, so a snapshot
 * carrying such a claim fails the build rather than reaching a customer.
 *
 * Compliance is a property of an operator's programme — agreements, safeguards,
 * audit — not of a JSON file.
 *
 * Implemented with normalisation plus substring matching rather than a regular
 * expression, deliberately. The first version of this used an alternation with
 * adjacent `\s*` and `[\s-]*` quantifiers, which the security ruleset correctly
 * flagged as backtracking-prone — and it runs against an entire serialised
 * snapshot, so the input is exactly the size that makes such a pattern
 * dangerous. Substring matching over a normalised haystack has no such
 * behaviour and is easier to read besides.
 */
const REGULATORY_STANDARDS = ['hipaa', 'gdpr', 'soc 2', 'pci dss', 'iso 27001', 'ccpa']
const COMPLIANCE_ASSERTIONS = ['compliant', 'compliance', 'certified', 'accredited', 'approved']

/** Lowercase, and collapse whitespace, hyphens and underscores to single spaces. */
function normaliseForClaimCheck(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, ' ')
}

export function findComplianceClaim(text: string): string | null {
  const haystack = normaliseForClaimCheck(text)
  for (const standard of REGULATORY_STANDARDS) {
    for (const assertion of COMPLIANCE_ASSERTIONS) {
      // "HIPAA compliant", "SOC 2 certified"
      if (haystack.includes(`${standard} ${assertion}`)) return `${standard} ${assertion}`
      // "certified with HIPAA", "compliant with GDPR"
      if (haystack.includes(`${assertion} with ${standard}`)) return `${assertion} with ${standard}`
      // "compliant to ISO 27001"
      if (haystack.includes(`${assertion} to ${standard}`)) return `${assertion} to ${standard}`
    }
  }
  return null
}

export function assertNoComplianceClaims(snapshot: IndustrySnapshot): void {
  const claim = findComplianceClaim(JSON.stringify(snapshot))
  if (claim) {
    throw new Error(
      `Snapshot "${snapshot.id}" asserts a compliance certification ("${claim}"). Compliance is a property of the operator's programme, not of this software. `
      + 'Describe the technical controls instead, e.g. "privacy controls suitable for handling health information, subject to your own compliance programme".',
    )
  }
}

const SNAPSHOT_DIRECTORY = join(__dirname, 'definitions')

let cache: Map<string, IndustrySnapshot> | null = null

/**
 * Load and validate every shipped snapshot.
 *
 * Validation failures throw rather than being skipped. A malformed snapshot
 * that is silently ignored looks identical to one that does not exist, and the
 * first anyone hears of it is a customer asking why onboarding produced
 * nothing.
 */
export function loadSnapshots(): Map<string, IndustrySnapshot> {
  if (cache) return cache
  const loaded = new Map<string, IndustrySnapshot>()
  let files: string[] = []
  try { files = readdirSync(SNAPSHOT_DIRECTORY).filter((file) => file.endsWith('.json')) } catch {
    pino.warn({ directory: SNAPSHOT_DIRECTORY }, 'no industry snapshot definitions directory found')
    cache = loaded
    return loaded
  }

  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(SNAPSHOT_DIRECTORY, file), 'utf8'))
    const parsed = snapshotSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`Industry snapshot ${file} is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
    }
    assertNoComplianceClaims(parsed.data)
    if (loaded.has(parsed.data.id)) throw new Error(`Duplicate industry snapshot id "${parsed.data.id}"`)
    loaded.set(parsed.data.id, parsed.data)
  }
  cache = loaded
  return loaded
}

/** Test seam. */
export function resetSnapshotCache(): void { cache = null }

export function listSnapshots() {
  return [...loadSnapshots().values()].map((snapshot) => ({
    id: snapshot.id,
    name: snapshot.name,
    description: snapshot.description,
    version: snapshot.version,
    customFieldCount: snapshot.customFields.length,
    stageCount: snapshot.pipeline?.stages.length ?? 0,
    sequenceCount: snapshot.sequences.length,
    formCount: snapshot.forms.length,
    operatorNotes: snapshot.operatorNotes,
  }))
}

export interface ApplyResult {
  snapshotId: string
  customFields: { created: string[]; skipped: string[] }
  pipeline: { created: string | null; skipped: string | null }
  sequences: { created: string[]; skipped: string[] }
  forms: { created: string[]; skipped: string[] }
  operatorNotes: string[]
}

/**
 * Apply a snapshot to an organisation.
 *
 * Additive and idempotent by name. Anything that already exists is left exactly
 * as the operator has it and reported as skipped — applying a snapshot twice,
 * or applying a second one that overlaps, must never overwrite work someone has
 * done. Sequences are created as **drafts**: a snapshot must not start sending
 * to real people the moment onboarding finishes.
 */
export async function applySnapshot(input: {
  organizationId: string
  snapshotId: string
  userId?: string
}): Promise<ApplyResult> {
  const snapshot = loadSnapshots().get(input.snapshotId)
  if (!snapshot) throw new HttpError(404, 'Snapshot not found', `No industry snapshot with id "${input.snapshotId}" is available`, problemType('snapshot-not-found'))

  const result: ApplyResult = {
    snapshotId: snapshot.id,
    customFields: { created: [], skipped: [] },
    pipeline: { created: null, skipped: null },
    sequences: { created: [], skipped: [] },
    forms: { created: [], skipped: [] },
    operatorNotes: snapshot.operatorNotes,
  }

  for (const field of snapshot.customFields) {
    const definition = validateDefinition(field)
    const existing = await CustomFieldDefinition.exists({ organizationId: input.organizationId, key: definition.key })
    if (existing) { result.customFields.skipped.push(definition.key); continue }
    await CustomFieldDefinition.create({ organizationId: input.organizationId, ...definition, source: `snapshot:${snapshot.id}`, createdBy: input.userId })
    result.customFields.created.push(definition.key)
  }

  if (snapshot.pipeline) {
    const existing = await Pipeline.exists({ organizationId: input.organizationId, name: snapshot.pipeline.name })
    if (existing) result.pipeline.skipped = snapshot.pipeline.name
    else {
      const stages = canonicaliseStages(snapshot.pipeline.stages.map((stage) => ({
        name: stage.name,
        outcome: stage.outcome,
        probability: stage.probability,
        taskTemplates: stage.taskTemplates,
      })))
      const created: any = await Pipeline.create({
        organizationId: input.organizationId,
        name: snapshot.pipeline.name,
        description: snapshot.pipeline.description,
        stages,
        source: `snapshot:${snapshot.id}`,
        createdBy: input.userId,
      })
      result.pipeline.created = String(created._id)
    }
  }

  for (const template of snapshot.sequences) {
    const existing = await Sequence.exists({ organizationId: input.organizationId, name: template.name })
    if (existing) { result.sequences.skipped.push(template.name); continue }
    const sequence: any = await Sequence.create({
      organizationId: input.organizationId,
      name: template.name,
      description: template.description,
      // Draft, never active. A snapshot must not start messaging real people
      // the moment an onboarding wizard finishes.
      status: 'draft',
      createdBy: input.userId,
    })
    await publishSequenceVersion({
      organizationId: input.organizationId,
      sequenceId: String(sequence._id),
      definition: {
        steps: template.steps,
        quietHours: template.quietHours,
        defaultTimeZone: template.defaultTimeZone || 'UTC',
      },
      userId: input.userId,
    })
    result.sequences.created.push(template.name)
  }

  for (const template of snapshot.forms) {
    const existing = await HostedForm.exists({ organizationId: input.organizationId, name: template.name })
    if (existing) { result.forms.skipped.push(template.name); continue }
    await HostedForm.create({
      organizationId: input.organizationId,
      name: template.name,
      slug: crypto.randomBytes(18).toString('base64url'),
      // Draft for the same reason sequences are: publishing a public endpoint
      // should be a deliberate act.
      status: 'draft',
      fields: template.fields.map((field, position) => ({ ...field, position })),
      successMessage: template.successMessage,
      consentText: template.consentText,
      source: `snapshot:${snapshot.id}`,
      createdBy: input.userId,
    })
    result.forms.created.push(template.name)
  }

  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    actorType: input.userId ? 'user' : 'system',
    action: 'onboarding.snapshot_applied',
    entityType: 'Organization',
    entityId: input.organizationId,
    metadata: {
      snapshotId: snapshot.id,
      version: snapshot.version,
      customFieldsCreated: result.customFields.created.length,
      sequencesCreated: result.sequences.created.length,
      formsCreated: result.forms.created.length,
      pipelineCreated: Boolean(result.pipeline.created),
    },
  })

  return result
}
