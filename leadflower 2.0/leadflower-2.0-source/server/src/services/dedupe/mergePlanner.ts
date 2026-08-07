import crypto from 'crypto'
import { canonicalJson } from '../canonicalJson'

/**
 * Duplicate resolution planning.
 *
 * The existing batch engine detects duplicates and marks rows; it never
 * resolves them. Resolution is the operation the feasibility report calls the
 * strongest first-session demonstration, and also the operation it names as the
 * primary technical risk: "a single incident that silently corrupts fifty
 * thousand contact records would end the company's reputation".
 *
 * The design consequence is that planning and execution are separated
 * completely. This module is pure: it takes records, produces a plan, and
 * touches nothing. It cannot lose data because it cannot write. Execution is a
 * separate, capability-gated, before-state-backed step that will only accept a
 * plan whose hash it has already shown to a human.
 */

export const CONFLICT_POLICIES = ['prefer_survivor', 'prefer_most_recent', 'prefer_non_empty', 'require_manual'] as const
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number]

export const SURVIVOR_RULES = ['oldest_created', 'most_recently_updated', 'most_complete'] as const
export type SurvivorRule = (typeof SURVIVOR_RULES)[number]

export interface DedupeRecord {
  id: string
  email?: string
  phone?: string
  createdAt?: Date | string
  updatedAt?: Date | string
  fields: Record<string, unknown>
}

export interface FieldResolution {
  field: string
  survivorValue: unknown
  chosenValue: unknown
  /** Values present on duplicates that differ from the chosen value. */
  discardedValues: unknown[]
  source: 'survivor' | 'duplicate' | 'unchanged'
  conflict: boolean
}

export interface MergeGroupPlan {
  groupKey: string
  matchedOn: string[]
  survivorId: string
  duplicateIds: string[]
  /** Field-level outcome for the survivor record. */
  fieldResolutions: FieldResolution[]
  /** Set when the group cannot be resolved safely and must be skipped. */
  blocked?: { reason: string; code: string }
  /** True when any field had competing non-empty values. */
  hasConflicts: boolean
}

export interface MergePlan {
  planHash: string
  policy: { survivorRule: SurvivorRule; conflictPolicy: ConflictPolicy; deleteDuplicates: boolean }
  groups: MergeGroupPlan[]
  impact: {
    groups: number
    executableGroups: number
    blockedGroups: number
    recordsUpdated: number
    recordsDeleted: number
    fieldsChanged: number
    conflictedGroups: number
  }
}

/** A group larger than this is refused: it usually indicates a bad match rule. */
export const MAX_GROUP_SIZE = 25
/** A plan larger than this is refused so a single approval cannot authorise unbounded destruction. */
export const MAX_PLAN_GROUPS = 5_000

