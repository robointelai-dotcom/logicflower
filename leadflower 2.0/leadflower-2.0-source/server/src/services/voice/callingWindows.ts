import { isSupportedTimeZone, localMinuteOfDay, normaliseTimeZone, zonedParts } from '../sequences/scheduleArithmetic'

/**
 * When an outbound call may legally and decently be placed.
 *
 * This module is the most consequential thing in Phase 5, and it is
 * deliberately the dullest. A bug in the voice agent's conversation makes a
 * customer look silly; a bug here rings a stranger at 6am, or calls a number on
 * a do-not-call registry, and puts the operator in front of a regulator.
 *
 * ON LEGAL DEFAULTS, AND WHY THEY ARE NOT ENCODED HERE
 *
 * There is no table of statutory calling hours in this file, and that is
 * intentional. Calling-time rules vary by country, by state, by the nature of
 * the call (solicitation versus a call the recipient asked for), and they
 * change. A hardcoded "8am-9pm because TCPA" would be asserted by software,
 * relied upon by an operator, and wrong somewhere — and being *nearly* right
 * about a calling-hours rule is worse than having no rule, because it
 * manufactures confidence.
 *
 * So: this module enforces a CONSERVATIVE default window and requires the
 * operator to widen it explicitly, recording who reviewed the legal position
 * and when. Build the control; do not assert the compliance. The same
 * discipline the specification applies to HIPAA applies here.
 */

/**
 * Default window: 09:00-19:00 local, weekdays and Saturday.
 *
 * Chosen to sit comfortably inside the narrowest window the author is aware of
 * in any major jurisdiction, not to match any particular one. An operator who
 * needs a wider window must widen it deliberately and record why.
 */
export const CONSERVATIVE_WINDOW: CallingWindow = Object.freeze({
  startMinute: 9 * 60,
  endMinute: 19 * 60,
  // Sunday excluded by default. Several jurisdictions restrict it, and in
  // others it is merely a good way to annoy someone.
  permittedWeekdays: Object.freeze([1, 2, 3, 4, 5, 6]) as unknown as number[],
})

export interface CallingWindow {
  /** Minutes from local midnight at which calling may begin. */
  startMinute: number
  /** Minutes from local midnight at which calling must stop. */
  endMinute: number
  /** 0 = Sunday through 6 = Saturday. */
  permittedWeekdays: number[]
}

export interface JurisdictionPolicy {
  /** Free-text label, e.g. "India — TRAI/DLT" or "US — TCPA (reviewed 2026-03)". */
  label: string
  window: CallingWindow
  /**
   * Dates on which calling is not permitted, as local YYYY-MM-DD strings.
   * Public holidays are operator-supplied: there is no reliable universal
   * source and guessing at them would be worse than leaving them out.
   */
  blackoutDates: string[]
  /**
   * Has a human recorded that this policy reflects legal advice? The dialer
   * refuses to use a widened window that nobody has signed off.
   */
  legalReviewRecordedBy: string | null
  legalReviewedAt: Date | null
}

export type CallBlockReason =
  | 'outside_calling_window'
  | 'blackout_date'
  | 'unreviewed_window'
  | 'dnd_registry'
  | 'suppressed'
  | 'no_consent_record'
  | 'invalid_timezone'

export interface WindowDecision {
  permitted: boolean
  reason?: CallBlockReason
  /** The next instant at which calling would be permitted. */
  nextPermittedAt?: Date
  detail?: string
}

export function assertValidWindow(window: CallingWindow): void {
  const issues: string[] = []
  for (const [name, value] of [['startMinute', window?.startMinute], ['endMinute', window?.endMinute]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 1_439) issues.push(`${name} must be a whole minute between 0 and 1439`)
  }
  if (!issues.length && window.startMinute >= window.endMinute) {
    // An overnight calling window is almost certainly a configuration error,
    // and permitting one would let a misconfiguration authorise 3am calls.
    issues.push('a calling window must start before it ends; overnight windows are not permitted')
  }
  const weekdays = window?.permittedWeekdays
  if (!Array.isArray(weekdays) || !weekdays.length) issues.push('at least one weekday must be permitted')
  else if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) issues.push('weekdays must be integers from 0 (Sunday) to 6 (Saturday)')
  if (issues.length) throw new Error(`Invalid calling window: ${issues.join('; ')}`)
}

/**
 * Is a window wider than the conservative default?
 *
 * Used to decide whether legal sign-off is required. Narrowing is always
 * allowed without review — a more cautious operator needs no permission to be
 * more cautious.
 */
export function isWiderThanDefault(window: CallingWindow): boolean {
  if (window.startMinute < CONSERVATIVE_WINDOW.startMinute) return true
  if (window.endMinute > CONSERVATIVE_WINDOW.endMinute) return true
  return window.permittedWeekdays.some((day) => !CONSERVATIVE_WINDOW.permittedWeekdays.includes(day))
}

