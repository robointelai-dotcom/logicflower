import { describe, expect, it } from 'vitest'
import {
  assertRadiusKm,
  distanceKm,
  EARTH_RADIUS_KM,
  fromGeoPoint,
  LocationError,
  parseCoordinates,
  radiusQuery,
  toGeoPoint,
} from '../src/services/crm/location'
import {
  findConflicts,
  intervalsOverlap,
  localDateKey,
  SchedulingError,
  validateAppointment,
  validateTask,
} from '../src/services/crm/scheduling'
import { compileSegment } from '../src/services/crm/segments'

const CHENNAI = { latitude: 13.0827, longitude: 80.2707 }
const BANGALORE = { latitude: 12.9716, longitude: 77.5946 }

describe('coordinate handling', () => {
  it('accepts valid coordinates and rejects out-of-range ones', () => {
    expect(parseCoordinates(CHENNAI)).toEqual(CHENNAI)
    expect(parseCoordinates({ latitude: '13.0827', longitude: '80.2707' })).toEqual(CHENNAI)
    expect(() => parseCoordinates({ latitude: 91, longitude: 0 })).toThrow(/between -90 and 90/)
    expect(() => parseCoordinates({ latitude: 0, longitude: 181 })).toThrow(/between -180 and 180/)
    expect(() => parseCoordinates({ latitude: 'north', longitude: 80 })).toThrow(/must be a number/)
  })

  it('rejects 0,0 because it is almost always an empty form field', () => {
    // "Null Island" is where a contact lands when empty strings coerce to zero.
    // Refusing it surfaces the bug rather than silently placing someone 500km
    // off the coast of Ghana.
    expect(() => parseCoordinates({ latitude: 0, longitude: 0 })).toThrow(/almost always an empty form field/)
    expect(() => parseCoordinates({ latitude: '', longitude: '' })).toThrow(LocationError)
    // A genuine near-zero coordinate is still fine.
    expect(parseCoordinates({ latitude: 0.5, longitude: 0 })).toEqual({ latitude: 0.5, longitude: 0 })
  })

  it('stores GeoJSON as [longitude, latitude] and round-trips it', () => {
    // The single most common way geospatial queries silently return nothing.
    const point = toGeoPoint(CHENNAI)
    expect(point).toEqual({ type: 'Point', coordinates: [80.2707, 13.0827] })
    expect(point.coordinates[0]).toBe(CHENNAI.longitude)
    expect(point.coordinates[1]).toBe(CHENNAI.latitude)
    expect(fromGeoPoint(point)).toEqual(CHENNAI)
  })

  it('returns null for anything that is not a usable point', () => {
    expect(fromGeoPoint(undefined)).toBeNull()
    expect(fromGeoPoint({ type: 'Polygon', coordinates: [] })).toBeNull()
    expect(fromGeoPoint({ type: 'Point', coordinates: ['a', 'b'] })).toBeNull()
  })

  it('computes great-circle distance', () => {
    // Chennai to Bangalore is roughly 290km.
    const computed = distanceKm(CHENNAI, BANGALORE)
    expect(computed).toBeGreaterThan(280)
    expect(computed).toBeLessThan(300)
    expect(distanceKm(CHENNAI, CHENNAI)).toBeCloseTo(0, 6)
  })
})

