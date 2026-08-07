import { describe, expect, it } from 'vitest'
import {
  deferForQuietHours,
  instantFromZonedWallClock,
  isWithinQuietHours,
  localMinuteOfDay,
  nextStepDueAt,
  normaliseTimeZone,
  resolveWaitDueAt,
  zoneOffsetMs,
} from '../src/services/sequences/scheduleArithmetic'

const IST = 'Asia/Kolkata'
const NEW_YORK = 'America/New_York'

describe('sequence scheduling arithmetic', () => {
  it('adds fixed waits as elapsed time', () => {
    const from = new Date('2026-03-01T10:00:00.000Z')
    expect(resolveWaitDueAt(from, { kind: 'duration', minutes: 0 }, 'UTC').toISOString()).toBe('2026-03-01T10:00:00.000Z')
    expect(resolveWaitDueAt(from, { kind: 'duration', minutes: 90 }, 'UTC').toISOString()).toBe('2026-03-01T11:30:00.000Z')
    // Three days, the case the durable scheduler exists for.
    expect(resolveWaitDueAt(from, { kind: 'duration', minutes: 3 * 24 * 60 }, 'UTC').toISOString()).toBe('2026-03-04T10:00:00.000Z')
    expect(resolveWaitDueAt(from, { kind: 'immediate' }, 'UTC').toISOString()).toBe('2026-03-01T10:00:00.000Z')
  })

  it('rejects waits that are negative, fractional or beyond the ceiling', () => {
    const from = new Date('2026-03-01T10:00:00.000Z')
    expect(() => resolveWaitDueAt(from, { kind: 'duration', minutes: -1 }, 'UTC')).toThrow(/cannot be negative/)
    expect(() => resolveWaitDueAt(from, { kind: 'duration', minutes: 1.5 }, 'UTC')).toThrow(/whole number/)
    expect(() => resolveWaitDueAt(from, { kind: 'duration', minutes: 366 * 24 * 60 }, 'UTC')).toThrow(/365 days/)
    expect(() => resolveWaitDueAt(from, { kind: 'time_of_day', hour: 24, minute: 0 }, 'UTC')).toThrow(/between 0 and 23/)
    expect(() => resolveWaitDueAt(from, { kind: 'time_of_day', hour: 9, minute: 60 }, 'UTC')).toThrow(/between 0 and 59/)
  })

  it('resolves a zone offset and inverts a wall clock back to an instant', () => {
    // India is UTC+5:30 year round and has no DST, so it isolates the offset
    // arithmetic from the transition handling tested below.
    expect(zoneOffsetMs(new Date('2026-03-01T00:00:00.000Z'), IST)).toBe(5.5 * 3_600_000)
    const instant = instantFromZonedWallClock({ year: 2026, month: 3, day: 1, hour: 9, minute: 0, second: 0 }, IST)
    expect(instant.toISOString()).toBe('2026-03-01T03:30:00.000Z')
    expect(localMinuteOfDay(instant, IST)).toBe(9 * 60)
  })

  it('sends at the next occurrence of a local wall-clock time', () => {
    // 04:00 UTC is 09:30 in Kolkata, already past 09:00 local, so the next
    // 09:00 local is the following day.
    const from = new Date('2026-03-01T04:00:00.000Z')
    const due = resolveWaitDueAt(from, { kind: 'time_of_day', hour: 9, minute: 0 }, IST)
    expect(due.toISOString()).toBe('2026-03-02T03:30:00.000Z')
    expect(localMinuteOfDay(due, IST)).toBe(9 * 60)

    // 02:00 UTC is 07:30 local, so 09:00 local is still ahead on the same day.
    const earlier = resolveWaitDueAt(new Date('2026-03-01T02:00:00.000Z'), { kind: 'time_of_day', hour: 9, minute: 0 }, IST)
    expect(earlier.toISOString()).toBe('2026-03-01T03:30:00.000Z')
  })

  it('honours a minimum gap before the next local send time', () => {
    // 09:00 local is minutes away, but the step must wait at least 120 minutes,
    // which pushes it to the following day's window.
    const from = new Date('2026-03-01T03:20:00.000Z')
    const due = resolveWaitDueAt(from, { kind: 'time_of_day', hour: 9, minute: 0, afterMinutes: 120 }, IST)
    expect(due.toISOString()).toBe('2026-03-02T03:30:00.000Z')
  })

  it('keeps a local send time fixed across a DST transition', () => {
    // US DST begins 2026-03-08. A 09:00 local send on the 7th and on the 8th
    // must both read 09:00 locally, even though the elapsed gap is 23 hours.
    const beforeTransition = resolveWaitDueAt(new Date('2026-03-07T00:00:00.000Z'), { kind: 'time_of_day', hour: 9, minute: 0 }, NEW_YORK)
    const afterTransition = resolveWaitDueAt(new Date(beforeTransition.getTime() + 60_000), { kind: 'time_of_day', hour: 9, minute: 0 }, NEW_YORK)
    expect(localMinuteOfDay(beforeTransition, NEW_YORK)).toBe(9 * 60)
    expect(localMinuteOfDay(afterTransition, NEW_YORK)).toBe(9 * 60)
    expect(afterTransition.getTime() - beforeTransition.getTime()).toBe(23 * 3_600_000)
  })

  it('detects quiet hours across an overnight window', () => {
    const quietHours = { enabled: true, startMinute: 21 * 60, endMinute: 8 * 60 }
    // 22:00 local in Kolkata is 16:30 UTC.
    expect(isWithinQuietHours(new Date('2026-03-01T16:30:00.000Z'), quietHours, IST)).toBe(true)
    // 02:00 local is 20:30 UTC the previous day.
    expect(isWithinQuietHours(new Date('2026-02-28T20:30:00.000Z'), quietHours, IST)).toBe(true)
    // 12:00 local is 06:30 UTC.
    expect(isWithinQuietHours(new Date('2026-03-01T06:30:00.000Z'), quietHours, IST)).toBe(false)
    expect(isWithinQuietHours(new Date('2026-03-01T16:30:00.000Z'), { enabled: false, startMinute: 0, endMinute: 0 }, IST)).toBe(false)
  })

  it('defers a step out of quiet hours to the moment sending resumes', () => {
    const quietHours = { enabled: true, startMinute: 21 * 60, endMinute: 8 * 60 }
    // Due 02:00 local on 1 March; must move forward to 08:00 local the same day.
    const due = new Date('2026-02-28T20:30:00.000Z')
    const deferred = deferForQuietHours(due, quietHours, IST)
    expect(localMinuteOfDay(deferred, IST)).toBe(8 * 60)
    expect(deferred.getTime()).toBeGreaterThan(due.getTime())
    expect(isWithinQuietHours(deferred, quietHours, IST)).toBe(false)
  })

  it('defers a late-evening step to the following morning, not the same morning', () => {
    const quietHours = { enabled: true, startMinute: 21 * 60, endMinute: 8 * 60 }
    // 22:00 local on 1 March. The 08:00 window on 1 March is already past, so
    // the next permitted instant is 08:00 on 2 March.
    const due = new Date('2026-03-01T16:30:00.000Z')
    const deferred = deferForQuietHours(due, quietHours, IST)
    expect(deferred.toISOString()).toBe('2026-03-02T02:30:00.000Z')
    expect(localMinuteOfDay(deferred, IST)).toBe(8 * 60)
  })

  it('leaves a step outside quiet hours exactly where it was', () => {
    const quietHours = { enabled: true, startMinute: 21 * 60, endMinute: 8 * 60 }
    const due = new Date('2026-03-01T06:30:00.000Z')
    expect(deferForQuietHours(due, quietHours, IST).toISOString()).toBe(due.toISOString())
  })

  it('applies the wait before the quiet-hours deferral', () => {
    const quietHours = { enabled: true, startMinute: 21 * 60, endMinute: 8 * 60 }
    // 18:00 local + 6 hours = 00:00 local, inside the window, deferred to 08:00.
    const from = new Date('2026-03-01T12:30:00.000Z')
    const due = nextStepDueAt({ from, wait: { kind: 'duration', minutes: 360 }, quietHours, timeZone: IST })
    expect(localMinuteOfDay(due, IST)).toBe(8 * 60)
    expect(due.toISOString()).toBe('2026-03-02T02:30:00.000Z')
  })

  it('falls back to UTC for an unusable timezone rather than throwing mid-send', () => {
    expect(normaliseTimeZone('Not/AZone')).toBe('UTC')
    expect(normaliseTimeZone('')).toBe('UTC')
    expect(normaliseTimeZone(null)).toBe('UTC')
    expect(normaliseTimeZone(IST)).toBe(IST)
    const due = nextStepDueAt({ from: new Date('2026-03-01T10:00:00.000Z'), wait: { kind: 'duration', minutes: 60 }, timeZone: 'Not/AZone' })
    expect(due.toISOString()).toBe('2026-03-01T11:00:00.000Z')
  })
})
