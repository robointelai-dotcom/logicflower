import Contact from '../../models/Contact'
import SequenceEnrolment from '../../models/SequenceEnrolment'
import Task from '../../models/Task'
import TagRule from '../../models/TagRule'
import pino from '../../logger'
import { recordAudit } from '../audit'
import { enrolContact, exitEnrolment } from '../sequences/enrolmentService'
import { recordActivity } from './contactActivity'

/**
 * Tags, and the automation they drive.
 *
 * Tags are the informal classification every small business actually uses —
 * "vip", "needs-quote", "no-show", "solar-interest" — and in a CRM that charges
 * per workflow action, tagging is one of the most expensive things a business
 * does, because every tag change fires a billable workflow.
 *
 * Here it fires nothing external. A tag change runs the matching rules inside
 * this process: enrol a sequence, exit one, set a lifecycle status, raise a
 * task, apply further tags. Same capability, no per-action fee.
 *
 * NORMALISATION
 *
 * Tags are stored with the display form an operator typed, and matched on a
 * normalised key. "VIP", "vip" and "V.I.P." are one tag. Without this a rule
 * written for "vip" silently stops firing the day someone types "VIP", and
 * nobody connects the two events.
 */

export const MAX_TAGS_PER_CONTACT = 50
export const MAX_TAG_LENGTH = 64
/**
 * How deep a chain of rules may go.
 *
 * A rule that adds a tag can trigger another rule that adds a tag. Two rules
 * that add each other's tag would otherwise loop until the process dies, and
 * the failure would look like a hung request rather than a configuration error.
 */
export const MAX_RULE_DEPTH = 3

export function normaliseTagKey(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/['\u2019.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG_LENGTH)
}

/** Display form: trimmed and length-bounded, otherwise as typed. */
export function displayTag(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH)
}

/**
 * Reduce a list to one entry per normalised key.
 *
 * The first spelling wins, so a contact tagged "VIP" then "vip" keeps "VIP"
 * rather than flickering between the two on every write.
 */
export function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const tag of tags) {
    const key = normaliseTagKey(tag)
    if (!key || seen.has(key)) continue
    seen.add(key)
    output.push(displayTag(tag))
  }
  return output.slice(0, MAX_TAGS_PER_CONTACT)
}

export function hasTag(tags: readonly string[] | undefined, candidate: string): boolean {
  const key = normaliseTagKey(candidate)
  if (!key) return false
  return (tags ?? []).some((tag) => normaliseTagKey(tag) === key)
}

export interface TagChangeResult {
  added: string[]
  removed: string[]
  tags: string[]
  rulesFired: number
}

interface ApplyInput {
  organizationId: string
  contactId: string
  add?: readonly string[]
  remove?: readonly string[]
  userId?: string
  source?: string
  now?: Date
  /** Internal: guards against rules triggering each other without end. */
  depth?: number
}

/**
 * Apply tag changes and run whatever they trigger.
 *
 * Only ACTUAL changes fire rules. Re-applying a tag a contact already carries
 * is a no-op — otherwise a nightly sync that re-asserts the same tags would
 * re-enrol every contact in a sequence every night.
 */
export async function applyTagChanges(input: ApplyInput): Promise<TagChangeResult> {
  const now = input.now ?? new Date()
  const depth = input.depth ?? 0

  const contact: any = await Contact.findOne({ _id: input.contactId, organizationId: input.organizationId }).select('tags').lean()
  if (!contact) return { added: [], removed: [], tags: [], rulesFired: 0 }

  const current: string[] = Array.isArray(contact.tags) ? contact.tags : []
  const currentKeys = new Set(current.map(normaliseTagKey))

  const added: string[] = []
  for (const tag of input.add ?? []) {
    const key = normaliseTagKey(tag)
    if (!key || currentKeys.has(key)) continue
    currentKeys.add(key)
    added.push(displayTag(tag))
  }

  const removeKeys = new Set((input.remove ?? []).map(normaliseTagKey).filter(Boolean))
  const removed = current.filter((tag) => removeKeys.has(normaliseTagKey(tag)))

  if (!added.length && !removed.length) {
    return { added: [], removed: [], tags: current, rulesFired: 0 }
  }

  const next = dedupeTags([...current.filter((tag) => !removeKeys.has(normaliseTagKey(tag))), ...added])
  await Contact.updateOne({ _id: input.contactId, organizationId: input.organizationId }, { $set: { tags: next } })

  for (const tag of added) {
    await recordActivity({
      organizationId: input.organizationId, contactId: input.contactId, type: 'tag.added',
      summary: `Tagged "${tag}"`, metadata: { tag, source: input.source || 'manual' },
      actorUserId: input.userId, occurredAt: now,
    })
  }
  for (const tag of removed) {
    await recordActivity({
      organizationId: input.organizationId, contactId: input.contactId, type: 'tag.removed',
      summary: `Tag "${tag}" removed`, metadata: { tag, source: input.source || 'manual' },
      actorUserId: input.userId, occurredAt: now,
    })
  }

  let rulesFired = 0
  if (depth < MAX_RULE_DEPTH) {
    rulesFired += await runTagRules({ ...input, now, depth, tags: added, event: 'added', currentTags: next })
    rulesFired += await runTagRules({ ...input, now, depth, tags: removed, event: 'removed', currentTags: next })
  } else if (added.length || removed.length) {
    // Surfaced rather than silently stopping: a chain this deep is almost
    // always two rules feeding each other, and the operator needs to know.
    pino.warn({ organizationId: input.organizationId, contactId: input.contactId, depth },
      'tag rule chain reached its depth limit; check for rules that trigger one another')
  }

  return { added, removed, tags: next, rulesFired }
}

