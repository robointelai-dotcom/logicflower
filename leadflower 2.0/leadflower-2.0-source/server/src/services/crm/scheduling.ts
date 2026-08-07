import Appointment from '../../models/Appointment'
import Task from '../../models/Task'
import { HttpError, problemType } from '../../http/problem'
import { isSupportedTimeZone, normaliseTimeZone, zonedParts } from '../sequences/scheduleArithmetic'
import { recordActivity } from './contactActivity'

/**
 * Tasks and appointments.
 *
 * These are the parts of the CRM that exist because something needs a person.
 * That is why neither is modelled on `ScheduledStep`: a scheduled step is work
 * the scheduler will perform, and a task's due date is a prompt to a human, not
 * a trigger. Wiring tasks into the scheduler would mean it repeatedly tries to
 * "execute" something it cannot.
 *
 * Appointments are INTERNAL ONLY. There is no Google or Outlook sync, and that
 * boundary is deliberate rather than unfinished — see REMEDIATION_2_2.md §3.
 */

export const MAX_APPOINTMENT_HOURS = 24 * 14
/** How far ahead a booking may be made. Beyond this is almost always a typo'd year. */
export const MAX_BOOKING_HORIZON_DAYS = 730

export class SchedulingError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join('; '))
    this.name = 'SchedulingError'
    this.issues = issues
  }
}

export interface TaskInput {
  title: string
  description?: string
  contactId?: string | null
  dealId?: string | null
  assigneeUserId?: string | null
  dueAt?: string | Date | null
  timeZone?: string
  priority?: 'low' | 'normal' | 'high'
}

export function validateTask(input: TaskInput): {
  title: string
  description?: string
  assigneeUserId: string | null
  dueAt: Date | null
  timeZone: string
  priority: 'low' | 'normal' | 'high'
} {
  const issues: string[] = []
  const title = String(input.title || '').trim().slice(0, 200)
  if (!title) issues.push('title: a task title is required')

  const priority = input.priority || 'normal'
  if (!['low', 'normal', 'high'].includes(priority)) issues.push('priority: must be low, normal or high')

  const timeZone = String(input.timeZone || 'UTC')
  if (!isSupportedTimeZone(timeZone)) issues.push(`timeZone: "${timeZone}" is not a timezone this system can resolve`)

  let dueAt: Date | null = null
  if (input.dueAt) {
    dueAt = input.dueAt instanceof Date ? input.dueAt : new Date(String(input.dueAt))
    if (Number.isNaN(dueAt.getTime())) issues.push('dueAt: is not a valid date')
    else if (dueAt.getTime() > Date.now() + MAX_BOOKING_HORIZON_DAYS * 86_400_000) {
      // Almost always a mistyped year rather than a genuine two-year-out task.
      issues.push(`dueAt: cannot be more than ${MAX_BOOKING_HORIZON_DAYS} days ahead`)
    }
  }

  if (issues.length) throw new SchedulingError(issues)
  return {
    title,
    ...(input.description ? { description: String(input.description).slice(0, 5_000) } : {}),
    assigneeUserId: input.assigneeUserId ? String(input.assigneeUserId).slice(0, 64) : null,
    dueAt,
    timeZone: normaliseTimeZone(timeZone),
    priority: priority as 'low' | 'normal' | 'high',
  }
}

export interface AppointmentInput {
  title: string
  description?: string
  location?: string
  contactId?: string | null
  dealId?: string | null
  assigneeUserId?: string | null
  startAt: string | Date
  endAt: string | Date
  timeZone?: string
}

export function validateAppointment(input: AppointmentInput): {
  title: string
  description?: string
  location?: string
  assigneeUserId: string | null
  startAt: Date
  endAt: Date
  timeZone: string
} {
  const issues: string[] = []
  const title = String(input.title || '').trim().slice(0, 200)
  if (!title) issues.push('title: an appointment title is required')

  const timeZone = String(input.timeZone || 'UTC')
  if (!isSupportedTimeZone(timeZone)) issues.push(`timeZone: "${timeZone}" is not a timezone this system can resolve`)

  const startAt = input.startAt instanceof Date ? input.startAt : new Date(String(input.startAt))
  const endAt = input.endAt instanceof Date ? input.endAt : new Date(String(input.endAt))
  if (Number.isNaN(startAt.getTime())) issues.push('startAt: is not a valid date')
  if (Number.isNaN(endAt.getTime())) issues.push('endAt: is not a valid date')

  if (!issues.length) {
    if (endAt.getTime() <= startAt.getTime()) issues.push('endAt: must be after startAt')
    else if (endAt.getTime() - startAt.getTime() > MAX_APPOINTMENT_HOURS * 3_600_000) {
      issues.push(`endAt: an appointment cannot be longer than ${MAX_APPOINTMENT_HOURS} hours`)
    }
    if (startAt.getTime() > Date.now() + MAX_BOOKING_HORIZON_DAYS * 86_400_000) {
      issues.push(`startAt: cannot be more than ${MAX_BOOKING_HORIZON_DAYS} days ahead`)
    }
  }

  if (issues.length) throw new SchedulingError(issues)
  return {
    title,
    ...(input.description ? { description: String(input.description).slice(0, 5_000) } : {}),
    ...(input.location ? { location: String(input.location).slice(0, 500) } : {}),
    assigneeUserId: input.assigneeUserId ? String(input.assigneeUserId).slice(0, 64) : null,
    startAt,
    endAt,
    timeZone: normaliseTimeZone(timeZone),
  }
}

