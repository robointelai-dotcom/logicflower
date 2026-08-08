import crypto from 'crypto'
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { Types } from 'mongoose'
import Appointment from '../models/Appointment'
import BookingPage from '../models/BookingPage'
import Contact from '../models/Contact'
import Organization from '../models/Organization'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { pageLimit } from '../http/cursor'
import { requireOrganizationId } from '../types/authenticatedRequest'
import { recordAudit } from '../services/audit'
import { recordActivity } from '../services/crm/contactActivity'
import { applyTagChanges } from '../services/crm/tags'
import { enrolContact } from '../services/sequences/enrolmentService'
import { normalizeEmail, normalizePhone } from '../services/batchNormalization'
import {
  AvailabilityError,
  assertValidAvailability,
  generateSlots,
  groupSlotsByDay,
  isSlotBookable,
  type AvailabilityConfig,
  type BusyInterval,
} from '../services/crm/availability'

/**
 * Booking pages.
 *
 * The public half is unauthenticated by necessity — someone booking has no
 * account — which makes it as exposed as the hosted forms. Same controls apply:
 * an unguessable slug, the organisation derived from the matched page, only
 * declared fields read, per-IP rate limiting, and no response that reveals
 * whether a contact already existed.
 */

const router = Router()
export const publicBookingRouter = Router()

const availabilityLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false })
const bookingLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false })

const BOOKING_FIELDS = new Set(['firstName', 'lastName', 'name', 'companyName', 'email', 'phone', 'notes'])

function objectId(value: unknown, label: string): string {
  const id = String(value || '')
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, `Invalid ${label}`, `${label} identifier is invalid`)
  return id
}

function requireOperator(req: any): void {
  if (!['owner', 'admin', 'operator'].includes(String(req.auth?.role || ''))) {
    throw new HttpError(403, 'Insufficient role', 'Owner, admin, or operator role is required')
  }
}

function availabilityFrom(page: any): AvailabilityConfig {
  return {
    timeZone: String(page.timeZone || 'UTC'),
    slotMinutes: Number(page.slotMinutes || 30),
    slotIntervalMinutes: Number(page.slotIntervalMinutes || page.slotMinutes || 30),
    bufferBeforeMinutes: Number(page.bufferBeforeMinutes || 0),
    bufferAfterMinutes: Number(page.bufferAfterMinutes || 0),
    minimumNoticeMinutes: Number(page.minimumNoticeMinutes || 0),
    horizonDays: Number(page.horizonDays || 30),
    workingWindows: (page.workingWindows || []).map((window: any) => ({
      weekday: Number(window.weekday),
      startMinute: Number(window.startMinute),
      endMinute: Number(window.endMinute),
    })),
    blackoutDates: (page.blackoutDates || []).map(String),
  }
}

/**
 * Appointments already on the assignee's calendar.
 *
 * Scoped to the person, not the page. Two booking pages pointing at the same
 * assignee must see each other's bookings, or they will cheerfully double-book
 * one human.
 */
async function busyFor(page: any, from: Date, to: Date): Promise<BusyInterval[]> {
  const query: Record<string, unknown> = {
    organizationId: String(page.organizationId),
    status: 'scheduled',
    startAt: { $lt: to },
    endAt: { $gt: from },
  }
  if (page.assigneeUserId) query.assigneeUserId = String(page.assigneeUserId)
  else query.bookingPageId = page._id
  const rows: any[] = await Appointment.find(query).select('startAt endAt').limit(1_000).lean()
  return rows.map((row) => ({ startAt: new Date(row.startAt), endAt: new Date(row.endAt) }))
}

/* ---------------------------------------------------------- management (auth) */

router.get('/pages', asyncHandler(async (req, res) => {
  const rows: any[] = await BookingPage.find({ organizationId: requireOrganizationId(req) }).sort({ _id: -1 }).limit(100).lean()
  res.json({
    pages: rows.map((row) => ({
      id: String(row._id), name: row.name, title: row.title, slug: row.slug, status: row.status,
      timeZone: row.timeZone, slotMinutes: row.slotMinutes, assigneeUserId: row.assigneeUserId,
      bookingCount: Number(row.bookingCount || 0),
      workingWindows: row.workingWindows, horizonDays: row.horizonDays,
    })),
  })
}))

