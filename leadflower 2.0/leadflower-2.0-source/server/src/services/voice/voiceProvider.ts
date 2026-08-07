import {
  defaultDndChecker,
  evaluateCallingWindow,
  type CallBlockReason,
  type DndChecker,
  type JurisdictionPolicy,
} from './callingWindows'

/**
 * The voice interface, and the gate chain that decides whether a call happens.
 *
 * TWO CONCERNS, DELIBERATELY NOT COUPLED
 *
 * The specification is explicit: telephony and the conversational layer are
 * separate. `TelephonyProvider` places and controls a call; `ConversationEngine`
 * decides what is said. Coupling them means the day the client changes voice
 * vendor — which is likely, this is a young market — the telephony integration
 * is rewritten too, and the DND and calling-window logic gets rewritten with it.
 * That logic is the part that must not be touched casually.
 *
 * NEITHER IS IMPLEMENTED
 *
 * Call Fluent's request shape, latency model and webhook format have not been
 * verified, and the specification forbids assuming them. Twilio's voice API is
 * better known but shares the caveat already recorded for its messaging API in
 * REMEDIATION_2_0.md §5: written from working knowledge, not from documentation.
 *
 * For voice the stakes are higher than for messaging. A wrong messaging call
 * fails. A wrong voice call places a real phone call to a real person, and
 * there is no unsend.
 */

export interface TelephonyProvider {
  placeCall(input: {
    organizationId: string
    toNumber: string
    fromNumber: string
    voiceCallId: string
    maxDurationSeconds: number
    recordingEnabled: boolean
  }): Promise<{ providerCallId: string }>
  hangUp(input: { providerCallId: string }): Promise<void>
  /** Warm transfer keeps the agent on the line; cold hands off and drops. */
  transfer(input: { providerCallId: string; toNumber: string; warm: boolean }): Promise<void>
  deleteRecording(input: { recordingReference: string }): Promise<void>
}

export interface ConversationEngine {
  startSession(input: {
    voiceCallId: string
    providerCallId: string
    prompt: string
    voiceId?: string
    language: string
    /** Spoken before the conversation begins, in order. */
    openingLines: string[]
    permittedActions: string[]
  }): Promise<{ sessionId: string }>
  endSession(input: { sessionId: string }): Promise<void>
}

export class VoiceProviderUnavailableError extends Error {
  readonly documentationNeeded: string
  constructor(component: 'telephony' | 'conversation', documentationNeeded: string) {
    super(`The ${component} provider is not implemented. ${documentationNeeded}`)
    this.name = 'VoiceProviderUnavailableError'
    this.documentationNeeded = documentationNeeded
  }
}

const TELEPHONY_DOCUMENTATION_NEEDED = 'Needed: the telephony provider choice, its current voice API contract for outbound calls, its status callback format, its recording storage and deletion semantics, and confirmation that the numbers in use are registered for outbound calling in each jurisdiction being dialled.'

const CONVERSATION_DOCUMENTATION_NEEDED = 'Needed: which conversational provider (Call Fluent or an alternative), its session initiation contract, its webhook or streaming format for turns and in-call actions, its latency characteristics, and how it signals that a caller has spoken an opt-out phrase.'

export class UnimplementedTelephonyProvider implements TelephonyProvider {
  async placeCall(_input?: unknown): Promise<{ providerCallId: string }> {
    throw new VoiceProviderUnavailableError('telephony', TELEPHONY_DOCUMENTATION_NEEDED)
  }
  async hangUp(_input?: unknown): Promise<void> { throw new VoiceProviderUnavailableError('telephony', TELEPHONY_DOCUMENTATION_NEEDED) }
  async transfer(_input?: unknown): Promise<void> { throw new VoiceProviderUnavailableError('telephony', TELEPHONY_DOCUMENTATION_NEEDED) }
  async deleteRecording(_input?: unknown): Promise<void> { throw new VoiceProviderUnavailableError('telephony', TELEPHONY_DOCUMENTATION_NEEDED) }
}

export class UnimplementedConversationEngine implements ConversationEngine {
  async startSession(_input?: unknown): Promise<{ sessionId: string }> {
    throw new VoiceProviderUnavailableError('conversation', CONVERSATION_DOCUMENTATION_NEEDED)
  }
  async endSession(_input?: unknown): Promise<void> { throw new VoiceProviderUnavailableError('conversation', CONVERSATION_DOCUMENTATION_NEEDED) }
}

export const telephonyProvider: TelephonyProvider = new UnimplementedTelephonyProvider()
export const conversationEngine: ConversationEngine = new UnimplementedConversationEngine()

export function voiceProviderStatus() {
  return {
    telephony: { implemented: false, documentationNeeded: TELEPHONY_DOCUMENTATION_NEEDED },
    conversation: { implemented: false, documentationNeeded: CONVERSATION_DOCUMENTATION_NEEDED },
    note: 'No call can be placed in this build. Agents can be written, versioned and reviewed, and the dialer will evaluate every regulatory gate and record its decision — but the provider call refuses.',
  }
}

