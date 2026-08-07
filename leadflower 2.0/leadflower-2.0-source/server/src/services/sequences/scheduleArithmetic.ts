/**
 * Scheduling arithmetic for sequence steps.
 *
 * Deliberately pure. Every function here takes an instant and a configuration
 * and returns an instant; nothing reads the clock, touches the database or
 * performs I/O. That is what makes the two behaviours most likely to silently
 * misfire — "wait three days" and "do not send at 2am" — provable by unit test
 * rather than by observing production a week later.
 *
 * All local-time reasoning goes through the IANA database via Intl, so a
 * contact in a zone that observes DST gets the wall-clock behaviour an operator
 * configured, not a fixed offset that drifts by an hour twice a year.
 */

export const MAX_WAIT_MINUTES = 365 * 24 * 60

export type WaitSpec =
  /** Fire as soon as the step is claimed. */
  | { kind: 'immediate' }
  /** Fire a fixed number of minutes after the previous step completed. */
  | { kind: 'duration'; minutes: number }
  /**
   * Fire at the next occurrence of a wall-clock time in the contact's zone,
   * optionally at least `afterMinutes` from now. "Send at 9am local, but never
   * less than an hour after the previous step" is the common configuration.
   */
  | { kind: 'time_of_day'; hour: number; minute: number; afterMinutes?: number }

export interface QuietHours {
  enabled: boolean
  /** Minutes from local midnight at which sending stops. */
  startMinute: number
  /** Minutes from local midnight at which sending may resume. */
  endMinute: number
}

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  formatterCache.set(timeZone, formatter)
  return formatter
}

/**
 * Is this a timezone identifier the runtime can actually resolve?
 *
 * Called at configuration time so an unusable zone is rejected when an operator
 * saves it, rather than throwing inside a worker three days later while a step
 * is due.
 */
export function isSupportedTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== 'string') return false
  try {
    formatterFor(timeZone).format(new Date(0))
    return true
  } catch {
    formatterCache.delete(timeZone)
    return false
  }
}

/** Resolve to a usable zone, falling back to UTC rather than throwing. */
export function normaliseTimeZone(timeZone: string | undefined | null, fallback = 'UTC'): string {
  const candidate = String(timeZone || '').trim()
  if (candidate && isSupportedTimeZone(candidate)) return candidate
  return isSupportedTimeZone(fallback) ? fallback : 'UTC'
}

/** Wall-clock components of an instant, as observed in a zone. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant)
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type)
    return found ? Number(found.value) : 0
  }
  // Intl renders midnight as hour 24 in some locales/zones; 24:00 on day N is
  // 00:00 on day N, and treating it as hour 24 shifts every comparison by a day.
  const hour = read('hour') % 24
  return { year: read('year'), month: read('month'), day: read('day'), hour, minute: read('minute'), second: read('second') }
}

/** Offset of a zone from UTC, in milliseconds, at a given instant. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  // Millisecond component is not rendered by the formatter and is identical in
  // every zone, so it is excluded from both sides of the subtraction.
  return asUtc - (instant.getTime() - instant.getMilliseconds())
}

/**
 * The instant at which a zone's wall clock reads the given components.
 *
 * Two passes, because the offset needed to convert a wall clock to an instant
 * is itself a function of the instant. The first pass guesses using the offset
 * at the naive UTC interpretation; the second corrects it. That converges for
 * every real zone, including the DST transitions where the guess is an hour out.
 *
 * A wall-clock time that does not exist (the hour skipped by a spring-forward)
 * resolves to the instant the clock jumps to, which is the first moment at or
 * after the requested time. A time that occurs twice (autumn fall-back)
 * resolves to the first occurrence.
 */
export function instantFromZonedWallClock(parts: ZonedParts, timeZone: string): Date {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone))
  const corrected = new Date(naive - zoneOffsetMs(firstGuess, timeZone))
  return corrected
}

/** Minutes since local midnight for an instant, in a zone. */
export function localMinuteOfDay(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone)
  return parts.hour * 60 + parts.minute
}

export function assertValidWait(wait: WaitSpec): void {
  if (wait.kind === 'duration') {
    if (!Number.isFinite(wait.minutes) || !Number.isInteger(wait.minutes) || wait.minutes < 0) {
      throw new Error('Wait duration must be a whole number of minutes and cannot be negative')
    }
    if (wait.minutes > MAX_WAIT_MINUTES) throw new Error('Wait duration cannot exceed 365 days')
    return
  }
  if (wait.kind === 'time_of_day') {
    if (!Number.isInteger(wait.hour) || wait.hour < 0 || wait.hour > 23) throw new Error('Wait hour must be between 0 and 23')
    if (!Number.isInteger(wait.minute) || wait.minute < 0 || wait.minute > 59) throw new Error('Wait minute must be between 0 and 59')
    const after = wait.afterMinutes ?? 0
    if (!Number.isInteger(after) || after < 0 || after > MAX_WAIT_MINUTES) throw new Error('Wait afterMinutes must be a whole number of minutes within 365 days')
  }
}

