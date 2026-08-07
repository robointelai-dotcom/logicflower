import crypto from 'crypto'
import { z } from 'zod'
import { canonicalJson } from '../canonicalJson'
import { MAX_WAIT_MINUTES, assertValidQuietHours, assertValidWait, isSupportedTimeZone, type QuietHours, type WaitSpec } from './scheduleArithmetic'

/**
 * The shape of a sequence, and the rules a version must satisfy before it can
 * be published.
 *
 * Validation happens once, at publish time, and the result is frozen into an
 * immutable SequenceVersion. The scheduler therefore never has to decide what
 * to do with a malformed step three days into an enrolment; a step that reaches
 * the worker has already been proved well-formed.
 */

export const SEQUENCE_CHANNELS = ['email', 'sms', 'whatsapp'] as const
export type SequenceChannel = (typeof SEQUENCE_CHANNELS)[number]

/** Hard ceiling on steps per sequence. Bounds worst-case sends per contact. */
export const MAX_SEQUENCE_STEPS = 50
/** SMS bodies beyond this are rejected rather than silently segmented at cost. */
export const MAX_SMS_BODY_LENGTH = 1_600
export const MAX_EMAIL_BODY_LENGTH = 100_000

const waitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('immediate') }),
  z.object({ kind: z.literal('duration'), minutes: z.number().int().min(0).max(MAX_WAIT_MINUTES) }),
  z.object({
    kind: z.literal('time_of_day'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    afterMinutes: z.number().int().min(0).max(MAX_WAIT_MINUTES).optional(),
  }),
])

const whatsappTemplateSchema = z.object({
  name: z.string().trim().min(1).max(512),
  languageCode: z.string().trim().min(2).max(16),
  variables: z.array(z.string().max(1_024)).max(20).default([]),
})

const stepSchema = z.object({
  channel: z.enum(SEQUENCE_CHANNELS),
  wait: waitSchema,
  messagingIdentityId: z.string().trim().min(1).max(64).nullable().optional(),
  subjectTemplate: z.string().max(998).optional(),
  bodyTemplate: z.string().max(MAX_EMAIL_BODY_LENGTH).optional(),
  whatsappTemplate: whatsappTemplateSchema.optional(),
})

export const quietHoursSchema = z.object({
  enabled: z.boolean().default(false),
  startMinute: z.number().int().min(0).max(1_439).default(1_260),
  endMinute: z.number().int().min(0).max(1_439).default(480),
})

export const sequenceDefinitionSchema = z.object({
  steps: z.array(stepSchema).min(1).max(MAX_SEQUENCE_STEPS),
  exitConditions: z.object({
    onReply: z.boolean().default(true),
    onConverted: z.boolean().default(true),
    onUnsubscribed: z.boolean().default(true),
    onBounced: z.boolean().default(true),
  }).default({ onReply: true, onConverted: true, onUnsubscribed: true, onBounced: true }),
  quietHours: quietHoursSchema.default({ enabled: false, startMinute: 1_260, endMinute: 480 }),
  defaultTimeZone: z.string().trim().min(1).max(64).default('UTC'),
})

export type SequenceDefinitionInput = z.infer<typeof sequenceDefinitionSchema>

export interface SequenceStep {
  stepIndex: number
  channel: SequenceChannel
  wait: WaitSpec
  messagingIdentityId: string | null
  subjectTemplate?: string
  bodyTemplate?: string
  whatsappTemplate?: { name: string; languageCode: string; variables: string[] }
}

export interface SequenceDefinition {
  steps: SequenceStep[]
  exitConditions: { onReply: boolean; onConverted: boolean; onUnsubscribed: boolean; onBounced: boolean }
  quietHours: QuietHours
  defaultTimeZone: string
}

export class SequenceDefinitionError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`Sequence definition is invalid: ${issues.join('; ')}`)
    this.name = 'SequenceDefinitionError'
    this.issues = issues
  }
}

/**
 * Per-channel content rules.
 *
 * Separated from the zod schema because they are conditional on the channel,
 * and because each one corresponds to a specific way a send fails at the
 * provider rather than in this process — an empty SMS body is a billed request
 * that delivers nothing, and a WhatsApp step without an approved template name
 * cannot be sent outside a session window at all.
 */
