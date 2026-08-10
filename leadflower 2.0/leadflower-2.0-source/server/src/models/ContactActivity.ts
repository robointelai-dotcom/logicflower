import { Schema, model } from 'mongoose';

/**
 * The contact timeline.
 *
 * An append-only record of what happened to one person: messages sent, replies,
 * sequence enrolments and exits, stage changes, notes, form submissions,
 * payments. Written alongside the operation it describes rather than derived at
 * read time, because deriving a timeline by querying six collections and
 * merge-sorting them is a query that gets slower every month.
 *
 * Deliberately carries no message bodies. Content lives on the record that owns
 * it; duplicating it here would double the retention and redaction surface.
 */
const ContactActivitySchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, required: true, index: true },
  type: {
    type: String,
    enum: [
      'contact.created', 'contact.updated', 'contact.merged',
      'message.sent', 'message.delivered', 'message.bounced', 'message.suppressed', 'message.received',
      'call.missed', 'call.blocked', 'call.placed', 'call.completed',
      'sequence.enrolled', 'sequence.exited', 'sequence.completed',
      'deal.created', 'deal.stage_changed', 'deal.won', 'deal.lost', 'deal.deleted',
      'contact.archived', 'contact.restored',
      'note.added', 'form.submitted', 'payment.link_created', 'payment.received',
      'task.created', 'task.completed', 'appointment.booked', 'appointment.cancelled', 'appointment.completed',
      'contact.location_updated',
      'review.requested', 'review.submitted', 'review.published', 'review.replied',
      'social.published',
      'tag.added', 'tag.removed', 'company.linked',
    ],
    required: true,
  },
  /** Human-readable one-line summary, rendered at write time. */
  summary: { type: String, required: true },
  /** Identifier of the record this activity refers to, for deep linking. */
  entityType: String,
  entityId: { type: Schema.Types.ObjectId, default: null },
  /** Small, non-sensitive facts only: channel, stage names, amounts. */
  metadata: { type: Schema.Types.Mixed, default: {} },
  actorUserId: String,
  occurredAt: { type: Date, default: Date.now },

  /**
   * Where this person came from, recorded at first contact.
   *
   * Read by the attribution report on a FIRST-TOUCH basis: a customer who
   * searches, rings, waits a week and then books should be credited to the
   * search, not to "direct".
   *
   * Absent means we do not know — and "do not know" is reported as its own row
   * rather than folded into any channel.
   */
  visibilitySource: { type: String, default: null, index: true },
  visibilityQuery: String,
  visibilityLandingPage: String,
}, { timestamps: true });

ContactActivitySchema.index({ organizationId: 1, contactId: 1, occurredAt: -1 });
ContactActivitySchema.index({ organizationId: 1, type: 1, occurredAt: -1 });

export default model('ContactActivity', ContactActivitySchema);
