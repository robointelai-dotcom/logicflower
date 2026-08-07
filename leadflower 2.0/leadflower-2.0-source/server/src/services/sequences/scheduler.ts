import crypto from 'crypto'
import { env } from '../../env'
import pino from '../../logger'
import { providerChannelDispatcher } from './channels'
import { createMongoSequencePorts } from './mongoPorts'
import { runDueSteps, type StepOutcome } from './stepRunner'

/**
 * The sequence scheduler.
 *
 * It is a polling loop over MongoDB, not a BullMQ consumer, and that is the
 * central design decision of Phase 1. The existing `control.delay` node parks a
 * job in Redis: fine for a five-second pause, unsafe for a five-day one,
 * because a Redis restart drops every pending job and nothing anywhere records
 * that it happened. The customer discovers it when a lead goes cold.
 *
 * Here, `ScheduledStep.dueAt` in MongoDB is the source of truth. Redis is used
 * only for the provider rate limiting and circuit breaking that already exists.
 * Flush Redis entirely and this loop rebuilds its work on the next tick from
 * durable state. Nothing is lost.
 *
 * The trade is latency: a step becomes due up to one poll interval before it is
 * picked up. For a follow-up sequence measured in hours and days that is not a
 * meaningful cost, and it buys a durability property that a queue alone cannot.
 */

/** Identifies this worker in lease records. Diagnostic; correctness rests on the atomic claim. */
const LEASE_OWNER = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`

export interface SchedulerTickResult {
  claimed: number
  sent: number
  deferred: number
  exited: number
  completed: number
  failed: number
  outcomeUnknown: number
  duplicateSuppressed: number
  cancelled: number
}

function summarise(outcomes: StepOutcome[]): SchedulerTickResult {
  const result: SchedulerTickResult = {
    claimed: outcomes.length, sent: 0, deferred: 0, exited: 0, completed: 0,
    failed: 0, outcomeUnknown: 0, duplicateSuppressed: 0, cancelled: 0,
  }
  for (const outcome of outcomes) {
    if (outcome.kind === 'sent') result.sent += 1
    else if (outcome.kind === 'deferred') result.deferred += 1
    else if (outcome.kind === 'exited') result.exited += 1
    else if (outcome.kind === 'completed') result.completed += 1
    else if (outcome.kind === 'failed') result.failed += 1
    else if (outcome.kind === 'outcome_unknown') result.outcomeUnknown += 1
    else if (outcome.kind === 'duplicate_suppressed') result.duplicateSuppressed += 1
    else if (outcome.kind === 'cancelled') result.cancelled += 1
  }
  return result
}

/**
 * One pass of the scheduler.
 *
 * Bounded by `SEQUENCE_SCHEDULER_BATCH` so a large backlog is drained across
 * several ticks rather than in one long-running pass that holds leases open and
 * cannot be shut down cleanly.
 */
export async function runSchedulerTick(options: { max?: number } = {}): Promise<SchedulerTickResult> {
  const ports = createMongoSequencePorts(providerChannelDispatcher)
  const outcomes = await runDueSteps(ports, {
    leaseOwner: LEASE_OWNER,
    leaseMs: env.SEQUENCE_STEP_LEASE_MS,
    max: options.max ?? env.SEQUENCE_SCHEDULER_BATCH,
  })
  const result = summarise(outcomes)

  if (result.claimed > 0) {
    // outcomeUnknown is logged at warn, separately from failures. These are the
    // steps where a message may already have reached a real person and no
    // automatic process can resolve it; burying them in an error count is how
    // they go unactioned.
    pino.info({ ...result, leaseOwner: LEASE_OWNER }, 'sequence scheduler tick complete')
    if (result.outcomeUnknown > 0) {
      pino.warn({ outcomeUnknown: result.outcomeUnknown }, 'sequence steps with an unknown send outcome require manual reconciliation')
    }
  }
  return result
}
