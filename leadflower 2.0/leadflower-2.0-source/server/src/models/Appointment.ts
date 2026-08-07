import { Schema, model } from 'mongoose';

/**
 * An internal appointment.
 *
 * INTERNAL ONLY, and that is a deliberate boundary rather than an unfinished
 * one. There is no Google or Outlook sync here, because two-way calendar sync
 * is a conflict-resolution problem — recurrence, cancellations racing edits,
 * timezone drift, three providers with different semantics — of exactly the
 * kind the build specification warns will consume a project. See
 * REMEDIATION_2_2.md for what completing it would require.
 *
 * Times are stored as instants with the booking timezone recorded alongside.
 * Storing a wall-clock time without its zone is how a 9am site visit becomes
 * 3:30am for the engineer.
 */
const AppointmentSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, default: null, index: true },
  dealId: { type: Schema.Types.ObjectId, default: null },
  title: { type: String, required: true },
  description: String,
  location: String,
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  /** IANA zone the appointment was booked in. */
  timeZone: { type: String, default: 'UTC' },
  assigneeUserId: { type: String, default: null, index: true },
  status: { type: String, enum: ['scheduled', 'completed', 'cancelled', 'no_show'], default: 'scheduled', index: true },
  cancelledReason: String,
  source: { type: String, default: 'manual' },
  createdBy: String,

  // ---- Public booking ----
  bookingPageId: { type: Schema.Types.ObjectId, default: null, index: true },
  /** Unguessable token for the reschedule and cancel links in a confirmation. */
  manageToken: { type: String, default: null, index: true },
  /** Answers to the page's own questions. */
  bookingAnswers: { type: Schema.Types.Mixed, default: undefined },
  consentTextShown: { type: String, default: null },
  consentGivenAt: { type: Date, default: null },
  /** The timezone the person booking was in, for rendering their confirmation. */
  bookerTimeZone: { type: String, default: null },
}, { timestamps: true });

AppointmentSchema.index({ organizationId: 1, startAt: 1 });
AppointmentSchema.index({ organizationId: 1, assigneeUserId: 1, startAt: 1 });
/**
 * The double-booking guard for public booking.
 *
 * Availability is re-checked immediately before writing, but between that check
 * and the write another visitor can take the same slot. Application logic
 * cannot see the other request; this index can. Partial, so it applies only to
 * live bookings on a real person's calendar — cancelled appointments free the
 * slot, and unassigned internal appointments are unaffected.
 */
AppointmentSchema.index(
  { organizationId: 1, assigneeUserId: 1, startAt: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'scheduled', assigneeUserId: { $type: 'string' } } },
);

export default model('Appointment', AppointmentSchema);