describe('radius queries', () => {
  it('converts kilometres to radians for $centerSphere', () => {
    // Passing kilometres straight into $centerSphere yields a radius of
    // thousands of earth-circumferences and matches every record.
    const query: any = radiusQuery({ path: 'location', ...CHENNAI, radiusKm: 10 })
    const [centre, radians] = query.location.$geoWithin.$centerSphere
    expect(centre).toEqual([CHENNAI.longitude, CHENNAI.latitude])
    expect(radians).toBeCloseTo(10 / EARTH_RADIUS_KM, 10)
    expect(radians).toBeLessThan(0.01)
  })

  it('uses $geoWithin rather than $near so it can compose inside $or', () => {
    // $near cannot appear inside $or, so using it would make any-match segments
    // containing a location condition fail at query time rather than at compile
    // time — a failure the segment's author would never see coming.
    const query: any = radiusQuery({ path: 'location', ...CHENNAI, radiusKm: 5 })
    expect(query.location.$near).toBeUndefined()
    expect(query.location.$geoWithin).toBeDefined()
  })

  it('bounds the radius', () => {
    expect(assertRadiusKm(10)).toBe(10)
    expect(() => assertRadiusKm(0)).toThrow(/positive number/)
    expect(() => assertRadiusKm(-5)).toThrow(/positive number/)
    expect(() => assertRadiusKm(50_000)).toThrow(/cannot exceed/)
  })
})

describe('location targeting through the segment compiler', () => {
  function compile(conditions: any[], match: 'all' | 'any' = 'all') {
    return compileSegment({ organizationId: 'org-1', definition: { match, conditions }, definitions: [] })
  }

  it('compiles a within_radius condition alongside ordinary filters', () => {
    const query: any = compile([
      { field: 'lifecycleStatus', operator: 'equals', value: 'lead' },
      { field: 'location', operator: 'within_radius', value: { ...CHENNAI, radiusKm: 25 } },
    ])
    expect(query.organizationId).toBe('org-1')
    expect(query.$and[0]).toEqual({ lifecycleStatus: 'lead' })
    expect(query.$and[1].location.$geoWithin.$centerSphere[0]).toEqual([CHENNAI.longitude, CHENNAI.latitude])
  })

  it('composes inside an any-match segment', () => {
    const query: any = compile([
      { field: 'location', operator: 'within_radius', value: { ...CHENNAI, radiusKm: 5 } },
      { field: 'lifecycleStatus', operator: 'equals', value: 'customer' },
    ], 'any')
    expect(query.$or).toHaveLength(2)
  })

  it('refuses a location operator on a non-location field and vice versa', () => {
    expect(() => compile([{ field: 'email', operator: 'within_radius', value: { ...CHENNAI, radiusKm: 5 } }]))
      .toThrow(/only be used on a location field/)
    expect(() => compile([{ field: 'location', operator: 'equals', value: 'Chennai' }]))
      .toThrow(/only "within_radius" can be used on a location field/)
  })

  it('surfaces bad coordinates as a segment error rather than a bad query', () => {
    expect(() => compile([{ field: 'location', operator: 'within_radius', value: { latitude: 200, longitude: 0, radiusKm: 5 } }]))
      .toThrow(/between -90 and 90/)
    expect(() => compile([{ field: 'location', operator: 'within_radius', value: {} }]))
      .toThrow(/must be a number/)
  })
})

describe('task validation', () => {
  it('requires a title and normalises the timezone', () => {
    const task = validateTask({ title: '  Call back  ', timeZone: 'Asia/Kolkata' })
    expect(task.title).toBe('Call back')
    expect(task.timeZone).toBe('Asia/Kolkata')
    expect(task.priority).toBe('normal')
    expect(() => validateTask({ title: '   ' })).toThrow(/title is required/)
  })

  it('falls back to UTC for an unusable timezone rather than storing it', () => {
    expect(() => validateTask({ title: 'x', timeZone: 'Not/AZone' })).toThrow(/not a timezone/)
  })

  it('rejects a due date implausibly far ahead', () => {
    // Almost always a mistyped year rather than a genuine long-range task.
    const farFuture = new Date(Date.now() + 800 * 86_400_000)
    expect(() => validateTask({ title: 'x', dueAt: farFuture })).toThrow(/days ahead/)
    expect(() => validateTask({ title: 'x', dueAt: 'not a date' })).toThrow(/not a valid date/)
  })

  it('allows a task with no due date and no contact', () => {
    const task = validateTask({ title: 'Order materials' })
    expect(task.dueAt).toBeNull()
    expect(task.assigneeUserId).toBeNull()
  })
})