/**
 * When does a step become due, given when its predecessor finished?
 *
 * `time_of_day` searches forward day by day rather than adding 24 hours, so a
 * DST change moves the send by an hour of elapsed time and keeps it at the
 * wall-clock time the operator asked for.
 */
export function resolveWaitDueAt(from: Date, wait: WaitSpec, timeZone: string): Date {
  assertValidWait(wait)
  const zone = normaliseTimeZone(timeZone)
  if (wait.kind === 'immediate') return new Date(from.getTime())
  if (wait.kind === 'duration') return new Date(from.getTime() + wait.minutes * MINUTE_MS)

  const earliest = new Date(from.getTime() + (wait.afterMinutes ?? 0) * MINUTE_MS)
  const base = zonedParts(earliest, zone)
  for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
    // Walk the calendar via UTC midnight of the local date, so month and year
    // boundaries are handled by Date rather than by arithmetic here.
    const localMidnightUtc = new Date(Date.UTC(base.year, base.month - 1, base.day) + dayOffset * DAY_MS)
    const candidate = instantFromZonedWallClock({
      year: localMidnightUtc.getUTCFullYear(),
      month: localMidnightUtc.getUTCMonth() + 1,
      day: localMidnightUtc.getUTCDate(),
      hour: wait.hour,
      minute: wait.minute,
      second: 0,
    }, zone)
    if (candidate.getTime() >= earliest.getTime()) return candidate
  }
  // Unreachable for any real zone: three days of candidates cannot all precede
  // the earliest permitted instant. Failing loudly beats returning a wrong time.
  throw new Error('Unable to resolve a time-of-day send window for this timezone')
}

export function isWithinQuietHours(instant: Date, quietHours: QuietHours, timeZone: string): boolean {
  if (!quietHours?.enabled) return false
  const { startMinute, endMinute } = quietHours
  if (startMinute === endMinute) return false
  const minute = localMinuteOfDay(instant, normaliseTimeZone(timeZone))
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    // Overnight window, e.g. 21:00–08:00.
    : minute >= startMinute || minute < endMinute
}

export function assertValidQuietHours(quietHours: QuietHours): void {
  if (!quietHours?.enabled) return
  for (const [name, value] of [['startMinute', quietHours.startMinute], ['endMinute', quietHours.endMinute]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 1_439) throw new Error(`Quiet hours ${name} must be a whole minute between 0 and 1439`)
  }
}

/**
 * Move a due instant out of a quiet window, forward to the moment sending is
 * next permitted.
 *
 * Deferral, never cancellation. A step that comes due at 2am is sent at 8am; it
 * is not dropped and it is not marked skipped. Dropping it is the failure mode
 * that loses a lead silently, which is exactly what an operator cannot see.
 */
export function deferForQuietHours(dueAt: Date, quietHours: QuietHours, timeZone: string): Date {
  assertValidQuietHours(quietHours)
  if (!isWithinQuietHours(dueAt, quietHours, timeZone)) return new Date(dueAt.getTime())
  const zone = normaliseTimeZone(timeZone)
  const parts = zonedParts(dueAt, zone)
  const endHour = Math.floor(quietHours.endMinute / 60)
  const endMinute = quietHours.endMinute % 60
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const localMidnightUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + dayOffset * DAY_MS)
    const candidate = instantFromZonedWallClock({
      year: localMidnightUtc.getUTCFullYear(),
      month: localMidnightUtc.getUTCMonth() + 1,
      day: localMidnightUtc.getUTCDate(),
      hour: endHour,
      minute: endMinute,
      second: 0,
    }, zone)
    if (candidate.getTime() >= dueAt.getTime() && !isWithinQuietHours(candidate, quietHours, zone)) return candidate
  }
  throw new Error('Unable to resolve the next permitted send window for this timezone')
}

/**
 * Full resolution for one step: wait from the previous step, then push out of
 * any quiet window. Composed in this order on purpose — deferring first and
 * then adding the wait would silently lengthen every subsequent gap.
 */
export function nextStepDueAt(input: {
  from: Date
  wait: WaitSpec
  quietHours?: QuietHours
  timeZone?: string | null
}): Date {
  const zone = normaliseTimeZone(input.timeZone)
  const due = resolveWaitDueAt(input.from, input.wait, zone)
  if (!input.quietHours?.enabled) return due
  return deferForQuietHours(due, input.quietHours, zone)
}