function timestamp(value: Date | string | undefined): number {
  if (!value) return 0
  const parsed = value instanceof Date ? value : new Date(value)
  const time = parsed.getTime()
  return Number.isFinite(time) ? time : 0
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function completeness(record: DedupeRecord): number {
  return Object.values(record.fields).filter((value) => !isEmpty(value)).length
}

function normaliseIdentifier(value: string | undefined): string {
  return String(value || '').trim().toLowerCase()
}

/**
 * Group records by shared email OR shared phone, transitively.
 *
 * Transitivity matters: if A and B share an email and B and C share a phone,
 * all three are one identity. Handling them as two overlapping pairs would
 * produce two merges that fight each other.
 */
export function groupDuplicates(records: DedupeRecord[], matchFields: string[] = ['email', 'phone']): Array<{ key: string; matchedOn: string[]; members: DedupeRecord[] }> {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!
    return root
  }
  const union = (a: string, b: string) => {
    const rootA = find(a); const rootB = find(b)
    if (rootA !== rootB) parent.set(rootA, rootB)
  }
  for (const record of records) parent.set(record.id, record.id)

  const byIdentifier = new Map<string, string[]>()
  const matchedFieldsById = new Map<string, Set<string>>()
  for (const record of records) {
    for (const field of matchFields) {
      const raw = field === 'email' ? record.email : field === 'phone' ? record.phone : (record.fields[field] as string | undefined)
      const value = normaliseIdentifier(raw)
      if (!value) continue
      const key = `${field}:${value}`
      const bucket = byIdentifier.get(key) || []
      bucket.push(record.id)
      byIdentifier.set(key, bucket)
    }
  }
  for (const [key, ids] of byIdentifier) {
    if (ids.length < 2) continue
    const field = key.split(':', 1)[0]!
    for (const id of ids) {
      union(ids[0]!, id)
      const set = matchedFieldsById.get(find(id)) || new Set<string>()
      set.add(field)
      matchedFieldsById.set(find(id), set)
    }
  }

  const clusters = new Map<string, DedupeRecord[]>()
  for (const record of records) {
    const root = find(record.id)
    const bucket = clusters.get(root) || []
    bucket.push(record)
    clusters.set(root, bucket)
  }

  return [...clusters.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([root, members]) => ({
      key: crypto.createHash('sha256').update(members.map((member) => member.id).sort().join('|')).digest('hex').slice(0, 32),
      matchedOn: [...(matchedFieldsById.get(root) || new Set<string>())].sort(),
      members: members.slice().sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

function chooseSurvivor(members: DedupeRecord[], rule: SurvivorRule): DedupeRecord {
  const ranked = members.slice().sort((a, b) => {
    if (rule === 'oldest_created') {
      const diff = timestamp(a.createdAt) - timestamp(b.createdAt)
      if (diff !== 0) return diff
    } else if (rule === 'most_recently_updated') {
      const diff = timestamp(b.updatedAt) - timestamp(a.updatedAt)
      if (diff !== 0) return diff
    } else {
      const diff = completeness(b) - completeness(a)
      if (diff !== 0) return diff
    }
    // Deterministic tiebreak. Without it the same input can produce different
    // plans on different runs, and a plan hash that is not reproducible cannot
    // be meaningfully approved.
    return a.id.localeCompare(b.id)
  })
  return ranked[0]!
}

function resolveField(
  field: string,
  survivor: DedupeRecord,
  duplicates: DedupeRecord[],
  policy: ConflictPolicy,
): FieldResolution {
  const survivorValue = survivor.fields[field]
  const candidates = duplicates
    .map((record) => ({ record, value: record.fields[field] }))
    .filter((entry) => !isEmpty(entry.value))

  if (!candidates.length) {
    return { field, survivorValue, chosenValue: survivorValue, discardedValues: [], source: 'unchanged', conflict: false }
  }

  const competing = candidates.filter((entry) => canonicalJson(entry.value) !== canonicalJson(survivorValue))
  const conflict = !isEmpty(survivorValue) && competing.length > 0

  // Filling a blank on the survivor is never a conflict — nothing is lost.
  if (isEmpty(survivorValue)) {
    const best = candidates
      .slice()
      .sort((a, b) => timestamp(b.record.updatedAt) - timestamp(a.record.updatedAt) || a.record.id.localeCompare(b.record.id))[0]!
    return {
      field,
      survivorValue,
      chosenValue: best.value,
      discardedValues: candidates.filter((entry) => entry !== best).map((entry) => entry.value),
      source: 'duplicate',
      conflict: false,
    }
  }

  if (!conflict) {
    return { field, survivorValue, chosenValue: survivorValue, discardedValues: [], source: 'unchanged', conflict: false }
  }

  if (policy === 'prefer_most_recent') {
    const newest = competing
      .slice()
      .sort((a, b) => timestamp(b.record.updatedAt) - timestamp(a.record.updatedAt) || a.record.id.localeCompare(b.record.id))[0]!
    if (timestamp(newest.record.updatedAt) > timestamp(survivor.updatedAt)) {
      return {
        field,
        survivorValue,
        chosenValue: newest.value,
        discardedValues: [survivorValue, ...competing.filter((entry) => entry !== newest).map((entry) => entry.value)],
        source: 'duplicate',
        conflict: true,
      }
    }
  }

  // prefer_survivor, prefer_non_empty (survivor already non-empty) and
  // require_manual all keep the survivor's value. require_manual additionally
  // blocks the group upstream, so no silent choice is made.
  return {
    field,
    survivorValue,
    chosenValue: survivorValue,
    discardedValues: competing.map((entry) => entry.value),
    source: 'survivor',
    conflict: true,
  }
}

/**
 * Build a deterministic, reproducible merge plan.
 *
 * The same input always produces the same `planHash`. That property is what
 * makes approval meaningful: the operator approves a hash, and execution
 * refuses any plan whose hash differs from the approved one.
 */
export function buildMergePlan(
  records: DedupeRecord[],
  options: {
    survivorRule?: SurvivorRule
    conflictPolicy?: ConflictPolicy
    deleteDuplicates?: boolean
    matchFields?: string[]
    mergeFields?: string[]
  } = {},
): MergePlan {
  const survivorRule = options.survivorRule || 'oldest_created'
  const conflictPolicy = options.conflictPolicy || 'prefer_survivor'
  const deleteDuplicates = options.deleteDuplicates === true
  const clusters = groupDuplicates(records, options.matchFields || ['email', 'phone'])

  if (clusters.length > MAX_PLAN_GROUPS) {
    throw new Error(`A merge plan cannot exceed ${MAX_PLAN_GROUPS} groups; narrow the selection and run again`)
  }

  const groups: MergeGroupPlan[] = clusters.map((cluster) => {
    const survivor = chooseSurvivor(cluster.members, survivorRule)
    const duplicates = cluster.members.filter((record) => record.id !== survivor.id)

    if (cluster.members.length > MAX_GROUP_SIZE) {
      return {
        groupKey: cluster.key,
        matchedOn: cluster.matchedOn,
        survivorId: survivor.id,
        duplicateIds: duplicates.map((record) => record.id),
        fieldResolutions: [],
        hasConflicts: false,
        blocked: {
          code: 'GROUP_TOO_LARGE',
          reason: `This group contains ${cluster.members.length} records, above the safe limit of ${MAX_GROUP_SIZE}. A group this size usually means the match rule is too loose.`,
        },
      }
    }

    const fields = options.mergeFields?.length
      ? options.mergeFields
      : [...new Set(cluster.members.flatMap((record) => Object.keys(record.fields)))].sort()

    const fieldResolutions = fields.map((field) => resolveField(field, survivor, duplicates, conflictPolicy))
    const hasConflicts = fieldResolutions.some((resolution) => resolution.conflict)

    if (hasConflicts && conflictPolicy === 'require_manual') {
      return {
        groupKey: cluster.key,
        matchedOn: cluster.matchedOn,
        survivorId: survivor.id,
        duplicateIds: duplicates.map((record) => record.id),
        fieldResolutions,
        hasConflicts,
        blocked: {
          code: 'MANUAL_REVIEW_REQUIRED',
          reason: `Fields ${fieldResolutions.filter((item) => item.conflict).map((item) => item.field).join(', ')} hold competing values and the conflict policy requires manual review.`,
        },
      }
    }

    return {
      groupKey: cluster.key,
      matchedOn: cluster.matchedOn,
      survivorId: survivor.id,
      duplicateIds: duplicates.map((record) => record.id),
      fieldResolutions,
      hasConflicts,
    }
  })

  const executable = groups.filter((group) => !group.blocked)
  const impact = {
    groups: groups.length,
    executableGroups: executable.length,
    blockedGroups: groups.length - executable.length,
    recordsUpdated: executable.filter((group) => group.fieldResolutions.some((item) => item.source !== 'unchanged')).length,
    recordsDeleted: deleteDuplicates ? executable.reduce((sum, group) => sum + group.duplicateIds.length, 0) : 0,
    fieldsChanged: executable.reduce((sum, group) => sum + group.fieldResolutions.filter((item) => item.source !== 'unchanged').length, 0),
    conflictedGroups: executable.filter((group) => group.hasConflicts).length,
  }

  const planHash = crypto.createHash('sha256').update(canonicalJson({
    policy: { survivorRule, conflictPolicy, deleteDuplicates },
    groups: groups.map((group) => ({
      groupKey: group.groupKey,
      survivorId: group.survivorId,
      duplicateIds: group.duplicateIds,
      blocked: group.blocked?.code || null,
      resolutions: group.fieldResolutions
        .filter((item) => item.source !== 'unchanged')
        .map((item) => ({ field: item.field, chosen: item.chosenValue })),
    })),
  })).digest('hex')

  return { planHash, policy: { survivorRule, conflictPolicy, deleteDuplicates }, groups, impact }
}