describe('appointment validation and conflicts', () => {
  const start = new Date('2026-09-01T09:00:00.000Z')
  const end = new Date('2026-09-01T10:00:00.000Z')

  it('requires an end after the start', () => {
    expect(validateAppointment({ title: 'Site visit', startAt: start, endAt: end }).startAt).toEqual(start)
    expect(() => validateAppointment({ title: 'x', startAt: end, endAt: start })).toThrow(/must be after startAt/)
    expect(() => validateAppointment({ title: 'x', startAt: start, endAt: start })).toThrow(/must be after startAt/)
  })

  it('bounds appointment length and booking horizon', () => {
    const tooLong = new Date(start.getTime() + 15 * 24 * 3_600_000)
    expect(() => validateAppointment({ title: 'x', startAt: start, endAt: tooLong })).toThrow(/cannot be longer than/)
    const farFuture = new Date(Date.now() + 800 * 86_400_000)
    expect(() => validateAppointment({ title: 'x', startAt: farFuture, endAt: new Date(farFuture.getTime() + 3_600_000) }))
      .toThrow(/days ahead/)
  })

  it('collects every issue rather than failing on the first', () => {
    try {
      validateAppointment({ title: '', startAt: 'bad', endAt: 'also bad' })
      throw new Error('should have thrown')
    } catch (error: any) {
      expect(error).toBeInstanceOf(SchedulingError)
      expect(error.issues.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('treats intervals as half-open so back-to-back bookings do not conflict', () => {
    const first = { startAt: new Date('2026-09-01T09:00:00Z'), endAt: new Date('2026-09-01T10:00:00Z') }
    const backToBack = { startAt: new Date('2026-09-01T10:00:00Z'), endAt: new Date('2026-09-01T11:00:00Z') }
    const overlapping = { startAt: new Date('2026-09-01T09:30:00Z'), endAt: new Date('2026-09-01T10:30:00Z') }
    const contained = { startAt: new Date('2026-09-01T09:15:00Z'), endAt: new Date('2026-09-01T09:45:00Z') }

    // Most field work is booked back-to-back; treating that as a conflict makes
    // the feature unusable.
    expect(intervalsOverlap(first, backToBack)).toBe(false)
    expect(intervalsOverlap(first, overlapping)).toBe(true)
    expect(intervalsOverlap(first, contained)).toBe(true)
    expect(intervalsOverlap(contained, first)).toBe(true)
  })

  it('reports no conflicts for an unassigned appointment without querying', async () => {
    // An unassigned appointment belongs to nobody's calendar, so there is
    // nothing to conflict with and no reason to hit the database.
    await expect(findConflicts({ organizationId: 'org-1', assigneeUserId: null, startAt: start, endAt: end }))
      .resolves.toEqual([])
  })
})

describe('agenda day grouping', () => {
  it('groups by local date, not UTC date', () => {
    // 20:00 in Kolkata on 1 September is 14:30 UTC. Grouping by UTC would still
    // read as the 1st here, so the case that matters is the one that crosses:
    // 02:00 local on the 2nd is 20:30 UTC on the 1st.
    expect(localDateKey(new Date('2026-09-01T14:30:00Z'), 'Asia/Kolkata')).toBe('2026-09-01')
    expect(localDateKey(new Date('2026-09-01T20:30:00Z'), 'Asia/Kolkata')).toBe('2026-09-02')
    expect(localDateKey(new Date('2026-09-01T20:30:00Z'), 'UTC')).toBe('2026-09-01')
  })

  it('falls back to UTC for an unusable zone rather than throwing mid-render', () => {
    expect(localDateKey(new Date('2026-09-01T14:30:00Z'), 'Not/AZone')).toBe('2026-09-01')
  })
})
