import { Schema, model } from 'mongoose';

/**
 * A unit of work assigned to a person, usually about a contact.
 *
 * Deliberately not a workflow node and not a scheduled step. Those two already
 * exist and both drive automated action; a Task is the opposite — it exists
 * precisely because something needs a human, and its due date is a prompt
 * rather than a trigger. Conflating them would mean the scheduler tries to
 * "execute" a task nobody can automate.
 */
const TaskSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  /** Optional: a task can be standalone, not every job is about one person. */
  contactId: { type: Schema.Types.ObjectId, default: null, index: true },
  dealId: { type: Schema.Types.ObjectId, default: null },
  title: { type: String, required: true },
  description: String,
  /** Membership user id. Null means unassigned and sitting in a shared queue. */
  assigneeUserId: { type: String, default: null, index: true },
  dueAt: { type: Date, default: null },
  /**
   * The timezone the due date was set in. Held so "due Friday" renders as
   * Friday for the field engineer who was given it, not shifted by the
   * timezone of whoever opens the list.
   */
  timeZone: { type: String, default: 'UTC' },
  status: { type: String, enum: ['open', 'completed', 'cancelled'], default: 'open', index: true },
  priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
  completedAt: { type: Date, default: null },
  completedByUserId: { type: String, default: null },
  /** Where it came from: an operator, a pipeline stage, an applied snapshot. */
  source: { type: String, default: 'manual' },
  createdBy: String,
}, { timestamps: true });

TaskSchema.index({ organizationId: 1, status: 1, dueAt: 1 });
TaskSchema.index({ organizationId: 1, assigneeUserId: 1, status: 1, dueAt: 1 });

export default model('Task', TaskSchema);
