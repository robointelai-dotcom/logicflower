import { Schema, model } from 'mongoose';

/**
 * A public booking page.
 *
 * The piece that separates a follow-up tool from something an appointment
 * business can actually run on. A customer opens a link, sees real availability
 * in their own timezone, books, and the appointment lands in the calendar with
 * a confirmation and a reminder.
 *
 * Addressed by an unguessable slug rather than the document id, so the estate
 * cannot be walked by incrementing a number.
 */
const WorkingWindowSchema = new Schema({
  weekday: { type: Number, required: true, min: 0, max: 6 },
  startMinute: { type: Number, required: true, min: 0, max: 1_440 },
  endMinute: { type: Number, required: true, min: 0, max: 1_440 },
}, { _id: false });

const BookingFieldSchema = new Schema({
  field: { type: String, required: true },
  label: { type: String, required: true },
  required: { type: Boolean, default: false },
  position: { type: Number, default: 0 },
}, { _id: false });

const BookingPageSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  /** Shown to the person booking. */
  title: { type: String, required: true },
  description: String,
  location: String,
  /** Unguessable public identifier. */
  slug: { type: String, required: true, unique: true },
  status: { type: String, enum: ['draft', 'published', 'disabled'], default: 'draft', index: true },

  /**
   * Whose calendar this books into. Availability is computed against this
   * person's existing appointments; without it, two booking pages would happily
   * double-book the same human.
   */
  assigneeUserId: { type: String, default: null, index: true },

  /**
   * Working hours are wall-clock in THIS timezone, not the visitor's. A visitor
   * elsewhere sees the same instant rendered in their own zone.
   */
  timeZone: { type: String, default: 'UTC' },
  slotMinutes: { type: Number, default: 30 },
  slotIntervalMinutes: { type: Number, default: 30 },
  bufferBeforeMinutes: { type: Number, default: 0 },
  bufferAfterMinutes: { type: Number, default: 0 },
  minimumNoticeMinutes: { type: Number, default: 120 },
  horizonDays: { type: Number, default: 30 },
  workingWindows: { type: [WorkingWindowSchema], default: [] },
  blackoutDates: { type: [String], default: [] },

  /** Details collected at booking, beyond name and contact address. */
  fields: { type: [BookingFieldSchema], default: [] },
  /** Sequence to enrol the booker into — confirmation, reminder, follow-up. */
  enrolSequenceId: { type: Schema.Types.ObjectId, default: null },
  applyTags: { type: [String], default: [] },
  successMessage: { type: String, default: 'Booked. A confirmation is on its way.' },
  /** Consent wording shown at booking, copied verbatim onto each booking. */
  consentText: { type: String, default: null },
  allowedOrigins: { type: [String], default: [] },
  bookingCount: { type: Number, default: 0 },
  createdBy: String,
}, { timestamps: true });

BookingPageSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export default model('BookingPage', BookingPageSchema);