/* ------------------------------------------------------------ the gate chain */

export interface DialDecision {
  permitted: boolean
  reason?: CallBlockReason
  detail?: string
  /** When the call could be retried, for a deferral rather than a refusal. */
  deferUntil?: Date
  /** Every gate evaluated, in order, for the audit record. */
  evaluated: Array<{ gate: string; passed: boolean; detail?: string }>
}

export interface DialGateInput {
  now: Date
  organizationId: string
  phoneNumber: string
  timeZone: string | null | undefined
  jurisdiction: string
  policy: JurisdictionPolicy
  /** Resolves to a reason string when the number is suppressed. */
  suppressionCheck: () => Promise<string | null>
  /** Has the contact a recorded basis for being called? */
  hasConsentRecord: boolean
  dndChecker?: DndChecker
}

/**
 * May this call be placed?
 *
 * Every gate is evaluated and recorded, not short-circuited, because the audit
 * record needs to show what was checked as well as what failed. When a
 * regulator asks whether the DND registry was consulted, "the call was blocked
 * for a different reason first" is not an answer.
 *
 * The one exception is the timezone gate: without a resolvable local time the
 * calling-window gate cannot be evaluated at all, so it is recorded as not
 * evaluated rather than as passed.
 *
 * Fails closed throughout. Any gate that errors blocks the call.
 */
export async function evaluateDialGates(input: DialGateInput): Promise<DialDecision> {
  const evaluated: DialDecision['evaluated'] = []
  let blocked: { reason: CallBlockReason; detail: string; deferUntil?: Date } | null = null

  const record = (gate: string, passed: boolean, detail?: string) => { evaluated.push({ gate, passed, detail }) }
  const block = (reason: CallBlockReason, detail: string, deferUntil?: Date) => {
    if (!blocked) blocked = { reason, detail, deferUntil }
  }

  // 1. Suppression. Someone who asked not to be contacted has not consented to
  //    a phone call because the channel changed.
  try {
    const suppressed = await input.suppressionCheck()
    record('suppression', !suppressed, suppressed ? `Number is suppressed (${suppressed})` : undefined)
    if (suppressed) block('suppressed', `The number is on the suppression list (${suppressed}).`)
  } catch (error: any) {
    record('suppression', false, 'Suppression lookup failed')
    block('suppressed', `Suppression could not be verified: ${String(error?.message || 'lookup failed')}. The call is refused rather than placed unverified.`)
  }

  // 2. Consent basis. A record that this person may be called at all.
  record('consent_record', input.hasConsentRecord, input.hasConsentRecord ? undefined : 'No recorded basis for calling this contact')
  if (!input.hasConsentRecord) {
    block('no_consent_record', 'No recorded consent or lawful basis for calling this contact. An automated call to someone who never asked to be called is the highest-risk thing this system can do.')
  }

  // 3. DND registry. Defaults to a checker that blocks everything, so a dialer
  //    with no registry access does not dial.
  try {
    const dnd = await (input.dndChecker ?? defaultDndChecker).check({ phoneNumber: input.phoneNumber, jurisdiction: input.jurisdiction })
    record('dnd_registry', !dnd.registered, `source=${dnd.source}`)
    if (dnd.registered) {
      block('dnd_registry', dnd.source.startsWith('unavailable:')
        ? 'No do-not-call registry checker is configured. Every call is blocked until one is, because a checker that cannot verify must not report a number as clear.'
        : `The number is listed on the ${input.jurisdiction} do-not-call registry.`)
    }
  } catch (error: any) {
    record('dnd_registry', false, 'DND lookup failed')
    block('dnd_registry', `The do-not-call registry could not be consulted: ${String(error?.message || 'lookup failed')}.`)
  }

  // 4. Calling window and jurisdiction policy. A deferral, not a refusal: the
  //    lead is still valid, it is simply the wrong hour.
  const window = evaluateCallingWindow({ now: input.now, timeZone: input.timeZone, policy: input.policy })
  record('calling_window', window.permitted, window.detail)
  if (!window.permitted) block(window.reason ?? 'outside_calling_window', window.detail ?? 'Outside the permitted calling window.', window.nextPermittedAt)

  if (blocked) {
    const decision = blocked as { reason: CallBlockReason; detail: string; deferUntil?: Date }
    return { permitted: false, reason: decision.reason, detail: decision.detail, deferUntil: decision.deferUntil, evaluated }
  }
  return { permitted: true, evaluated }
}

/**
 * Is a block reason worth retrying later?
 *
 * Timing is; consent and registry status are not. Retrying a DND-listed number
 * on a schedule is how a single misconfiguration becomes a pattern of
 * violations rather than one.
 */
export function isDeferrable(reason: CallBlockReason | undefined): boolean {
  return reason === 'outside_calling_window' || reason === 'blackout_date'
}
