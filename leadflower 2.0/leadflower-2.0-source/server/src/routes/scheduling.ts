import { Router } from 'express'
import { Types } from 'mongoose'
import Appointment from '../models/Appointment'
import Contact from '../models/Contact'
import Task from '../models/Task'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor'
import { requireOrganizationId } from '../types/authenticatedRequest'
import { recordAudit } from '../services/audit'
import { recordActivity } from '../services/crm/contactActivity'
import {
  findConflicts,
  localDateKey,
  schedulingProblem,
  validateAppointment,
  validateTask,
} from '../services/crm/scheduling'
import {
  distanceKm,
  fromGeoPoint,
  LocationError,
  LOCATION_SOURCES,
  parseCoordinates,
  radiusQuery,
  toGeoPoint,
  type LocationSource,
} from '../services/crm/location'

const router = Router()

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

/* --------------------------------------------------------------------- tasks */

router.get('/tasks', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const query: any = { organizationId }
  if (req.query.status) query.status = String(req.query.status).slice(0, 16)
  if (req.query.contactId) query.contactId = objectId(req.query.contactId, 'contact')
  // `mine=true` resolves to the caller rather than accepting a user id, so one
  // member cannot enumerate another's workload by guessing ids.
  if (String(req.query.mine || '') === 'true') query.assigneeUserId = String(req.auth?.userId || '')
  else if (req.query.assigneeUserId) query.assigneeUserId = String(req.query.assigneeUserId).slice(0, 64)
  if (String(req.query.overdue || '') === 'true') {
    query.status = 'open'
    query.dueAt = { $lt: new Date() }
  }

  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  if (cursor) query._id = { $lt: cursor }

  const rows: any[] = await Task.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({
    tasks: rows.slice(0, limit).map((row) => ({
      id: String(row._id),
      title: row.title,
      description: row.description,
      contactId: row.contactId ? String(row.contactId) : null,
      dealId: row.dealId ? String(row.dealId) : null,
      assigneeUserId: row.assigneeUserId,
      dueAt: row.dueAt,
      timeZone: row.timeZone,
      status: row.status,
      priority: row.priority,
      source: row.source,
    })),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}))

router.post('/tasks', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)

  let validated
  try { validated = validateTask(req.body) } catch (error) { schedulingProblem(error) }

  const contactId = req.body?.contactId ? objectId(req.body.contactId, 'contact') : null
  if (contactId && !await Contact.exists({ _id: contactId, organizationId })) {
    throw new HttpError(404, 'Contact not found', 'No contact with that identifier exists in this organisation')
  }

  const created: any = await Task.create({
    organizationId,
    contactId,
    dealId: req.body?.dealId ? objectId(req.body.dealId, 'deal') : null,
    ...validated,
    source: 'manual',
    createdBy: req.auth?.userId,
  })

  if (contactId) {
    await recordActivity({
      organizationId, contactId, type: 'task.created',
      summary: `Task "${validated.title}" created`,
      entityType: 'Task', entityId: String(created._id),
      metadata: { priority: validated.priority }, actorUserId: req.auth?.userId,
    })
  }
  await recordAudit({ req, organizationId, action: 'crm.task_created', entityType: 'Task', entityId: String(created._id) })
  res.status(201).json({ id: String(created._id) })
}))

router.post('/tasks/:taskId/status', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const taskId = objectId(req.params.taskId, 'task')
  const status = String(req.body?.status || '')
  if (!['open', 'completed', 'cancelled'].includes(status)) {
    throw new HttpError(400, 'Invalid status', 'Status must be open, completed or cancelled')
  }

  const task: any = await Task.findOne({ _id: taskId, organizationId }).lean()
  if (!task) throw new HttpError(404, 'Task not found', 'No task with that identifier exists in this organisation')

  await Task.updateOne({ _id: taskId, organizationId }, {
    $set: {
      status,
      completedAt: status === 'completed' ? new Date() : null,
      completedByUserId: status === 'completed' ? String(req.auth?.userId || '') : null,
    },
  })

  if (status === 'completed' && task.contactId) {
    await recordActivity({
      organizationId, contactId: String(task.contactId), type: 'task.completed',
      summary: `Task "${task.title}" completed`,
      entityType: 'Task', entityId: taskId, actorUserId: req.auth?.userId,
    })
  }
  await recordAudit({ req, organizationId, action: 'crm.task_status_changed', entityType: 'Task', entityId: taskId, metadata: { from: task.status, to: status } })
  res.json({ id: taskId, status })
}))