/**
 * Do two intervals overlap?
 *
 * Half-open: an appointment ending at 10:00 and one starting at 10:00 do not
 * conflict. Treating them as a conflict would make back-to-back scheduling
 * impossible, which is how most field work is actually booked.
 */
export function intervalsOverlap(a: { startAt: Date; endAt: Date }, b: { startAt: Date; endAt: Date }): boolean {
  return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime()
}

/**
 * Find conflicting appointments for an assignee.
 *
 * Reported, not enforced. Double-booking is sometimes deliberate — a
 * provisional hold, two engineers on one job, a site visit overlapping a call
 * someone will take from the van. Refusing the booking would push the operator
 * into working around the system, so the conflict is surfaced and the decision
 * left with them.
 */
export async function findConflicts(input: {
  organizationId: string
  assigneeUserId: string | null
  startAt: Date
  endAt: Date
  excludeAppointmentId?: string
}): Promise<Array<{ id: string; title: string; startAt: Date; endAt: Date }>> {
  if (!input.assigneeUserId) return []
  const query: Record<string, unknown> = {
    organizationId: input.organizationId,
    assigneeUserId: input.assigneeUserId,
    status: 'scheduled',
    // Half-open overlap, expressed as a query: an existing appointment
    // conflicts when it starts before this one ends and ends after it starts.
    startAt: { $lt: input.endAt },
    endAt: { $gt: input.startAt },
    ...(input.excludeAppointmentId ? { _id: { $ne: input.excludeAppointmentId } } : {}),
  }
  const rows: any[] = await Appointment.find(query).select('title startAt endAt').limit(20).lean()
  return rows.map((row) => ({ id: String(row._id), title: row.title, startAt: row.startAt, endAt: row.endAt }))
}

/**
 * The local date an instant falls on, in a given zone.
 *
 * Used for day grouping in an agenda view. Grouping by UTC date instead would
 * put an 8pm IST appointment on the following day for the person attending it.
 */
export function localDateKey(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, normaliseTimeZone(timeZone))
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

/**
 * Create tasks declared by a pipeline stage.
 *
 * The join between the CRM and the work a stage change implies: entering
 * "Quoted" can raise "chase the quote in 48 hours" against the deal owner.
 * Failures are swallowed for the same reason activity writes are — a task that
 * fails to create must not roll back the stage change it followed.
 */
export async function createStageTasks(input: {
  organizationId: string
  contactId: string
  dealId: string
  templates: Array<{ title: string; dueInHours?: number; priority?: 'low' | 'normal' | 'high' }>
  assigneeUserId: string | null
  timeZone: string
  now: Date
  userId?: string
}): Promise<string[]> {
  const created: string[] = []
  for (const template of (input.templates || []).slice(0, 10)) {
    try {
      const validated = validateTask({
        title: template.title,
        assigneeUserId: input.assigneeUserId,
        dueAt: template.dueInHours ? new Date(input.now.getTime() + template.dueInHours * 3_600_000) : null,
        timeZone: input.timeZone,
        priority: template.priority,
      })
      const task: any = await Task.create({
        organizationId: input.organizationId,
        contactId: input.contactId,
        dealId: input.dealId,
        ...validated,
        source: 'pipeline_stage',
        createdBy: input.userId,
      })
      created.push(String(task._id))
      await recordActivity({
        organizationId: input.organizationId,
        contactId: input.contactId,
        type: 'task.created',
        summary: `Task "${validated.title}" raised by a stage change`,
        entityType: 'Task',
        entityId: String(task._id),
        actorUserId: input.userId,
        occurredAt: input.now,
      })
    } catch {
      // A malformed template must not roll back the stage change that triggered
      // it. The stage change is the truth; the task is a consequence of it.
      continue
    }
  }
  return created
}

export function schedulingProblem(error: unknown): never {
  if (error instanceof SchedulingError) {
    throw new HttpError(400, 'Invalid schedule', error.issues.join('; '), problemType('scheduling-invalid'))
  }
  throw error
}