router.post('/pages', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const name = String(req.body?.name || '').trim().slice(0, 120)
  const title = String(req.body?.title || name).trim().slice(0, 200)
  if (!name) throw new HttpError(400, 'Name required', 'A booking page name is required')

  const draft = {
    timeZone: String(req.body?.timeZone || 'UTC'),
    slotMinutes: Number(req.body?.slotMinutes ?? 30),
    slotIntervalMinutes: Number(req.body?.slotIntervalMinutes ?? req.body?.slotMinutes ?? 30),
    bufferBeforeMinutes: Number(req.body?.bufferBeforeMinutes ?? 0),
    bufferAfterMinutes: Number(req.body?.bufferAfterMinutes ?? 0),
    minimumNoticeMinutes: Number(req.body?.minimumNoticeMinutes ?? 120),
    horizonDays: Number(req.body?.horizonDays ?? 30),
    workingWindows: Array.isArray(req.body?.workingWindows) ? req.body.workingWindows : [],
    blackoutDates: Array.isArray(req.body?.blackoutDates) ? req.body.blackoutDates.map(String).slice(0, 200) : [],
  }
  // Validated at save, so a page cannot be published in a state that silently
  // offers nothing.
  try { assertValidAvailability(draft as AvailabilityConfig) } catch (error) {
    if (error instanceof AvailabilityError) throw new HttpError(400, 'Availability is invalid', error.issues.join('; '), problemType('availability-invalid'))
    throw error
  }

  const fields = (Array.isArray(req.body?.fields) ? req.body.fields : []).slice(0, 20).map((field: any, position: number) => {
    const name = String(field?.field || '')
    if (!BOOKING_FIELDS.has(name)) throw new HttpError(400, 'Unknown field', `"${name}" is not a collectable booking field`, problemType('booking-field-invalid'))
    return { field: name, label: String(field?.label || name).slice(0, 200), required: Boolean(field?.required), position }
  })

  try {
    const created: any = await BookingPage.create({
      organizationId, name, title,
      description: req.body?.description, location: req.body?.location,
      slug: crypto.randomBytes(18).toString('base64url'),
      status: 'draft',
      assigneeUserId: req.body?.assigneeUserId ? String(req.body.assigneeUserId).slice(0, 64) : null,
      ...draft,
      fields,
      enrolSequenceId: req.body?.enrolSequenceId ? objectId(req.body.enrolSequenceId, 'sequence') : null,
      applyTags: Array.isArray(req.body?.applyTags) ? req.body.applyTags.map(String).slice(0, 20) : [],
      successMessage: String(req.body?.successMessage || 'Booked. A confirmation is on its way.').slice(0, 500),
      consentText: req.body?.consentText ? String(req.body.consentText).slice(0, 2_000) : null,
      allowedOrigins: Array.isArray(req.body?.allowedOrigins) ? req.body.allowedOrigins.map(String).slice(0, 20) : [],
      createdBy: req.auth?.userId,
    })
    await recordAudit({ req, organizationId, action: 'crm.booking_page_created', entityType: 'BookingPage', entityId: String(created._id), metadata: { name } })
    res.status(201).json({ id: String(created._id), slug: created.slug, status: 'draft' })
  } catch (error: any) {
    if (Number(error?.code) === 11_000) throw new HttpError(409, 'Page already exists', 'A booking page with that name already exists', problemType('booking-page-duplicate'))
    throw error
  }
}))

/**
 * Edit a booking page.
 *
 * The slug is deliberately NOT editable. It is the address a customer has been
 * given, put in a confirmation email and possibly bookmarked — changing it
 * silently breaks every one of those. Duplicating gives a new address when one
 * is genuinely wanted.
 */
