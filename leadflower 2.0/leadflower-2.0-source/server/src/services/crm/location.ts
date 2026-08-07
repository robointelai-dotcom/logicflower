/**
 * Location handling.
 *
 * Small module, one job: keep longitude and latitude the right way round.
 *
 * GeoJSON stores `[longitude, latitude]`, which is the reverse of how every
 * human writes a coordinate pair and of what most mapping UIs hand you. Getting
 * it backwards does not error — it silently places a contact in Chennai
 * somewhere in the Indian Ocean, and a radius query then returns nothing, which
 * reads as "no contacts nearby" rather than as a bug. So every function here
 * takes named `latitude`/`longitude` arguments and the swap happens once, in
 * one place.
 */

export const EARTH_RADIUS_KM = 6_378.1
/** Beyond this a radius filter is not targeting, it is a full scan. */
export const MAX_RADIUS_KM = 20_000

export const LOCATION_SOURCES = ['device_gps', 'form', 'import', 'manual'] as const
export type LocationSource = (typeof LOCATION_SOURCES)[number]

export interface Coordinates {
  latitude: number
  longitude: number
}

export interface GeoPoint {
  type: 'Point'
  /** GeoJSON order: [longitude, latitude]. */
  coordinates: [number, number]
}

export class LocationError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join('; '))
    this.name = 'LocationError'
    this.issues = issues
  }
}

/**
 * Validate a coordinate pair.
 *
 * The 0,0 check is not pedantry. "Null Island" is where a contact lands when a
 * form submits empty strings that coerce to zero, and it is far more often a
 * bug than a real position in the Gulf of Guinea. Refusing it surfaces the bug
 * instead of quietly creating a contact 500km off the coast of Ghana.
 */
export function parseCoordinates(input: { latitude: unknown; longitude: unknown }): Coordinates {
  const issues: string[] = []
  const latitude = typeof input.latitude === 'number' ? input.latitude : Number(String(input.latitude ?? '').trim())
  const longitude = typeof input.longitude === 'number' ? input.longitude : Number(String(input.longitude ?? '').trim())

  if (!Number.isFinite(latitude)) issues.push('latitude: must be a number')
  else if (latitude < -90 || latitude > 90) issues.push('latitude: must be between -90 and 90')

  if (!Number.isFinite(longitude)) issues.push('longitude: must be a number')
  else if (longitude < -180 || longitude > 180) issues.push('longitude: must be between -180 and 180')

  if (!issues.length && latitude === 0 && longitude === 0) {
    issues.push('latitude/longitude: 0,0 is almost always an empty form field rather than a real position; supply real coordinates or leave the location unset')
  }

  if (issues.length) throw new LocationError(issues)
  return { latitude, longitude }
}

/** Convert to storage form. The only place the axis order is swapped. */
export function toGeoPoint(coordinates: Coordinates): GeoPoint {
  return { type: 'Point', coordinates: [coordinates.longitude, coordinates.latitude] }
}

/** Convert back. The only other place the axis order is swapped. */
export function fromGeoPoint(point: unknown): Coordinates | null {
  const candidate = point as GeoPoint | undefined
  if (!candidate || candidate.type !== 'Point' || !Array.isArray(candidate.coordinates)) return null
  const [longitude, latitude] = candidate.coordinates
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  return { latitude: latitude as number, longitude: longitude as number }
}

export function assertRadiusKm(value: unknown): number {
  const radiusKm = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) throw new LocationError(['radiusKm: must be a positive number'])
  if (radiusKm > MAX_RADIUS_KM) throw new LocationError([`radiusKm: cannot exceed ${MAX_RADIUS_KM}`])
  return radiusKm
}

/**
 * Build a radius predicate for a GeoJSON point field.
 *
 * `$geoWithin` with `$centerSphere` rather than `$near`, deliberately. `$near`
 * cannot appear inside `$or`, so using it would mean any-match segments
 * containing a location condition fail at query time rather than at
 * compilation — a failure the person building the segment would never see
 * coming. `$centerSphere` composes anywhere.
 *
 * `$centerSphere` takes its radius in radians, which is another silent-wrong-
 * answer trap: passing kilometres directly yields a radius of thousands of
 * earth-circumferences and matches everything.
 */
export function radiusQuery(input: { path: string; latitude: number; longitude: number; radiusKm: number }): Record<string, unknown> {
  const coordinates = parseCoordinates({ latitude: input.latitude, longitude: input.longitude })
  const radiusKm = assertRadiusKm(input.radiusKm)
  return {
    [input.path]: {
      $geoWithin: {
        $centerSphere: [[coordinates.longitude, coordinates.latitude], radiusKm / EARTH_RADIUS_KM],
      },
    },
  }
}

/**
 * Great-circle distance in kilometres.
 *
 * Used for display — "3.2km away" next to a contact — not for filtering.
 * Filtering happens in the database, where an index can be used; computing
 * distance in the application to filter would mean reading the whole
 * collection first.
 */
export function distanceKm(from: Coordinates, to: Coordinates): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180
  const deltaLat = toRadians(to.latitude - from.latitude)
  const deltaLng = toRadians(to.longitude - from.longitude)
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(deltaLng / 2) ** 2
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
