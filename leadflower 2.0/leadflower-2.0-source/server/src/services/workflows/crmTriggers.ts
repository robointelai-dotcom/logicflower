import crypto from 'crypto'
import Workflow from '../../models/Workflow'
import WorkflowVersion from '../../models/WorkflowVersion'
import pino from '../../logger'
import { workflowQueue } from '../../queue'

/**
 * Native CRM triggers.
 *
 * It was always odd that a workflow could start from a HighLevel contact being
 * created but not from one created here. These close that: an event in this
 * system's own CRM starts a workflow directly, with no external call and no
 * per-action fee.
 *
 * TWO PROPERTIES THAT MATTER MORE THAN THE FEATURE
 *
 * Loop protection. A workflow that adds a tag can start a workflow that adds a
 * tag. Without a bound, two workflows that trigger each other run until the
 * queue dies, and the symptom is a machine under load rather than an obvious
 * configuration error. Every dispatch carries a depth, and dispatches raised BY
 * a workflow inherit its depth plus one.
 *
 * Never throwing into the caller. A trigger is a consequence of a CRM write,
 * not part of it. If dispatch fails, the tag was still applied and the contact
 * was still created — so failures are logged and swallowed rather than rolled
 * back into an operation the user has already been told succeeded.
 */

export const CRM_TRIGGERS = [
  'trigger.crm.contactCreated',
  'trigger.crm.contactUpdated',
  'trigger.crm.tagAdded',
  'trigger.crm.tagRemoved',
  'trigger.crm.leadScoreChanged',
  'trigger.crm.dealCreated',
  'trigger.crm.dealStageChanged',
  'trigger.crm.dealWon',
  'trigger.crm.dealLost',
  'trigger.crm.formSubmitted',
  'trigger.crm.appointmentBooked',
  'trigger.crm.appointmentCancelled',
  'trigger.crm.inboundReply',
  'trigger.crm.sequenceCompleted',
  'trigger.crm.callCompleted',
  'trigger.crm.reviewReceived',
] as const
export type CrmTrigger = (typeof CRM_TRIGGERS)[number]

/**
 * How deep a chain of workflows may run.
 *
 * Three is enough for a genuine chain — a form starts a workflow which tags a
 * contact which starts another — and short enough that a mutual pair stops
 * quickly and visibly.
 */
export const MAX_TRIGGER_DEPTH = 3

export interface CrmEvent {
  organizationId: string
  trigger: CrmTrigger
  contactId?: string
  dealId?: string
  /** Payload the workflow receives. Identifiers and small facts, never bodies. */
  data?: Record<string, unknown>
  /** Set when this event was raised by a workflow, so the chain can be bounded. */
  depth?: number
  /** Distinguishes a user action from an automated one in the audit trail. */
  actorUserId?: string
}

/**
 * Does a workflow's trigger node match this event?
 *
 * Matched on the published version, so editing a draft does not silently change
 * what a live event starts.
 */
function triggerMatches(node: any, event: CrmEvent): boolean {
  if (node?.type !== event.trigger) return false
  const filter = node?.data ?? {}

  // A tag trigger may be narrowed to specific tags. Matched on the normalised
  // key so a filter written for "vip" still fires when somebody types "VIP".
  if (event.trigger === 'trigger.crm.tagAdded' || event.trigger === 'trigger.crm.tagRemoved') {
    const wanted = (Array.isArray(filter.tags) ? filter.tags : [filter.tag]).filter(Boolean).map(String)
    if (wanted.length) {
      const actual = String(event.data?.tagKey ?? '')
      // Imported lazily: this module is loaded by CRM writes and should not pull
      // the tag service into every one of them.
      const { normaliseTagKey } = require('../crm/tags') as typeof import('../crm/tags')
      if (!wanted.some((tag: string) => normaliseTagKey(tag) === actual)) return false
    }
  }

  if (event.trigger === 'trigger.crm.dealStageChanged' && filter.stageId) {
    if (String(filter.stageId) !== String(event.data?.toStageId ?? '')) return false
  }

  if (event.trigger === 'trigger.crm.leadScoreChanged' && filter.threshold != null) {
    const score = Number(event.data?.leadScore ?? 0)
    const previous = Number(event.data?.previousLeadScore ?? 0)
    const threshold = Number(filter.threshold)
    // Fires on CROSSING the threshold, not on being above it — otherwise every
    // subsequent edit to a high-scoring contact re-triggers.
    if (!(previous < threshold && score >= threshold)) return false
  }

  return true
}

/**
 * Dispatch a CRM event to every workflow listening for it.
 *
 * Never throws. See the note at the top of this file.
 */
export async function dispatchCrmEvent(event: CrmEvent): Promise<{ started: number }> {
  const depth = event.depth ?? 0
  if (depth >= MAX_TRIGGER_DEPTH) {
    // Surfaced rather than silently stopping: a chain this deep is almost
    // always two workflows feeding each other, and the operator needs to know.
    pino.warn({ organizationId: event.organizationId, trigger: event.trigger, depth },
      'CRM trigger chain reached its depth limit; check for workflows that start one another')
    return { started: 0 }
  }

  try {
    const workflows: any[] = await Workflow.find({
      organizationId: event.organizationId,
      status: 'active',
      publishedVersion: { $ne: null },
    }).select('_id publishedVersion name').limit(200).lean()

    let started = 0
    for (const workflow of workflows) {
      const version: any = await WorkflowVersion.findOne({
        _id: workflow.publishedVersion,
        organizationId: event.organizationId,
      }).select('snapshot').lean()
      const nodes = version?.snapshot?.nodes ?? []

      const trigger = nodes.find((node: any) => triggerMatches(node, event))
      if (!trigger) continue

      /**
       * Idempotency key.
       *
       * Derived from the organisation, workflow, trigger and subject rather
       * than from a timestamp, so a CRM write retried by its own caller does
       * not start the same workflow twice.
       */
      const material = [
        event.organizationId, String(workflow._id), event.trigger,
        event.contactId ?? '', event.dealId ?? '',
        String(event.data?.tagKey ?? ''), String(event.data?.toStageId ?? ''),
      ].join(':')
      const correlationId = `crm-${crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)}`

      await workflowQueue.add('run', {
        organizationId: event.organizationId,
        workflowId: String(workflow._id),
        correlationId,
        startNodeId: String(trigger.id),
        triggerKind: event.trigger,
        payload: {
          trigger: event.trigger,
          contactId: event.contactId,
          dealId: event.dealId,
          ...event.data,
          // Carried into the run so any event this workflow raises inherits the
          // depth and the chain stays bounded.
          _triggerDepth: depth + 1,
        },
      }, {
        // The correlation id is the job id, so a CRM write retried by its own
        // caller cannot start the same workflow twice.
        jobId: correlationId,
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 1_000,
      })
      started += 1
    }

    if (started) pino.info({ organizationId: event.organizationId, trigger: event.trigger, started, depth }, 'CRM trigger dispatched')
    return { started }
  } catch (error) {
    // A trigger is a consequence of a CRM write, not part of it. The write has
    // already succeeded and the user has already been told so.
    pino.warn({ err: error, organizationId: event.organizationId, trigger: event.trigger }, 'CRM trigger dispatch failed')
    return { started: 0 }
  }
}

/** Depth carried by a workflow run, for events it raises in turn. */
export function depthFromPayload(payload: any): number {
  const depth = Number(payload?._triggerDepth ?? 0)
  return Number.isFinite(depth) && depth >= 0 ? depth : 0
}