/** Local YYYY-MM-DD for an instant in a zone. */
export function localDateKey(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, normaliseTimeZone(timeZone))
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

/** Local weekday, 0 = Sunday. */
export function localWeekday(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, normaliseTimeZone(timeZone))
  // Date.UTC on the local wall clock gives the correct weekday for that zone.
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
}

/**
 * May a call be placed to this contact, right now?
 *
 * Fails closed on every ambiguity. An unresolvable timezone blocks the call
 * rather than defaulting to UTC — for a message that is a minor timing error,
 * but for a phone call it means dialling a stranger at an hour determined by
 * accident.
 */
export function evaluateCallingWindow(input: {
  now: Date
  timeZone: string | null | undefined
  policy: JurisdictionPolicy
}): WindowDecision {
  const zone = String(input.timeZone || '').trim()
  if (!zone || !isSupportedTimeZone(zone)) {
    return {
      permitted: false,
      reason: 'invalid_timezone',
      detail: 'The contact has no resolvable timezone, so the local hour cannot be established. A call is refused rather than placed at a guessed hour.',
    }
  }

  const { policy } = input
  assertValidWindow(policy.window)

  // A widened window that nobody has reviewed is refused outright. Software
  // must not be the thing that decided it was acceptable to call at 7am.
  if (isWiderThanDefault(policy.window) && !policy.legalReviewRecordedBy) {
    return {
      permitted: false,
      reason: 'unreviewed_window',
      detail: `The calling window for "${policy.label}" is wider than the conservative default and no legal review has been recorded against it.`,
    }
  }

  const dateKey = localDateKey(input.now, zone)
  if (policy.blackoutDates?.includes(dateKey)) {
    return { permitted: false, reason: 'blackout_date', nextPermittedAt: nextPermittedInstant(input.now, zone, policy), detail: `${dateKey} is a configured blackout date.` }
  }

  const weekday = localWeekday(input.now, zone)
  const minute = localMinuteOfDay(input.now, zone)
  const withinDay = policy.window.permittedWeekdays.includes(weekday)
  const withinHours = minute >= policy.window.startMinute && minute < policy.window.endMinute

  if (withinDay && withinHours) return { permitted: true }
  return {
    permitted: false,
    reason: 'outside_calling_window',
    nextPermittedAt: nextPermittedInstant(input.now, zone, policy),
    detail: `Local time is outside the permitted window for "${policy.label}".`,
  }
}

/**
 * The next instant calling becomes permitted.
 *
 * Searched forward a day at a time up to a bounded horizon, evaluating the same
 * predicate rather than a parallel one — a second implementation of "is this
 * permitted" is a second thing to get wrong.
 */
export function nextPermittedInstant(from: Date, timeZone: string, policy: JurisdictionPolicy, horizonDays = 14): Date | undefined {
  const zone = normaliseTimeZone(timeZone)
  const stepMinutes = 15
  const maxSteps = (horizonDays * 24 * 60) / stepMinutes
  for (let step = 1; step <= maxSteps; step += 1) {
    const candidate = new Date(from.getTime() + step * stepMinutes * 60_000)
    const dateKey = localDateKey(candidate, zone)
    if (policy.blackoutDates?.includes(dateKey)) continue
    if (!policy.window.permittedWeekdays.includes(localWeekday(candidate, zone))) continue
    const minute = localMinuteOfDay(candidate, zone)
    if (minute >= policy.window.startMinute && minute < policy.window.endMinute) return candidate
  }
  return undefined
}

/**
 * Do-not-call registry checking.
 *
 * NOT IMPLEMENTED, and the interface exists to make that fact structural rather
 * than an omission someone might not notice.
 *
 * India's DND registry and DLT scrubbing are accessed through a registered
 * telemarketer relationship with an access provider, not a public API. The US
 * National DNC list requires a subscription and an organisation identifier.
 * Neither can be inferred, and a stub that returns "not registered" is the most
 * dangerous possible default: it silently authorises exactly the calls the
 * check exists to prevent.
 *
 * So the default implementation refuses every call, and an operator must
 * consciously supply a checker. A dialer that cannot verify DND does not get to
 * dial.
 */
export interface DndChecker {
  check(input: { phoneNumber: string; jurisdiction: string }): Promise<{ registered: boolean; checkedAt: Date; source: string }>
}

export class UnavailableDndChecker implements DndChecker {
  async check(_input?: { phoneNumber: string; jurisdiction: string }): Promise<{ registered: boolean; checkedAt: Date; source: string }> {
    // Fails closed: reports every number as registered, so every call is
    // blocked until a real checker is configured.
    return {
      registered: true,
      checkedAt: new Date(),
      source: 'unavailable:no_dnd_checker_configured',
    }
  }
}

export const defaultDndChecker: DndChecker = new UnavailableDndChecker()
