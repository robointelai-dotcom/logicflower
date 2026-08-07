import { isSupportedTimeZone, localMinuteOfDay, normaliseTimeZone, zonedParts, instantFromZonedWallClock } from '../sequences/scheduleArithmetic'

/**
 * Availability.
 *
 * Pure: every function takes a configuration, a set of existing appointments
 * and an instant, and returns slots. Nothing here reads the clock or touches
 * the database, because slot arithmetic is where booking systems go wrong in
 * ways nobody notices until a customer arrives at the wrong hour.
 *
 * The specific failure this guards against: a business sets 09:00–17:00 and a
 * customer in another timezone is shown 09:00 in *their* zone. The rule
 * throughout is that working hours are wall-clock in the BUSINESS's timezone,
 * and a visitor's browser converts for display. The server never reasons in the
 * visitor's zone.
 */

export const MAX_HORIZON_DAYS = 180
export const MIN_SLOT_MINUTES = 5
export const MAX_SLOT_MINUTES = 480

export interface WorkingWindow {
  /** 0 = Sunday through 6 = Saturday. */
  weekday: number
  /** Minutes from local midnight. */
  startMinute: number
  endMinute: number
}

export interface AvailabilityConfig {
  timeZone: string
  /** Length of a bookable appointment. */
  slotMinutes: number
  /** Gap held clear before and after each booking. */
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  /** How soon someone may book. Stops a 5-minutes-from-now booking. */
  minimumNoticeMinutes: number
  /** How far ahead the calendar is open. */
  horizonDays: number
  workingWindows: WorkingWindow[]
  /** Local YYYY-MM-DD dates on which nothing may be booked. */
  blackoutDates: string[]
  /**
   * Slot start times are aligned to this many minutes past the hour, so a
   * 30-minute appointment offers 09:00 and 09:30 rather than 09:07. Set equal
   * to slotMinutes for back-to-back slots.
   */
  slotIntervalMinutes: number
}

export interface BusyInterval {
  startAt: Date
  endAt: Date
}

export interface Slot {
  startAt: Date
  endAt: Date
}

export class AvailabilityError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join('; '))
    this.name = 'AvailabilityError'
    this.issues = issues
  }
}

export function assertValidAvailability(config: AvailabilityConfig): void {
  const issues: string[] = []
  if (!isSupportedTimeZone(config.timeZone)) issues.push(`timeZone: "${config.timeZone}" is not a timezone this system can resolve`)
  if (!Number.isInteger(config.slotMinutes) || config.slotMinutes < MIN_SLOT_MINUTES || config.slotMinutes > MAX_SLOT_MINUTES) {
    issues.push(`slotMinutes: must be a whole number between ${MIN_SLOT_MINUTES} and ${MAX_SLOT_MINUTES}`)
  }
  if (!Number.isInteger(config.slotIntervalMinutes) || config.slotIntervalMinutes < MIN_SLOT_MINUTES) {
    issues.push(`slotIntervalMinutes: must be a whole number of at least ${MIN_SLOT_MINUTES}`)
  }
  for (const [name, value] of [
    ['bufferBeforeMinutes', config.bufferBeforeMinutes],
    ['bufferAfterMinutes', config.bufferAfterMinutes],
    ['minimumNoticeMinutes', config.minimumNoticeMinutes],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 60 * 24 * 30) issues.push(`${name}: must be a whole number of minutes and cannot be negative`)
  }
  if (!Number.isInteger(config.horizonDays) || config.horizonDays < 1 || config.horizonDays > MAX_HORIZON_DAYS) {
    issues.push(`horizonDays: must be between 1 and ${MAX_HORIZON_DAYS}`)
  }
  if (!Array.isArray(config.workingWindows) || !config.workingWindows.length) {
    issues.push('workingWindows: at least one window is required, or nothing can ever be booked')
  } else {
    config.workingWindows.forEach((window, index) => {
      const label = `workingWindows[${index}]`
      if (!Number.isInteger(window.weekday) || window.weekday < 0 || window.weekday > 6) issues.push(`${label}: weekday must be 0 (Sunday) to 6 (Saturday)`)
      for (const [name, value] of [['startMinute', window.startMinute], ['endMinute', window.endMinute]] as const) {
        if (!Number.isInteger(value) || value < 0 || value > 1_440) issues.push(`${label}: ${name} must be a whole minute between 0 and 1440`)
      }
      if (window.startMinute >= window.endMinute) issues.push(`${label}: must start before it ends`)
      if (window.endMinute - window.startMinute < config.slotMinutes) {
        // A window shorter than one appointment silently produces no slots, and
        // an operator sees an empty calendar with no explanation.
        issues.push(`${label}: is shorter than one ${config.slotMinutes}-minute appointment, so it can never offer a slot`)
      }
    })
  }
  if (issues.length) throw new AvailabilityError(issues)
}

/** Local YYYY-MM-DD for an instant in a zone. */
export function localDateKey(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, normaliseTimeZone(timeZone))
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function localWeekday(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, normaliseTimeZone(timeZone))
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
}

/** Half-open overlap: an appointment ending at 10:00 does not block one starting at 10:00. */
export function overlaps(a: BusyInterval, b: BusyInterval): boolean {
  return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime()
}

/**
 * Generate bookable slots.
 *
 * Walks local calendar days rather than adding 24 hours, so a daylight-saving
 * change moves the elapsed time and leaves 09:00 at 09:00 — the same rule the
 * sequence scheduler follows.
 *
 * Buffers are applied by widening the candidate when testing against existing
 * appointments, not by shortening the appointment. A 30-minute booking with a
 * 15-minute buffer occupies 30 minutes of the customer's time and 60 minutes of
 * the calendar, which is what an operator means by a buffer.
 */
