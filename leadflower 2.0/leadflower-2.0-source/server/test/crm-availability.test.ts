import { describe, expect, it } from 'vitest'
import {
  AvailabilityError,
  assertValidAvailability,
  generateSlots,
  groupSlotsByDay,
  isSlotBookable,
  localDateKey,
  overlaps,
  type AvailabilityConfig,
} from '../src/services/crm/availability'
import { localMinuteOfDay } from '../src/services/sequences/scheduleArithmetic'

const IST = 'Asia/Kolkata'
const NEW_YORK = 'America/New_York'

function config(overrides: Partial<AvailabilityConfig> = {}): AvailabilityConfig {
  return {
    timeZone: IST,
    slotMinutes: 30,
    slotIntervalMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    horizonDays: 14,
    // Monday to Friday, 09:00–17:00 local.
    workingWindows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 })),
    blackoutDates: [],
    ...overrides,
  }
}

// 2026-03-02 is a Monday. 00:00 UTC is 05:30 local in Kolkata.
const MONDAY_EARLY = new Date('2026-03-02T00:00:00Z')

describe('availability configuration', () => {
  it('accepts a workable configuration', () => {
    expect(() => assertValidAvailability(config())).not.toThrow()
  })

  it('refuses a window shorter than one appointment', () => {
    // Otherwise it silently produces no slots and an operator sees an empty
    // calendar with no explanation.
    expect(() => assertValidAvailability(config({
      slotMinutes: 60,
      workingWindows: [{ weekday: 1, startMinute: 9 * 60, endMinute: 9 * 60 + 30 }],
    }))).toThrow(/can never offer a slot/)
  })

  it('refuses a configuration that could never be booked', () => {
    expect(() => assertValidAvailability(config({ workingWindows: [] }))).toThrow(/at least one window/)
    expect(() => assertValidAvailability(config({ workingWindows: [{ weekday: 1, startMinute: 17 * 60, endMinute: 9 * 60 }] }))).toThrow(/must start before it ends/)
    expect(() => assertValidAvailability(config({ timeZone: 'Not/AZone' }))).toThrow(/not a timezone/)
    expect(() => assertValidAvailability(config({ horizonDays: 0 }))).toThrow(/between 1 and/)
    expect(() => assertValidAvailability(config({ slotMinutes: 2 }))).toThrow(/between 5 and/)
  })

  it('collects every issue rather than failing on the first', () => {
    try {
      assertValidAvailability(config({ timeZone: 'Not/AZone', horizonDays: 0, slotMinutes: 2 }))
      throw new Error('should have thrown')
    } catch (error: any) {
      expect(error).toBeInstanceOf(AvailabilityError)
      expect(error.issues.length).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('slot generation', () => {
  it('offers slots only inside working hours, in the business timezone', () => {
    const slots = generateSlots({ config: config(), busy: [], from: MONDAY_EARLY, now: MONDAY_EARLY, maxSlots: 40 })
    expect(slots.length).toBeGreaterThan(0)
    for (const slot of slots) {
      const minute = localMinuteOfDay(slot.startAt, IST)
      expect(minute).toBeGreaterThanOrEqual(9 * 60)
      // The last slot starts at 16:30 and ends at 17:00.
      expect(minute).toBeLessThanOrEqual(16 * 60 + 30)
    }
  })

  it('produces exactly the expected number of slots in one day', () => {
    // 09:00–17:00 at 30 minutes is 16 slots.
    const slots = generateSlots({
      config: config(),
      busy: [],
      from: MONDAY_EARLY,
      to: new Date('2026-03-02T18:30:00Z'),
      now: MONDAY_EARLY,
    })
    expect(slots).toHaveLength(16)
    expect(localMinuteOfDay(slots[0]!.startAt, IST)).toBe(9 * 60)
    expect(localMinuteOfDay(slots[15]!.startAt, IST)).toBe(16 * 60 + 30)
  })

  it('skips weekends when no window is configured for them', () => {
    const slots = generateSlots({ config: config(), busy: [], from: MONDAY_EARLY, now: MONDAY_EARLY, maxSlots: 500 })
    // 2026-03-07 is a Saturday and 2026-03-08 a Sunday.
    const dates = new Set(slots.map((slot) => localDateKey(slot.startAt, IST)))
    expect(dates.has('2026-03-07')).toBe(false)
    expect(dates.has('2026-03-08')).toBe(false)
    expect(dates.has('2026-03-06')).toBe(true)
  })

  it('honours blackout dates', () => {
    const slots = generateSlots({
      config: config({ blackoutDates: ['2026-03-03'] }),
      busy: [], from: MONDAY_EARLY, now: MONDAY_EARLY, maxSlots: 500,
    })
    expect(new Set(slots.map((slot) => localDateKey(slot.startAt, IST))).has('2026-03-03')).toBe(false)
  })

  it('removes slots that collide with an existing appointment', () => {
    // 10:00–10:30 local is 04:30–05:00 UTC.
    const busy = [{ startAt: new Date('2026-03-02T04:30:00Z'), endAt: new Date('2026-03-02T05:00:00Z') }]
    const slots = generateSlots({
      config: config(), busy, from: MONDAY_EARLY,
      to: new Date('2026-03-02T18:30:00Z'), now: MONDAY_EARLY,
    })
    expect(slots).toHaveLength(15)
    expect(slots.some((slot) => localMinuteOfDay(slot.startAt, IST) === 10 * 60)).toBe(false)
    // Back-to-back is fine: 10:30 is still offered.
    expect(slots.some((slot) => localMinuteOfDay(slot.startAt, IST) === 10 * 60 + 30)).toBe(true)
  })

  it('widens the guard by the buffers without shortening the appointment', () => {
    // A buffer holds calendar time clear; it does not shorten the customer's
    // appointment.
    const busy = [{ startAt: new Date('2026-03-02T04:30:00Z'), endAt: new Date('2026-03-02T05:00:00Z') }]
    const slots = generateSlots({
      config: config({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }),
      busy, from: MONDAY_EARLY, to: new Date('2026-03-02T18:30:00Z'), now: MONDAY_EARLY,
    })
    // 09:30, 10:00 and 10:30 are all now blocked by the buffered window.
    for (const blocked of [9 * 60 + 30, 10 * 60, 10 * 60 + 30]) {
      expect(slots.some((slot) => localMinuteOfDay(slot.startAt, IST) === blocked)).toBe(false)
    }
    expect(slots.some((slot) => localMinuteOfDay(slot.startAt, IST) === 11 * 60)).toBe(true)
    // The appointment itself is still 30 minutes.
    expect(slots[0]!.endAt.getTime() - slots[0]!.startAt.getTime()).toBe(30 * 60_000)
  })

  it('enforces minimum notice', () => {
    // Now is 09:00 local on Monday (03:30 UTC) with two hours' notice required,
    // so nothing before 11:00 local is offered.
    const now = new Date('2026-03-02T03:30:00Z')
    const slots = generateSlots({
      config: config({ minimumNoticeMinutes: 120 }),
      busy: [], from: now, to: new Date('2026-03-02T18:30:00Z'), now,
    })
    expect(slots.length).toBeGreaterThan(0)
    expect(localMinuteOfDay(slots[0]!.startAt, IST)).toBe(11 * 60)
  })

  it('does not offer anything beyond the horizon', () => {
    const slots = generateSlots({
      config: config({ horizonDays: 2 }),
      busy: [], from: MONDAY_EARLY, now: MONDAY_EARLY, maxSlots: 1_000,
    })
    const latest = Math.max(...slots.map((slot) => slot.startAt.getTime()))
    expect(latest).toBeLessThanOrEqual(MONDAY_EARLY.getTime() + 2 * 86_400_000)
  })

  it('keeps opening time fixed across a daylight-saving change', () => {
    // US DST begins 2026-03-08. A 09:00 opening must read 09:00 on both sides,
    // even though the elapsed gap between those two mornings is 23 hours.
    const config1 = config({ timeZone: NEW_YORK, workingWindows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 })) })
    const from = new Date('2026-03-06T00:00:00Z')
    const slots = generateSlots({ config: config1, busy: [], from, now: from, maxSlots: 2_000 })

    const byDay = new Map<string, Date>()
    for (const slot of slots) {
      const key = localDateKey(slot.startAt, NEW_YORK)
      if (!byDay.has(key)) byDay.set(key, slot.startAt)
    }
    const before = byDay.get('2026-03-07')
    const after = byDay.get('2026-03-09')
    expect(before).toBeDefined()
    expect(after).toBeDefined()
    expect(localMinuteOfDay(before!, NEW_YORK)).toBe(9 * 60)
    expect(localMinuteOfDay(after!, NEW_YORK)).toBe(9 * 60)
  })

  it('supports slot intervals finer than the appointment length', () => {
    // 60-minute appointments offered every 30 minutes: 09:00, 09:30, 10:00…
    const slots = generateSlots({
      config: config({ slotMinutes: 60, slotIntervalMinutes: 30 }),
      busy: [], from: MONDAY_EARLY, to: new Date('2026-03-02T18:30:00Z'), now: MONDAY_EARLY,
    })
    expect(localMinuteOfDay(slots[0]!.startAt, IST)).toBe(9 * 60)
    expect(localMinuteOfDay(slots[1]!.startAt, IST)).toBe(9 * 60 + 30)
    expect(slots[0]!.endAt.getTime() - slots[0]!.startAt.getTime()).toBe(60 * 60_000)
    // The last one must still finish by 17:00.
    const last = slots[slots.length - 1]!
    expect(localMinuteOfDay(last.startAt, IST)).toBe(16 * 60)
  })

  it('groups slots by local date for a day picker', () => {
    const slots = generateSlots({ config: config(), busy: [], from: MONDAY_EARLY, now: MONDAY_EARLY, maxSlots: 40 })
    const days = groupSlotsByDay(slots, IST)
    expect(days.length).toBeGreaterThan(0)
    expect(days[0]?.date).toBe('2026-03-02')
    expect(days.every((day) => day.slots.length > 0)).toBe(true)
  })
})

describe('booking a specific slot', () => {
  const now = MONDAY_EARLY

  it('accepts a slot that is genuinely on offer', () => {
    const slots = generateSlots({ config: config(), busy: [], from: now, now, maxSlots: 5 })
    expect(isSlotBookable({ config: config(), busy: [], startAt: slots[0]!.startAt, now })).toEqual({ bookable: true })
  })

  it('refuses a time that is not a slot boundary', () => {
    // Someone posting an arbitrary time rather than one they were offered.
    const offBoundary = new Date('2026-03-02T03:37:00Z')
    expect(isSlotBookable({ config: config(), busy: [], startAt: offBoundary, now }).reason).toBe('slot_unavailable')
  })

  it('refuses a slot taken since the list was rendered', () => {
    // The list a visitor is looking at may be minutes old, and in those minutes
    // somebody else may have booked.
    const slots = generateSlots({ config: config(), busy: [], from: now, now, maxSlots: 5 })
    const taken = [{ startAt: slots[0]!.startAt, endAt: slots[0]!.endAt }]
    expect(isSlotBookable({ config: config(), busy: taken, startAt: slots[0]!.startAt, now }).reason).toBe('slot_unavailable')
  })

  it('refuses a booking inside the notice period or past the horizon', () => {
    const soon = new Date(now.getTime() + 10 * 60_000)
    expect(isSlotBookable({ config: config({ minimumNoticeMinutes: 120 }), busy: [], startAt: soon, now }).reason).toBe('too_soon')
    const distant = new Date(now.getTime() + 60 * 86_400_000)
    expect(isSlotBookable({ config: config({ horizonDays: 14 }), busy: [], startAt: distant, now }).reason).toBe('beyond_horizon')
  })
})

describe('interval overlap', () => {
  it('treats intervals as half-open so back-to-back bookings do not clash', () => {
    const first = { startAt: new Date('2026-03-02T09:00:00Z'), endAt: new Date('2026-03-02T10:00:00Z') }
    expect(overlaps(first, { startAt: new Date('2026-03-02T10:00:00Z'), endAt: new Date('2026-03-02T11:00:00Z') })).toBe(false)
    expect(overlaps(first, { startAt: new Date('2026-03-02T09:30:00Z'), endAt: new Date('2026-03-02T10:30:00Z') })).toBe(true)
    expect(overlaps(first, { startAt: new Date('2026-03-02T09:15:00Z'), endAt: new Date('2026-03-02T09:45:00Z') })).toBe(true)
  })
})