router.patch('/pages/:pageId', asyncHandler(async (req: any, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const pageId = objectId(req.params.pageId, 'page')

  const existing: any = await BookingPage.findOne({ _id: pageId, organizationId }).lean()
  if (!existing) throw new HttpError(404, 'Page not found', 'No booking page with that identifier exists in this organisation')

  const update: Record<string, unknown> = {}
  for (const field of ['name', 'title', 'description', 'location', 'successMessage', 'consentText'] as const) {
    if (req.body?.[field] !== undefined) update[field] = String(req.body[field]).slice(0, 2_000)
  }
  if (req.body?.assigneeUserId !== undefined) update.assigneeUserId = req.body.assigneeUserId ? String(req.body.assigneeUserId).slice(0, 64) : null
  if (req.body?.enrolSequenceId !== undefined) update.enrolSequenceId = req.body.enrolSequenceId ? objectId(req.body.enrolSequenceId, 'sequence') : null
  if (Array.isArray(req.body?.applyTags)) update.applyTags = req.body.applyTags.map(String).slice(0, 20)

  // Availability is revalidated as a WHOLE, merging changes over the existing
  // settings, so a partial edit cannot produce a page that would have been
  // rejected at creation — a two-hour window with a three-hour appointment, say.
  const availabilityKeys = ['timeZone', 'slotMinutes', 'slotIntervalMinutes', 'bufferBeforeMinutes', 'bufferAfterMinutes', 'minimumNoticeMinutes', 'horizonDays', 'workingWindows', 'blackoutDates'] as const
  if (availabilityKeys.some((key) => req.body?.[key] !== undefined)) {
    const merged = {
      timeZone: String(req.body?.timeZone ?? existing.timeZone),
      slotMinutes: Number(req.body?.slotMinutes ?? existing.slotMinutes),
      slotIntervalMinutes: Number(req.body?.slotIntervalMinutes ?? existing.slotIntervalMinutes ?? existing.slotMinutes),
      bufferBeforeMinutes: Number(req.body?.bufferBeforeMinutes ?? existing.bufferBeforeMinutes ?? 0),
      bufferAfterMinutes: Number(req.body?.bufferAfterMinutes ?? existing.bufferAfterMinutes ?? 0),
      minimumNoticeMinutes: Number(req.body?.minimumNoticeMinutes ?? existing.minimumNoticeMinutes ?? 0),
      horizonDays: Number(req.body?.horizonDays ?? existing.horizonDays),
      workingWindows: Array.isArray(req.body?.workingWindows) ? req.body.workingWindows : existing.workingWindows,
      blackoutDates: Array.isArray(req.body?.blackoutDates) ? req.body.blackoutDates.map(String).slice(0, 200) : existing.blackoutDates,
    }
    try { assertValidAvailability(merged as AvailabilityConfig) } catch (error) {
      if (error instanceof AvailabilityError) throw new HttpError(400, 'Availability is invalid', error.issues.join('; '), problemType('availability-invalid'))
      throw error
    }
    // A published page whose new settings offer nothing would show a customer an
    // empty calendar, so it is refused rather than silently emptied.
    if (existing.status === 'published') {
      const slots = generateSlots({ config: merged as AvailabilityConfig, busy: [], from: new Date(), now: new Date(), maxSlots: 1 })
      if (!slots.length) {
        throw new HttpError(409, 'No slots available', 'These settings would show visitors an empty calendar. This page is live, so the change is refused.', problemType('booking-page-no-slots'))
      }
    }
    Object.assign(update, merged)
  }

  if (Array.isArray(req.body?.fields)) {
    update.fields = req.body.fields.slice(0, 20).map((field: any, position: number) => {
      const name = String(field?.field || '')
      if (!BOOKING_FIELDS.has(name)) throw new HttpError(400, 'Unknown field', `"${name}" is not a collectable booking field`, problemType('booking-field-invalid'))
      return { field: name, label: String(field?.label || name).slice(0, 200), required: Boolean(field?.required), position }
    })
  }

  if (req.body?.slug !== undefined) {
    throw new HttpError(409, 'The address cannot be changed', 'Customers may already hold this link. Duplicate the page if you need a new address.', problemType('booking-slug-locked'))
  }

  if (!Object.keys(update).length) throw new HttpError(400, 'Nothing to update', 'Supply at least one field to change')
  await BookingPage.updateOne({ _id: pageId, organizationId }, { $set: update })
  await recordAudit({ req, organizationId, action: 'crm.booking_page_updated', entityType: 'BookingPage', entityId: pageId, metadata: { fields: Object.keys(update) } })
  res.json({ id: pageId, updated: Object.keys(update) })
}))

router.get('/pages/:pageId', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const pageId = objectId(req.params.pageId, 'page')
  const page: any = await BookingPage.findOne({ _id: pageId, organizationId }).lean()
  if (!page) throw new HttpError(404, 'Page not found', 'No booking page with that identifier exists in this organisation')
  res.json({ page: { ...page, id: String(page._id), _id: undefined } })
}))