export function generateSlots(input: {
  config: AvailabilityConfig
  busy: BusyInterval[]
  from: Date
  /** Defaults to the configured horizon. */
  to?: Date
  now: Date
  maxSlots?: number
}): Slot[] {
  assertValidAvailability(input.config)
  const { config } = input
  const zone = normaliseTimeZone(config.timeZone)

  const earliest = new Date(Math.max(
    input.from.getTime(),
    input.now.getTime() + config.minimumNoticeMinutes * 60_000,
  ))
  const horizonEnd = new Date(input.now.getTime() + config.horizonDays * 86_400_000)
  const latest = new Date(Math.min(input.to?.getTime() ?? horizonEnd.getTime(), horizonEnd.getTime()))
  if (earliest.getTime() >= latest.getTime()) return []

  const windowsByWeekday = new Map<number, WorkingWindow[]>()
  for (const window of config.workingWindows) {
    windowsByWeekday.set(window.weekday, [...(windowsByWeekday.get(window.weekday) ?? []), window])
  }

  const blackout = new Set(config.blackoutDates ?? [])
  const maxSlots = Math.max(1, Math.min(input.maxSlots ?? 500, 2_000))
  const slots: Slot[] = []

  const startParts = zonedParts(earliest, zone)
  for (let dayOffset = 0; dayOffset <= config.horizonDays + 1 && slots.length < maxSlots; dayOffset += 1) {
    // Step through calendar dates via UTC midnight of the local date, so month
    // and year boundaries are handled by Date rather than by arithmetic here.
    const localDate = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day) + dayOffset * 86_400_000)
    const year = localDate.getUTCFullYear()
    const month = localDate.getUTCMonth() + 1
    const day = localDate.getUTCDate()
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    if (blackout.has(dateKey)) continue

    // Midday is used to read the weekday because it is never ambiguous across a
    // daylight-saving transition, whereas local midnight sometimes is.
    const middayLocal = instantFromZonedWallClock({ year, month, day, hour: 12, minute: 0, second: 0 }, zone)
    if (middayLocal.getTime() > latest.getTime() + 86_400_000) break

    for (const window of windowsByWeekday.get(localWeekday(middayLocal, zone)) ?? []) {
      for (
        let minute = window.startMinute;
        minute + config.slotMinutes <= window.endMinute && slots.length < maxSlots;
        minute += config.slotIntervalMinutes
      ) {
        const startAt = instantFromZonedWallClock({
          year, month, day,
          hour: Math.floor(minute / 60) % 24,
          minute: minute % 60,
          second: 0,
        }, zone)
        const endAt = new Date(startAt.getTime() + config.slotMinutes * 60_000)

        if (startAt.getTime() < earliest.getTime()) continue
        if (startAt.getTime() > latest.getTime()) continue

        // A DST spring-forward can push a wall-clock time onto a different
        // local minute; a slot that no longer starts where it should is dropped
        // rather than offered at the wrong hour.
        if (localMinuteOfDay(startAt, zone) !== minute % 1_440) continue

        const guarded: BusyInterval = {
          startAt: new Date(startAt.getTime() - config.bufferBeforeMinutes * 60_000),
          endAt: new Date(endAt.getTime() + config.bufferAfterMinutes * 60_000),
        }
        if (input.busy.some((interval) => overlaps(guarded, interval))) continue

        slots.push({ startAt, endAt })
      }
    }
  }

  return slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
}

/** Group slots by local date, for rendering a day picker. */
export function groupSlotsByDay(slots: Slot[], timeZone: string): Array<{ date: string; slots: Slot[] }> {
  const zone = normaliseTimeZone(timeZone)
  const days = new Map<string, Slot[]>()
  for (const slot of slots) {
    const key = localDateKey(slot.startAt, zone)
    days.set(key, [...(days.get(key) ?? []), slot])
  }
  return [...days.entries()].map(([date, daySlots]) => ({ date, slots: daySlots }))
}

/**
 * Is a specific requested time still bookable?
 *
 * Re-checked at booking time rather than trusting the slot list the visitor was
 * shown. That list may be minutes old, and in those minutes somebody else may
 * have taken the slot.
 */
export function isSlotBookable(input: {
  config: AvailabilityConfig
  busy: BusyInterval[]
  startAt: Date
  now: Date
}): { bookable: boolean; reason?: string } {
  try { assertValidAvailability(input.config) } catch (error) {
    return { bookable: false, reason: (error as AvailabilityError).issues.join('; ') }
  }

  if (input.startAt.getTime() < input.now.getTime() + input.config.minimumNoticeMinutes * 60_000) {
    return { bookable: false, reason: 'too_soon' }
  }
  if (input.startAt.getTime() > input.now.getTime() + input.config.horizonDays * 86_400_000) {
    return { bookable: false, reason: 'beyond_horizon' }
  }

  const offered = generateSlots({
    config: input.config,
    busy: input.busy,
    from: new Date(input.startAt.getTime() - 60_000),
    to: new Date(input.startAt.getTime() + 60_000),
    now: input.now,
    maxSlots: 50,
  })
  const match = offered.some((slot) => slot.startAt.getTime() === input.startAt.getTime())
  return match ? { bookable: true } : { bookable: false, reason: 'slot_unavailable' }
}
