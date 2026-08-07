import crypto from 'crypto'
import { z } from 'zod'
import { canonicalJson } from '../canonicalJson'

/**
 * Voice agent configuration, and the disclosures a call must carry.
 *
 * Two things live here that the specification insists on separately, because
 * they are the same problem: what the agent is allowed to say, and what it must
 * say whether the operator remembers to configure it or not.
 */

export const MAX_PROMPT_LENGTH = 20_000
export const MAX_VARIABLES = 30

/**
 * Contact fields an agent prompt may interpolate.
 *
 * An allow-list, not a free path expression. A prompt is read aloud to a person
 * and may be partially controlled by whoever wrote it; letting it address
 * arbitrary paths would let an agent recite whatever happens to be on the
 * contact record — custom fields an operator considered internal, or in the
 * healthcare vertical, notes that should never be spoken down a phone line.
 */
export const PERMITTED_VARIABLES = [
  'contact.firstName', 'contact.lastName', 'contact.name', 'contact.companyName',
  'organization.name', 'agent.name', 'appointment.startAt', 'deal.title',
] as const
export type PermittedVariable = (typeof PERMITTED_VARIABLES)[number]

export const IN_CALL_ACTIONS = ['book_appointment', 'transfer_warm', 'transfer_cold', 'send_sms', 'end_call'] as const
export type InCallAction = (typeof IN_CALL_ACTIONS)[number]

const disclosureSchema = z.object({
  /**
   * Spoken at the start of every call. Not optional and not blank-able: several
   * jurisdictions require disclosing that the caller is not human, and in the
   * ones that do not, a person still deserves to know.
   */
  aiDisclosureText: z.string().trim().min(10).max(500),
  /**
   * Recording consent announcement. Whether recording is lawful at all depends
   * on one-party or two-party consent rules that vary by jurisdiction, so
   * recording defaults to OFF and cannot be enabled without an announcement.
   */
  recordingEnabled: z.boolean().default(false),
  recordingConsentText: z.string().trim().max(500).optional(),
  /** Phrases that end the call and record an opt-out, honoured mid-sentence. */
  optOutPhrases: z.array(z.string().trim().min(2).max(60)).max(20).default([]),
})

export const agentDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** The system prompt. Interpolated variables must be on the allow-list. */
  prompt: z.string().trim().min(20).max(MAX_PROMPT_LENGTH),
  /** Provider-side voice identifier. Opaque here: this system does not choose voices. */
  voiceId: z.string().trim().max(120).optional(),
  language: z.string().trim().min(2).max(16).default('en'),
  /** Actions this agent may take mid-call. Empty means conversation only. */
  permittedActions: z.array(z.enum(IN_CALL_ACTIONS)).max(IN_CALL_ACTIONS.length).default([]),
  maxCallSeconds: z.number().int().min(30).max(1_800).default(300),
  disclosures: disclosureSchema,
})

export type AgentDefinitionInput = z.infer<typeof agentDefinitionSchema>

export interface AgentDefinition extends AgentDefinitionInput {
  /** Variables the prompt actually references, resolved at validation. */
  referencedVariables: string[]
}

export class AgentDefinitionError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join('; '))
    this.name = 'AgentDefinitionError'
    this.issues = issues
  }
}

/** Default opt-out phrases, always merged in. */
const BASELINE_OPT_OUT_PHRASES = [
  'stop calling', 'do not call', "don't call", 'remove me', 'take me off',
  'unsubscribe', 'opt out', 'never call',
]

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g

export function extractVariables(prompt: string): string[] {
  return [...new Set([...String(prompt).matchAll(VARIABLE_PATTERN)].map((match) => match[1] as string))]
}