/** A copy, with a fresh address and always as a draft. */
router.post('/pages/:pageId/duplicate', asyncHandler(async (req: any, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const pageId = objectId(req.params.pageId, 'page')
  const page: any = await BookingPage.findOne({ _id: pageId, organizationId }).lean()
  if (!page) throw new HttpError(404, 'Page not found', 'No booking page with that identifier exists in this organisation')

  const created: any = await BookingPage.create({
    ...page, _id: undefined,
    name: `${page.name} (copy)`,
    slug: crypto.randomBytes(18).toString('base64url'),
    // A copy never inherits live status, so duplicating cannot publish.
    status: 'draft', bookingCount: 0,
    createdAt: undefined, updatedAt: undefined,
    createdBy: req.auth?.userId,
  })
  res.status(201).json({ id: String(created._id), slug: created.slug })
}))

router.delete('/pages/:pageId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const pageId = objectId(req.params.pageId, 'page')

  // Appointments already booked survive. Deleting a page must not erase a
  // commitment somebody made to a customer.
  const upcoming = await Appointment.countDocuments({ organizationId, bookingPageId: pageId, status: 'scheduled', startAt: { $gte: new Date() } })
  if (upcoming > 0 && String(req.query.confirm || '') !== 'keep-appointments') {
    throw new HttpError(409, 'Appointments are still booked', `${upcoming} upcoming appointment(s) came from this page. They will be kept. Add ?confirm=keep-appointments to proceed.`, problemType('booking-page-has-appointments'))
  }
  const result = await BookingPage.deleteOne({ _id: pageId, organizationId })
  if (!Number((result as any).deletedCount || 0)) throw new HttpError(404, 'Page not found', 'No booking page with that identifier exists in this organisation')
  await recordAudit({ req, organizationId, action: 'crm.booking_page_deleted', entityType: 'BookingPage', entityId: pageId, metadata: { upcomingAppointmentsKept: upcoming } })
  res.json({ id: pageId, deleted: true, appointmentsKept: upcoming })
}))

router.post('/pages/:pageId/status', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const pageId = objectId(req.params.pageId, 'page')
  const status = String(req.body?.status || '')
  if (!['draft', 'published', 'disabled'].includes(status)) throw new HttpError(400, 'Invalid status', 'Status must be draft, published or disabled')

  const page: any = await BookingPage.findOne({ _id: pageId, organizationId }).lean()
  if (!page) throw new HttpError(404, 'Page not found', 'No booking page with that identifier exists in this organisation')
  if (status === 'published') {
    // Publishing a page that can never offer a slot is the most confusing
    // possible failure, so it is refused here rather than discovered by a
    // customer looking at an empty calendar.
    const slots = generateSlots({ config: availabilityFrom(page), busy: [], from: new Date(), now: new Date(), maxSlots: 1 })
    if (!slots.length) {
      throw new HttpError(409, 'No slots available', 'This page would show an empty calendar. Check its working hours, horizon and notice period before publishing.', problemType('booking-page-no-slots'))
    }
  }
  await BookingPage.updateOne({ _id: pageId, organizationId }, { $set: { status } })
  res.json({ id: pageId, status })
}))

router.get('/appointments', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const from = req.query.from ? new Date(String(req.query.from)) : new Date()
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(from.getTime() + 30 * 86_400_000)
  const rows: any[] = await Appointment.find({
    organizationId, bookingPageId: { $ne: null }, startAt: { $gte: from, $lte: to },
  }).sort({ startAt: 1 }).limit(pageLimit(req.query.limit)).lean()
  res.json({
    appointments: rows.map((row) => ({
      id: String(row._id), title: row.title, contactId: row.contactId ? String(row.contactId) : null,
      startAt: row.startAt, endAt: row.endAt, timeZone: row.timeZone, status: row.status,
      assigneeUserId: row.assigneeUserId, bookerTimeZone: row.bookerTimeZone, bookingAnswers: row.bookingAnswers,
    })),
  })
}))

/* -------------------------------------------------------------- public (open) */

async function pageBySlug(slug: string) {
  // tenant-safe: public endpoint; the unguessable slug is the identifier and the organisation is derived from the matched page
  const page: any = await BookingPage.findOne({ slug: String(slug || '').slice(0, 64), status: 'published' }).lean()
  return page || null
}

publicBookingRouter.get('/:slug', availabilityLimiter, asyncHandler(async (req, res) => {
  const page = await pageBySlug(String(req.params.slug || ''))
  if (!page) throw new HttpError(404, 'Booking page not found', 'No published booking page matches this address', problemType('booking-page-not-found'))
  const organization: any = await Organization.findOne({ _id: page.organizationId }).select('name').lean()
  res.json({
    title: page.title,
    description: page.description,
    location: page.location,
    businessName: organization?.name || '',
    timeZone: page.timeZone,
    slotMinutes: page.slotMinutes,
    fields: [...(page.fields || [])].sort((a: any, b: any) => a.position - b.position),
    consentText: page.consentText,
    successMessage: page.successMessage,
  })
}))