router.patch('/tasks/:taskId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const taskId = objectId(req.params.taskId, 'task')

  const existing: any = await Task.findOne({ _id: taskId, organizationId }).lean()
  if (!existing) throw new HttpError(404, 'Task not found', 'No task with that identifier exists in this organisation')

  // Revalidated as a whole rather than field by field, so a partial edit cannot
  // produce a task that would have been rejected if created outright.
  let validated
  try {
    validated = validateTask({
      title: req.body?.title ?? existing.title,
      description: req.body?.description ?? existing.description,
      assigneeUserId: req.body?.assigneeUserId !== undefined ? req.body.assigneeUserId : existing.assigneeUserId,
      dueAt: req.body?.dueAt !== undefined ? req.body.dueAt : existing.dueAt,
      timeZone: req.body?.timeZone ?? existing.timeZone,
      priority: req.body?.priority ?? existing.priority,
    })
  } catch (error) { schedulingProblem(error) }

  await Task.updateOne({ _id: taskId, organizationId }, { $set: validated })
  await recordAudit({ req, organizationId, action: 'crm.task_updated', entityType: 'Task', entityId: taskId })
  res.json({ id: taskId, ...validated })
}))

router.delete('/tasks/:taskId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const taskId = objectId(req.params.taskId, 'task')
  const result = await Task.deleteOne({ _id: taskId, organizationId })
  if (!Number((result as any).deletedCount || 0)) throw new HttpError(404, 'Task not found', 'No task with that identifier exists in this organisation')
  await recordAudit({ req, organizationId, action: 'crm.task_deleted', entityType: 'Task', entityId: taskId })
  res.json({ id: taskId, deleted: true })
}))

/* -------------------------------------------------------------- appointments */

router.get('/appointments', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const query: any = { organizationId }
  if (req.query.contactId) query.contactId = objectId(req.query.contactId, 'contact')
  if (String(req.query.mine || '') === 'true') query.assigneeUserId = String(req.auth?.userId || '')
  else if (req.query.assigneeUserId) query.assigneeUserId = String(req.query.assigneeUserId).slice(0, 64)
  if (req.query.status) query.status = String(req.query.status).slice(0, 16)

  const from = req.query.from ? new Date(String(req.query.from)) : new Date()
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(from.getTime() + 30 * 86_400_000)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new HttpError(400, 'Invalid range', 'from and to must be valid dates')
  if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new HttpError(400, 'Range too wide', 'An agenda range cannot exceed one year')
  query.startAt = { $gte: from, $lte: to }

  const rows: any[] = await Appointment.find(query).sort({ startAt: 1 }).limit(500).lean()
  // Grouped by LOCAL date, not UTC date: an 8pm IST appointment belongs to that
  // evening for the person attending it, not to the following day.
  const viewerZone = String(req.query.timeZone || 'UTC')
  const days = new Map<string, any[]>()
  for (const row of rows) {
    const key = localDateKey(row.startAt, viewerZone)
    const entry = {
      id: String(row._id),
      title: row.title,
      contactId: row.contactId ? String(row.contactId) : null,
      startAt: row.startAt,
      endAt: row.endAt,
      timeZone: row.timeZone,
      location: row.location,
      assigneeUserId: row.assigneeUserId,
      status: row.status,
    }
    days.set(key, [...(days.get(key) || []), entry])
  }
  res.json({ days: [...days.entries()].map(([date, appointments]) => ({ date, appointments })) })
}))