export function canonicaliseAgentDefinition(input: unknown): AgentDefinition {
  const parsed = agentDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    throw new AgentDefinitionError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'agent'}: ${issue.message}`))
  }
  const value = parsed.data
  const issues: string[] = []

  const referencedVariables = extractVariables(value.prompt)
  if (referencedVariables.length > MAX_VARIABLES) issues.push(`prompt: references more than ${MAX_VARIABLES} variables`)
  for (const variable of referencedVariables) {
    if (!PERMITTED_VARIABLES.includes(variable as PermittedVariable)) {
      issues.push(`prompt: "{{${variable}}}" is not a permitted variable. An agent speaks to a person; it may only read fields on the allow-list.`)
    }
  }

  // Recording without an announcement is refused rather than defaulted,
  // because whether recording is lawful at all turns on consent rules this
  // system cannot evaluate.
  if (value.disclosures.recordingEnabled && !String(value.disclosures.recordingConsentText || '').trim()) {
    issues.push('disclosures: recording cannot be enabled without a consent announcement. Two-party consent jurisdictions require the recipient be told, and this system cannot determine which regime applies to a given call.')
  }

  if (issues.length) throw new AgentDefinitionError(issues)

  return {
    ...value,
    disclosures: {
      ...value.disclosures,
      // Baseline phrases are merged in and cannot be removed by configuration.
      // "Stop calling me" must end a call whether or not an operator thought to
      // list it.
      optOutPhrases: [...new Set([...BASELINE_OPT_OUT_PHRASES, ...value.disclosures.optOutPhrases.map((phrase) => phrase.toLowerCase())])],
    },
    referencedVariables,
  }
}

/**
 * Stable hash of the executable content of an agent version.
 *
 * An agent is pinned per call for the same reason a sequence version is pinned
 * per enrolment: editing an agent must not change what a call already in
 * progress will say. This hash lets an operator prove which script a given
 * recording corresponds to, which is the question asked after a complaint.
 */
export function agentDefinitionHash(definition: AgentDefinition): string {
  return crypto.createHash('sha256').update(canonicalJson({
    prompt: definition.prompt,
    voiceId: definition.voiceId,
    language: definition.language,
    permittedActions: [...definition.permittedActions].sort(),
    maxCallSeconds: definition.maxCallSeconds,
    disclosures: definition.disclosures,
  })).digest('hex')
}

/**
 * The opening script.
 *
 * Assembled here rather than left to the agent's prompt, deliberately. A
 * disclosure that lives inside a free-text prompt is one an operator can edit
 * away, and a model can decline to say. This returns the exact words that must
 * be spoken before the conversation begins, in order.
 */
export function openingDisclosures(definition: AgentDefinition): string[] {
  const lines = [definition.disclosures.aiDisclosureText.trim()]
  if (definition.disclosures.recordingEnabled) {
    lines.push(String(definition.disclosures.recordingConsentText || '').trim())
  }
  return lines.filter(Boolean)
}

/**
 * Canonical form for opt-out matching.
 *
 * Applied to BOTH the utterance and the configured phrases, through this one
 * function. An earlier version normalised only the utterance, which stripped
 * apostrophes from the speech but left them in the phrase list — so the
 * baseline phrase "don't call" could never match a caller saying "don't call
 * again". Apostrophes are ubiquitous in speech transcripts, and the failure was
 * silent: the call would simply continue.
 *
 * Any normalisation applied to one side must be applied to the other, and
 * routing both through a single function is the only way to keep that true.
 */
function normaliseForOptOut(value: string): string {
  return String(value || '')
    .toLowerCase()
    // Strip apostrophes rather than replacing them with a space, so "don't"
    // becomes "dont" rather than "don t" and stays a single token.
    .replace(/['\u2019`]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Did the caller ask to be left alone?
 *
 * Matched on substring, unlike the SMS opt-out keywords which match the whole
 * message. Speech is conversational: "yeah look, just stop calling me please"
 * is unambiguous and would never match a whole-string comparison. The asymmetry
 * is intentional — the cost of a false positive here is ending one call, and
 * the cost of a false negative is continuing to ring someone who asked you not
 * to.
 */
export function detectOptOut(utterance: string, definition: AgentDefinition): { optedOut: boolean; matchedPhrase?: string } {
  const normalised = normaliseForOptOut(utterance)
  if (!normalised) return { optedOut: false }
  for (const phrase of definition.disclosures.optOutPhrases) {
    const needle = normaliseForOptOut(phrase)
    if (needle && normalised.includes(needle)) return { optedOut: true, matchedPhrase: phrase }
  }
  return { optedOut: false }
}

/**
 * Interpolate permitted variables into a prompt.
 *
 * An unresolved variable becomes an empty string rather than being left as
 * literal braces. An agent reading "Hi {{contact.firstName}}" aloud is worse
 * than one reading "Hi".
 */
export function renderPrompt(definition: AgentDefinition, values: Partial<Record<PermittedVariable, string>>): string {
  return definition.prompt.replace(VARIABLE_PATTERN, (_match, name: string) => {
    if (!PERMITTED_VARIABLES.includes(name as PermittedVariable)) return ''
    return String(values[name as PermittedVariable] ?? '').trim()
  })
}