function channelIssues(step: SequenceStep, position: number): string[] {
  const issues: string[] = []
  const label = `step ${position + 1}`
  const body = String(step.bodyTemplate || '').trim()

  if (step.channel === 'email') {
    if (!String(step.subjectTemplate || '').trim()) issues.push(`${label}: an email step requires a subject`)
    if (!body) issues.push(`${label}: an email step requires a body`)
  }
  if (step.channel === 'sms') {
    if (!body) issues.push(`${label}: an SMS step requires a body`)
    if (body.length > MAX_SMS_BODY_LENGTH) issues.push(`${label}: an SMS body cannot exceed ${MAX_SMS_BODY_LENGTH} characters`)
    if (step.subjectTemplate) issues.push(`${label}: an SMS step cannot carry a subject`)
  }
  if (step.channel === 'whatsapp') {
    if (!step.whatsappTemplate?.name) issues.push(`${label}: a WhatsApp step requires an approved template name`)
    if (!step.whatsappTemplate?.languageCode) issues.push(`${label}: a WhatsApp step requires a template language code`)
  }
  return issues
}

/**
 * Validate and canonicalise a definition.
 *
 * Step indices are assigned here from array position rather than accepted from
 * the caller. An index supplied by a client is an index that can arrive
 * duplicated or with a gap, and both corrupt the scheduler's notion of "the
 * next step".
 */
export function canonicaliseSequenceDefinition(input: unknown): SequenceDefinition {
  const parsed = sequenceDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    throw new SequenceDefinitionError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'definition'}: ${issue.message}`))
  }
  const value = parsed.data
  const issues: string[] = []

  if (!isSupportedTimeZone(value.defaultTimeZone)) {
    issues.push(`defaultTimeZone: "${value.defaultTimeZone}" is not a timezone this runtime can resolve`)
  }
  try {
    assertValidQuietHours(value.quietHours)
    if (value.quietHours.enabled && value.quietHours.startMinute === value.quietHours.endMinute) {
      issues.push('quietHours: start and end cannot be identical; that configuration either blocks nothing or blocks everything')
    }
  } catch (error: any) {
    issues.push(`quietHours: ${error?.message || 'invalid'}`)
  }

  const steps: SequenceStep[] = value.steps.map((step, position) => ({
    stepIndex: position,
    channel: step.channel,
    wait: step.wait as WaitSpec,
    messagingIdentityId: step.messagingIdentityId ?? null,
    ...(step.subjectTemplate ? { subjectTemplate: step.subjectTemplate } : {}),
    ...(step.bodyTemplate ? { bodyTemplate: step.bodyTemplate } : {}),
    ...(step.whatsappTemplate ? { whatsappTemplate: { ...step.whatsappTemplate, variables: step.whatsappTemplate.variables ?? [] } } : {}),
  }))

  steps.forEach((step, position) => {
    try { assertValidWait(step.wait) } catch (error: any) { issues.push(`step ${position + 1}: ${error?.message || 'invalid wait'}`) }
    issues.push(...channelIssues(step, position))
  })

  // A first step that waits until a local time of day is legitimate; a first
  // step with a multi-day duration usually means the author intended a delay
  // from an event that has not happened yet, so it is surfaced rather than run.
  const firstStep = steps[0]
  if (firstStep && firstStep.wait.kind === 'duration' && firstStep.wait.minutes > 30 * 24 * 60) {
    issues.push('step 1: a first-step wait longer than 30 days is almost certainly a configuration error')
  }

  if (issues.length) throw new SequenceDefinitionError(issues)

  return {
    steps,
    exitConditions: value.exitConditions,
    quietHours: value.quietHours,
    defaultTimeZone: value.defaultTimeZone,
  }
}

/**
 * Stable hash of the executable content of a version.
 *
 * Excludes timestamps, authorship and identifiers so that republishing an
 * unchanged definition produces the same hash — which is what lets an operator
 * answer "did the content this contact received actually change?" without
 * diffing two documents by eye.
 */
export function sequenceDefinitionHash(definition: SequenceDefinition): string {
  return crypto.createHash('sha256').update(canonicalJson({
    steps: definition.steps,
    exitConditions: definition.exitConditions,
    quietHours: definition.quietHours,
    defaultTimeZone: definition.defaultTimeZone,
  })).digest('hex')
}