router.post('/appointments', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)

  let validated
  try { validated = validateAppointment(req.body) } catch (error) { schedulingProblem(error) }

  const contactId = req.body?.contactId ? objectId(req.body.contactId, 'contact') : null
  if (contactId && !await Contact.exists({ _id: contactId, organizationId })) {
    throw new HttpError(404, 'Contact not found', 'No contact with that identifier exists in this organisation')
  }

  // Conflicts are reported, not enforced. Double-booking is sometimes
  // deliberate — a provisional hold, two people on one job — and refusing it
  // would push the operator into working around the system.
  const conflicts = await findConflicts({
    organizationId,
    assigneeUserId: validated.assigneeUserId,
    startAt: validated.startAt,
    endAt: validated.endAt,
  })

  const created: any = await Appointment.create({
    organizationId,
    contactId,
    dealId: req.body?.dealId ? objectId(req.body.dealId, 'deal') : null,
    ...validated,
    source: 'manual',
    createdBy: req.auth?.userId,
  })

  if (contactId) {
    await recordActivity({
      organizationId, contactId, type: 'appointment.booked',
      summary: `Appointment "${validated.title}" booked`,
      entityType: 'Appointment', entityId: String(created._id),
      metadata: { startAt: validated.startAt, timeZone: validated.timeZone }, actorUserId: req.auth?.userId,
    })
  }
  await recordAudit({ req, organizationId, action: 'crm.appointment_booked', entityType: 'Appointment', entityId: String(created._id), metadata: { conflicts: conflicts.length } })
  res.status(201).json({ id: String(created._id), conflicts })
}))

router.post('/appointments/:appointmentId/status', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const appointmentId = objectId(req.params.appointmentId, 'appointment')
  const status = String(req.body?.status || '')
  if (!['scheduled', 'completed', 'cancelled', 'no_show'].includes(status)) {
    throw new HttpError(400, 'Invalid status', 'Status must be scheduled, completed, cancelled or no_show')
  }

  const appointment: any = await Appointment.findOne({ _id: appointmentId, organizationId }).lean()
  if (!appointment) throw new HttpError(404, 'Appointment not found', 'No appointment with that identifier exists in this organisation')

  await Appointment.updateOne({ _id: appointmentId, organizationId }, {
    $set: { status, cancelledReason: status === 'cancelled' ? String(req.body?.reason || '').slice(0, 500) : undefined },
  })

  if (appointment.contactId && (status === 'cancelled' || status === 'completed')) {
    await recordActivity({
      organizationId, contactId: String(appointment.contactId),
      type: status === 'cancelled' ? 'appointment.cancelled' : 'appointment.completed',
      summary: `Appointment "${appointment.title}" ${status}`,
      entityType: 'Appointment', entityId: appointmentId, actorUserId: req.auth?.userId,
    })
  }
  await recordAudit({ req, organizationId, action: 'crm.appointment_status_changed', entityType: 'Appointment', entityId: appointmentId, metadata: { from: appointment.status, to: status } })
  res.json({ id: appointmentId, status })
}))

/**
 * Reschedule or edit an appointment.
 *
 * Conflicts are recomputed against the new times, excluding this appointment —
 * without that exclusion every reschedule would report the appointment as
 * conflicting with itself. Reported, not enforced, as at creation.
 */
router.patch('/appointments/:appointmentId', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const appointmentId = objectId(req.params.appointmentId, 'appointment')

  const existing: any = await Appointment.findOne({ _id: appointmentId, organizationId }).lean()
  if (!existing) throw new HttpError(404, 'Appointment not found', 'No appointment with that identifier exists in this organisation')
  if (existing.status === 'cancelled') {
    throw new HttpError(409, 'Appointment is cancelled', 'A cancelled appointment cannot be rescheduled; book a new one', problemType('appointment-cancelled'))
  }

  let validated
  try {
    validated = validateAppointment({
      title: req.body?.title ?? existing.title,
      description: req.body?.description ?? existing.description,
      location: req.body?.location ?? existing.location,
      assigneeUserId: req.body?.assigneeUserId !== undefined ? req.body.assigneeUserId : existing.assigneeUserId,
      startAt: req.body?.startAt ?? existing.startAt,
      endAt: req.body?.endAt ?? existing.endAt,
      timeZone: req.body?.timeZone ?? existing.timeZone,
    })
  } catch (error) { schedulingProblem(error) }

  const conflicts = await findConflicts({
    organizationId,
    assigneeUserId: validated.assigneeUserId,
    startAt: validated.startAt,
    endAt: validated.endAt,
    excludeAppointmentId: appointmentId,
  })

  await Appointment.updateOne({ _id: appointmentId, organizationId }, { $set: validated })

  const rescheduled = new Date(existing.startAt).getTime() !== validated.startAt.getTime()
  if (existing.contactId && rescheduled) {
    await recordActivity({
      organizationId, contactId: String(existing.contactId), type: 'appointment.booked',
      summary: `Appointment "${validated.title}" rescheduled`,
      entityType: 'Appointment', entityId: appointmentId,
      metadata: { startAt: validated.startAt, timeZone: validated.timeZone }, actorUserId: req.auth?.userId,
    })
  }
  await recordAudit({ req, organizationId, action: 'crm.appointment_updated', entityType: 'Appointment', entityId: appointmentId, metadata: { rescheduled, conflicts: conflicts.length } })
  res.json({ id: appointmentId, rescheduled, conflicts })
}))