publicBookingRouter.get('/:slug/availability', availabilityLimiter, asyncHandler(async (req, res) => {
  const page = await pageBySlug(String(req.params.slug || ''))
  if (!page) throw new HttpError(404, 'Booking page not found', 'No published booking page matches this address', problemType('booking-page-not-found'))

  const now = new Date()
  const from = req.query.from ? new Date(String(req.query.from)) : now
  if (Number.isNaN(from.getTime())) throw new HttpError(400, 'Invalid date', 'from must be a valid date')
  const to = new Date(Math.min(
    (req.query.to ? new Date(String(req.query.to)) : new Date(from.getTime() + 14 * 86_400_000)).getTime(),
    now.getTime() + Number(page.horizonDays || 30) * 86_400_000,
  ))

  const config = availabilityFrom(page)
  const slots = generateSlots({ config, busy: await busyFor(page, from, to), from, to, now, maxSlots: 500 })

  res.setHeader('Cache-Control', 'no-store')
  res.json({
    timeZone: page.timeZone,
    slotMinutes: page.slotMinutes,
    // Grouped by the BUSINESS's local date. The visitor's browser renders each
    // instant in their own zone; the server never guesses where they are.
    days: groupSlotsByDay(slots, page.timeZone).map((day) => ({
      date: day.date,
      slots: day.slots.map((slot) => ({ startAt: slot.startAt, endAt: slot.endAt })),
    })),
  })
}))