async function runTagRules(input: ApplyInput & {
  tags: string[]
  event: 'added' | 'removed'
  currentTags: string[]
  now: Date
  depth: number
}): Promise<number> {
  if (!input.tags.length) return 0
  const keys = [...new Set(input.tags.map(normaliseTagKey).filter(Boolean))]

  const rules: any[] = await TagRule.find({
    organizationId: input.organizationId,
    tagKey: { $in: keys },
    event: input.event,
    status: 'active',
  }).limit(50).lean()

  let fired = 0
  for (const rule of rules) {
    try {
      // Exits before enrolments, matching pipeline stage behaviour: a rule that
      // stops nurturing and starts chasing should not briefly do both.
      if (rule.exitSequenceId) {
        const active: any[] = await SequenceEnrolment.find({
          organizationId: input.organizationId,
          contactId: input.contactId,
          sequenceId: rule.exitSequenceId,
          status: 'active',
        }).select('_id').limit(20).lean()
        for (const enrolment of active) {
          await exitEnrolment({
            organizationId: input.organizationId,
            enrolmentId: String(enrolment._id),
            reason: 'manually_removed',
            userId: input.userId,
            now: input.now,
          })
        }
      }

      if (rule.enrolSequenceId) {
        await enrolContact({
          organizationId: input.organizationId,
          sequenceId: String(rule.enrolSequenceId),
          contactId: input.contactId,
          source: `tag:${rule.tagKey}`,
          userId: input.userId,
          now: input.now,
        })
      }

      if (rule.setLifecycleStatus) {
        await Contact.updateOne(
          { _id: input.contactId, organizationId: input.organizationId },
          { $set: { lifecycleStatus: rule.setLifecycleStatus } },
        )
      }

      if (rule.createTask?.title) {
        await Task.create({
          organizationId: input.organizationId,
          contactId: input.contactId,
          title: String(rule.createTask.title).slice(0, 200),
          dueAt: rule.createTask.dueInHours ? new Date(input.now.getTime() + Number(rule.createTask.dueInHours) * 3_600_000) : null,
          priority: rule.createTask.priority || 'normal',
          source: `tag:${rule.tagKey}`,
        })
      }

      if ((rule.addTags?.length || rule.removeTags?.length)) {
        await applyTagChanges({
          organizationId: input.organizationId,
          contactId: input.contactId,
          add: rule.addTags || [],
          remove: rule.removeTags || [],
          userId: input.userId,
          source: `tag-rule:${rule.tagKey}`,
          now: input.now,
          depth: input.depth + 1,
        })
      }

      await TagRule.updateOne({ _id: rule._id, organizationId: input.organizationId }, {
        $set: { lastFiredAt: input.now }, $inc: { fireCount: 1 },
      })
      fired += 1
    } catch (error) {
      // One misconfigured rule must not stop the others, and must not roll back
      // the tag change that triggered it. The tag is the fact; the rule is a
      // consequence of it.
      pino.warn({ err: error, tagRuleId: String(rule._id), organizationId: input.organizationId }, 'tag rule failed')
    }
  }

  if (fired) {
    await recordAudit({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      actorType: input.userId ? 'user' : 'system',
      action: 'crm.tag_rules_fired',
      entityType: 'Contact',
      entityId: input.contactId,
      metadata: { event: input.event, tags: input.tags, rulesFired: fired, depth: input.depth },
    })
  }
  return fired
}

/** Every tag in use, with counts, for a picker or a rule builder. */
export async function tagCatalogue(organizationId: string): Promise<Array<{ tag: string; key: string; count: number }>> {
  const rows: any[] = await Contact.aggregate([
    { $match: { organizationId, archivedAt: null } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 500 },
  ])
  // Grouped again by normalised key, because historical records may hold
  // several spellings of what is now one tag.
  const merged = new Map<string, { tag: string; key: string; count: number }>()
  for (const row of rows) {
    const key = normaliseTagKey(String(row._id))
    if (!key) continue
    const existing = merged.get(key)
    if (existing) existing.count += Number(row.count || 0)
    else merged.set(key, { tag: displayTag(String(row._id)), key, count: Number(row.count || 0) })
  }
  return [...merged.values()].sort((a, b) => b.count - a.count)
}