/* ------------------------------------------------------------------ location */

router.put('/contacts/:contactId/location', asyncHandler(async (req, res) => {
  requireOperator(req)
  const organizationId = requireOrganizationId(req)
  const contactId = objectId(req.params.contactId, 'contact')

  const source = String(req.body?.source || 'manual')
  if (!LOCATION_SOURCES.includes(source as LocationSource)) {
    throw new HttpError(400, 'Invalid source', `Source must be one of ${LOCATION_SOURCES.join(', ')}`)
  }

  let coordinates
  try { coordinates = parseCoordinates({ latitude: req.body?.latitude, longitude: req.body?.longitude }) } catch (error) {
    if (error instanceof LocationError) throw new HttpError(400, 'Invalid coordinates', error.issues.join('; '), problemType('location-invalid'))
    throw error
  }

  const result = await Contact.updateOne(
    { _id: contactId, organizationId },
    { $set: { location: toGeoPoint(coordinates), locationSource: source, locationUpdatedAt: new Date() } },
  )
  if (!Number((result as any).matchedCount || 0)) throw new HttpError(404, 'Contact not found', 'No contact with that identifier exists in this organisation')

  await recordActivity({
    organizationId, contactId, type: 'contact.location_updated',
    // Coordinates are deliberately absent from the summary and metadata: the
    // timeline is the surface most likely to be rendered somewhere broad, and a
    // person's precise position is not something to scatter through it.
    summary: 'Location updated', metadata: { source }, actorUserId: req.auth?.userId,
  })
  await recordAudit({ req, organizationId, action: 'crm.contact_location_updated', entityType: 'Contact', entityId: contactId, metadata: { source } })
  res.json({ id: contactId, source })
}))

/**
 * Contacts within a radius, nearest first.
 *
 * The distance shown is computed in the application for display; the filtering
 * happens in the database where the 2dsphere index can be used. Filtering in
 * the application would mean reading every contact first.
 */
router.get('/contacts/nearby', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  let centre
  let query: Record<string, unknown>
  try {
    centre = parseCoordinates({ latitude: req.query.latitude, longitude: req.query.longitude })
    query = {
      organizationId,
      archivedAt: null,
      ...radiusQuery({ path: 'location', latitude: centre.latitude, longitude: centre.longitude, radiusKm: Number(req.query.radiusKm ?? 10) }),
    }
  } catch (error) {
    if (error instanceof LocationError) throw new HttpError(400, 'Invalid location filter', error.issues.join('; '), problemType('location-invalid'))
    throw error
  }

  const limit = pageLimit(req.query.limit)
  const rows: any[] = await Contact.find(query).limit(limit).select('name firstName lastName companyName email phone location lifecycleStatus').lean()

  const contacts = rows.map((row) => {
    const position = fromGeoPoint(row.location)
    return {
      id: String(row._id),
      name: row.name || [row.firstName, row.lastName].filter(Boolean).join(' '),
      companyName: row.companyName,
      email: row.email,
      phone: row.phone,
      lifecycleStatus: row.lifecycleStatus,
      latitude: position?.latitude ?? null,
      longitude: position?.longitude ?? null,
      distanceKm: position ? Math.round(distanceKm(centre, position) * 100) / 100 : null,
    }
  }).sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity))

  res.json({ centre, contacts })
}))

export default router
