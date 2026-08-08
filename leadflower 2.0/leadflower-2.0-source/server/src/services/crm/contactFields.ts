import { HttpError, problemType } from '../../http/problem'

/**
 * The writable shape of a contact, defined once.
 *
 * The create and update handlers each had their own list of fields. They
 * disagreed: update wrote the address, job title, secondary phone, preferred
 * contact method, referrer and lead score, and create silently discarded all of
 * them. An operator filling in the create form lost everything except name,
 * email, phone and company, and was told the contact had saved.
 *
 * Both paths now build their document here. A field added to the schema and
 * added to this list is written by both, or by neither — which is the only way
 * to keep them from drifting apart again.
 *
 * Only keys PRESENT in the input appear in the result, so the same function
 * serves a create (absent means unset) and a patch (absent means leave alone).
 */

/** Free-text fields, all capped at the same length the schema tolerates. */
const TEXT_FIELDS = [
  'firstName', 'lastName', 'name', 'companyName', 'timezone', 'source',
  'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country',
  'jobTitle', 'secondaryPhone', 'referredBy', 'nextActionNote', 'website',
] as const

export const PREFERRED_CONTACT_METHODS = ['email', 'phone', 'sms', 'whatsapp'] as const

export interface ContactFieldOptions {
  /**
   * On create, `lifecycleStatus`, `source` and `tags` are supplied by the
   * caller with defaults, so they are excluded here to avoid writing them
   * twice with different values.
   */
  omit?: readonly string[]
}

export function contactWritableFields(
  body: Record<string, any> | undefined | null,
  options: ContactFieldOptions = {},
): Record<string, unknown> {
  const input = body || {}
  const omit = new Set(options.omit || [])
  const out: Record<string, unknown> = {}

  for (const field of TEXT_FIELDS) {
    if (omit.has(field)) continue
    if (input[field] === undefined) continue
    out[field] = input[field] === null ? null : String(input[field]).slice(0, 240)
  }

  if (!omit.has('email') && input.email !== undefined) {
    out.email = input.email === null ? null : String(input.email).toLowerCase().slice(0, 320)
  }
  if (!omit.has('phone') && input.phone !== undefined) {
    out.phone = input.phone === null ? null : String(input.phone).slice(0, 32)
  }
  if (!omit.has('lifecycleStatus') && input.lifecycleStatus !== undefined) {
    out.lifecycleStatus = String(input.lifecycleStatus)
  }
  if (!omit.has('ownerUserId') && input.ownerUserId !== undefined) {
    out.ownerUserId = input.ownerUserId ? String(input.ownerUserId).slice(0, 64) : null
  }

  if (!omit.has('leadScore') && input.leadScore !== undefined) {
    const score = input.leadScore === null ? null : Number(input.leadScore)
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) {
      throw new HttpError(400, 'Invalid lead score', 'Lead score must be a number between 0 and 100, or null')
    }
    out.leadScore = score
  }

  if (!omit.has('preferredContactMethod') && input.preferredContactMethod !== undefined) {
    const method = input.preferredContactMethod
    if (method !== null && !PREFERRED_CONTACT_METHODS.includes(String(method) as any)) {
      throw new HttpError(400, 'Invalid contact method', 'Preferred contact method must be email, phone, sms, whatsapp, or null')
    }
    out.preferredContactMethod = method === null ? null : String(method)
  }

  if (!omit.has('nextActionAt') && input.nextActionAt !== undefined) {
    if (input.nextActionAt === null) out.nextActionAt = null
    else {
      const nextAction = new Date(String(input.nextActionAt))
      if (Number.isNaN(nextAction.getTime())) throw new HttpError(400, 'Invalid date', 'nextActionAt must be a valid date')
      out.nextActionAt = nextAction
    }
  }

  return out
}

/**
 * Tags on create.
 *
 * The update path refuses tags outright, because replacing the array wholesale
 * bypasses the tag rule engine and an operator would see automation silently
 * not fire. On CREATE there is no existing array to replace and no prior state
 * to reconcile, so tags are accepted and the rules are then run over them by
 * the caller. Refusing them on create only forced every operator to save a
 * contact and immediately edit it, which is not a safety property.
 */
export function creationTags(body: Record<string, any> | undefined | null): string[] {
  const raw = (body || {}).tags
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'Invalid tags', 'Tags must be an array of strings', problemType('invalid-tags'))
  }
  return raw.map((tag) => String(tag))
}
