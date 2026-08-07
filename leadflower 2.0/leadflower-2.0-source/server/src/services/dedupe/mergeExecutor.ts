import crypto from 'crypto'
import { createConnector } from '../connectors'
import { connectionCapability } from '../capability/capabilityService'
import { canonicalJson } from '../canonicalJson'
import { storeArtifactFromBuffer } from '../artifactStore'
import { recordAudit } from '../audit'
import { redact, redactedError } from '../redaction'
import { HttpError, problemType } from '../../http/problem'
import { MergePlan } from './mergePlanner'

/**
 * Execution of a merge plan.
 *
 * Four preconditions must all hold before a single record is written. Each one
 * exists because of a specific way this operation destroys customer data:
 *
 *  1. The provider capability must be `available` from recorded evidence. A
 *     merge or delete endpoint that has not been confirmed against a live
 *     account is not a capability, and guessing at one is how a "merge" turns
 *     into an unrecoverable delete.
 *  2. The plan hash must match the hash the operator approved. Approving a
 *     preview and then executing a different plan is the failure the report's
 *     mandatory dry-run rule exists to prevent.
 *  3. Complete before-state must be captured and durably stored for every
 *     record in scope, before any write. Partial before-state means partial
 *     rollback, which is worse than none because it looks like a safety net.
 *  4. Deletion is opt-in and separate from merging. A survivor can be enriched
 *     without duplicates being removed, and that is the default.
 */

export interface MergeExecutionContext {
  organizationId: string
  connectionId: string
  provider: string
  userId?: string
  correlationId?: string
  /** The hash the operator explicitly approved. */
  approvedPlanHash: string
}

export interface MergeExecutionResult {
  planHash: string
  attemptedGroups: number
  mergedGroups: number
  deletedRecords: number
  failedGroups: Array<{ groupKey: string; error: string }>
  beforeStateArtifactId: string
  rollbackAvailable: boolean
}

/**
 * Assert that the provider is confirmed capable of the writes this plan needs.
 *
 * No connector in this release declares `contact.merge` or `contact.delete` as
 * an available capability, because no provider merge/delete contract has been
 * verified against a live account. This function therefore refuses in the
 * current build — deliberately. It is the difference between "not implemented"
 * and "implemented against an endpoint we assumed exists".
 */
export async function assertMergeCapability(context: MergeExecutionContext, plan: MergePlan): Promise<void> {
  const required: Array<'contact.merge' | 'contact.delete'> = ['contact.merge']
  if (plan.policy.deleteDuplicates) required.push('contact.delete')

  for (const capability of required) {
    const resolution = await connectionCapability(context.organizationId, context.connectionId, capability)
    if (resolution.state !== 'available') {
      throw new HttpError(
        409,
        resolution.state === 'unverified' ? 'Duplicate resolution is not verified' : 'Duplicate resolution is unavailable',
        `${resolution.reason} ${resolution.remediation || 'Confirm the provider contract through live acceptance before enabling destructive duplicate resolution.'}`.trim(),
        problemType(resolution.state === 'unverified' ? 'capability-unverified' : 'capability-unavailable'),
      )
    }
  }
}

/** Read the full current state of every record the plan touches. */
async function captureBeforeState(context: MergeExecutionContext, plan: MergePlan) {
  const connector: any = await createConnector({
    organizationId: context.organizationId,
    provider: context.provider as any,
    connectionId: context.connectionId,
  })
  if (typeof connector.getContact !== 'function') {
    throw new HttpError(409, 'Before-state capture unavailable', 'This connector cannot read individual records, so a reversible merge is not possible', problemType('before-state-unavailable'))
  }

  const ids = [...new Set(plan.groups.filter((group) => !group.blocked).flatMap((group) => [group.survivorId, ...group.duplicateIds]))]
  const captured: Record<string, unknown> = {}
  const missing: string[] = []
  for (const id of ids) {
    try {
      captured[id] = await connector.getContact(id)
    } catch {
      missing.push(id)
    }
  }
  if (missing.length) {
    throw new HttpError(
      409,
      'Incomplete before-state',
      `Before-state could not be captured for ${missing.length} of ${ids.length} records, so this merge is not reversible and will not run.`,
      problemType('before-state-incomplete'),
    )
  }
  return { captured, ids }
}

export async function executeMergePlan(context: MergeExecutionContext, plan: MergePlan): Promise<MergeExecutionResult> {
  if (plan.planHash !== context.approvedPlanHash) {
    throw new HttpError(
      409,
      'Merge plan changed',
      'The plan has changed since it was approved. Re-run the preview and approve the new plan.',
      problemType('merge-plan-mismatch'),
    )
  }

  await assertMergeCapability(context, plan)

  const executable = plan.groups.filter((group) => !group.blocked)
  if (!executable.length) {
    throw new HttpError(422, 'Nothing to merge', 'Every group in this plan is blocked and none can be executed safely.', problemType('merge-plan-empty'))
  }

  const { captured } = await captureBeforeState(context, plan)
  const artifact: any = await storeArtifactFromBuffer({
    organizationId: context.organizationId,
    kind: 'merge_before_state',
    fileName: `merge-before-state-${plan.planHash.slice(0, 12)}.json`,
    contentType: 'application/json; charset=utf-8',
    createdBy: context.userId,
    metadata: { planHash: plan.planHash, connectionId: context.connectionId, recordCount: Object.keys(captured).length },
    body: Buffer.from(JSON.stringify({
      schemaVersion: 1,
      planHash: plan.planHash,
      capturedAt: new Date().toISOString(),
      policy: plan.policy,
      records: captured,
      integrity: crypto.createHash('sha256').update(canonicalJson(captured)).digest('hex'),
    }, null, 2)),
  })

  const connector: any = await createConnector({
    organizationId: context.organizationId,
    provider: context.provider as any,
    connectionId: context.connectionId,
  })

  const failedGroups: Array<{ groupKey: string; error: string }> = []
  let mergedGroups = 0
  let deletedRecords = 0

  for (const group of executable) {
    try {
      const properties: Record<string, unknown> = {}
      for (const resolution of group.fieldResolutions) {
        if (resolution.source !== 'unchanged') properties[resolution.field] = resolution.chosenValue
      }
      if (Object.keys(properties).length) {
        await connector.execute('contact.upsert', { id: group.survivorId, properties })
      }
      if (plan.policy.deleteDuplicates) {
        for (const duplicateId of group.duplicateIds) {
          await connector.execute('contact.delete', { id: duplicateId })
          deletedRecords += 1
        }
      }
      mergedGroups += 1
    } catch (error: any) {
      // A failed group stops that group only. The before-state artifact covers
      // every record, so a partially applied plan is still fully reversible.
      failedGroups.push({ groupKey: group.groupKey, error: String(redactedError(error)?.message || 'Merge failed').slice(0, 500) })
    }
  }

  await recordAudit({
    organizationId: context.organizationId,
    action: 'dedupe.merge_executed',
    entityType: 'PlatformConnection',
    entityId: context.connectionId,
    metadata: redact({
      planHash: plan.planHash,
      attemptedGroups: executable.length,
      mergedGroups,
      deletedRecords,
      failedGroups: failedGroups.length,
      beforeStateArtifactId: String(artifact._id),
    }) as Record<string, unknown>,
  })

  return {
    planHash: plan.planHash,
    attemptedGroups: executable.length,
    mergedGroups,
    deletedRecords,
    failedGroups,
    beforeStateArtifactId: String(artifact._id),
    rollbackAvailable: true,
  }
}