publicBookingRouter.post('/:slug/bookings', bookingLimiter, asyncHandler(async (req, res) => {
  const page = await pageBySlug(String(req.params.slug || ''))
  if (!page) throw new HttpError(404, 'Booking page not found', 'No published booking page matches this address', problemType('booking-page-not-found'))

  const organizationId = String(page.organizationId)
  const origin = String(req.headers.origin || '').slice(0, 200)
  if ((page.allowedOrigins || []).length && origin && !page.allowedOrigins.includes(origin)) {
    throw new HttpError(403, 'Origin rejected', 'This booking page does not accept requests from that origin', problemType('booking-origin-rejected'))
  }

  const startAt = new Date(String(req.body?.startAt || ''))
  if (Number.isNaN(startAt.getTime())) throw new HttpError(400, 'Invalid time', 'A valid startAt is required')

  const now = new Date()
  const config = availabilityFrom(page)
  const window = { from: new Date(startAt.getTime() - 86_400_000), to: new Date(startAt.getTime() + 86_400_000) }

  // Re-checked against live appointments, never against the list the visitor
  // was shown — that list may be minutes old.
  const check = isSlotBookable({ config, busy: await busyFor(page, window.from, window.to), startAt, now })
  if (!check.bookable) {
    throw new HttpError(409, 'That time is no longer available', 'Someone may have just taken it. Choose another slot.', problemType('booking-slot-unavailable'))
  }

  // Only declared fields are read; anything else in the body is ignored.
  const answers: Record<string, string> = {}
  for (const field of page.fields || []) {
    const raw = String((req.body?.answers ?? {})[field.field] ?? '').trim()
    if (!raw) {
      if (field.required) throw new HttpError(400, 'Missing detail', `"${field.label}" is required`, problemType('booking-field-required'))
      continue
    }
    answers[field.field] = raw.slice(0, 2_000)
  }

  const email = answers.email ? normalizeEmail(answers.email) : ''
  const phoneRaw = answers.phone ? normalizePhone(answers.phone, '') : ''
  const phone = phoneRaw.startsWith('+') ? phoneRaw : ''
  if (!email && !phone) {
    throw new HttpError(400, 'Contact detail required', 'An email address or phone number is needed to send a confirmation', problemType('booking-no-address'))
  }

  const identifiers: Array<Record<string, unknown>> = []
  if (email) identifiers.push({ email })
  if (phone) identifiers.push({ phone })
  const existing: any = await Contact.findOne({ organizationId, $or: identifiers }).select('_id').lean()

  let contactId: string
  if (existing) {
    contactId = String(existing._id)
    await Contact.updateOne({ _id: contactId, organizationId }, {
      $set: {
        ...(email ? { email } : {}), ...(phone ? { phone } : {}),
        ...(answers.firstName ? { firstName: answers.firstName.slice(0, 120) } : {}),
        ...(answers.lastName ? { lastName: answers.lastName.slice(0, 120) } : {}),
        ...(answers.companyName ? { companyName: answers.companyName.slice(0, 240) } : {}),
      },
    })
  } else {
    const created: any = await Contact.create({
      organizationId, email: email || undefined, phone: phone || undefined,
      firstName: answers.firstName?.slice(0, 120), lastName: answers.lastName?.slice(0, 120),
      name: answers.name?.slice(0, 240), companyName: answers.companyName?.slice(0, 240),
      source: `booking:${page.name}`, lifecycleStatus: 'engaged',
    })
    contactId = String(created._id)
    await recordActivity({ organizationId, contactId, type: 'contact.created', summary: `Contact created from booking "${page.title}"` })
  }

  const manageToken = crypto.randomBytes(24).toString('base64url')
  let appointmentId: string
  try {
    const appointment: any = await Appointment.create({
      organizationId, contactId,
      bookingPageId: page._id,
      title: page.title,
      description: answers.notes,
      location: page.location,
      startAt,
      endAt: new Date(startAt.getTime() + Number(page.slotMinutes || 30) * 60_000),
      timeZone: page.timeZone,
      assigneeUserId: page.assigneeUserId || null,
      status: 'scheduled',
      source: 'booking_page',
      manageToken,
      bookingAnswers: answers,
      consentTextShown: page.consentText || null,
      consentGivenAt: page.consentText ? new Date() : null,
      bookerTimeZone: req.body?.timeZone ? String(req.body.timeZone).slice(0, 64) : null,
    })
    appointmentId = String(appointment._id)
  } catch (error: any) {
    // The unique index catching a simultaneous booking of the same slot. The
    // availability re-check above cannot see another request in flight; this
    // can.
    if (Number(error?.code) === 11_000) {
      throw new HttpError(409, 'That time was just taken', 'Someone booked this slot moments ago. Choose another.', problemType('booking-slot-unavailable'))
    }
    throw error
  }

  if (page.applyTags?.length) {
    await applyTagChanges({ organizationId, contactId, add: page.applyTags, source: `booking:${page.name}` })
  }
  await recordActivity({
    organizationId, contactId, type: 'appointment.booked',
    summary: `Booked "${page.title}"`, entityType: 'Appointment', entityId: appointmentId,
    metadata: { startAt, timeZone: page.timeZone },
  })

  // Confirmation and reminders run through the sequence engine rather than a
  // separate mail path, so they inherit suppression, quiet hours and the
  // reply-exits-everything rule.
  if (page.enrolSequenceId) {
    await enrolContact({ organizationId, sequenceId: String(page.enrolSequenceId), contactId, source: `booking:${page.name}` })
  }
  await BookingPage.updateOne({ _id: page._id, organizationId }, { $inc: { bookingCount: 1 } })

  res.status(201).json({
    booked: true,
    startAt,
    endAt: new Date(startAt.getTime() + Number(page.slotMinutes || 30) * 60_000),
    timeZone: page.timeZone,
    message: page.successMessage,
    // The token for the cancel and reschedule links in the confirmation.
    manageToken,
  })
}))

/** Cancel via the link in a confirmation. Identified only by the token. */
publicBookingRouter.post('/manage/:token/cancel', bookingLimiter, asyncHandler(async (req, res) => {
  const token = String(req.params.token || '').slice(0, 128)
  // tenant-safe: public endpoint; the unguessable per-booking token is the identifier and the organisation is derived from the matched appointment
  const appointment: any = await Appointment.findOne({ manageToken: token, status: 'scheduled' }).select('_id organizationId contactId title').lean()
  // The same response whether the token matched or not, so this cannot be used
  // to probe which tokens are live.
  if (!appointment) return res.json({ cancelled: true })

  const organizationId = String(appointment.organizationId)
  await Appointment.updateOne({ _id: appointment._id, organizationId }, {
    $set: { status: 'cancelled', cancelledReason: String(req.body?.reason || 'Cancelled by the person who booked').slice(0, 500) },
  })
  await recordActivity({
    organizationId, contactId: String(appointment.contactId), type: 'appointment.cancelled',
    summary: `"${appointment.title}" cancelled by the person who booked`,
    entityType: 'Appointment', entityId: String(appointment._id),
  })
  res.json({ cancelled: true })
}))

export default router
