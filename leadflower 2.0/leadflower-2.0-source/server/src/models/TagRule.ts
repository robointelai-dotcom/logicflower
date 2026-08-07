import { Schema, model } from 'mongoose';

/**
 * "When this tag is applied, do that."
 *
 * The automation join for tags, and the local equivalent of the tag triggers a
 * CRM like GoHighLevel charges per action for. Applying a tag here runs the
 * matching rules inside this system: no external workflow fires, and no
 * per-action fee is incurred.
 *
 * Rules are matched on the NORMALISED tag key, so a rule written for "vip"
 * fires for "VIP", "V.I.P." and "Vip" alike. Anything else means an operator
 * types a tag slightly differently one afternoon and quietly breaks their own
 * automation.
 */
const TagRuleSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  /** Normalised tag key this rule watches. */
  tagKey: { type: String, required: true },
  event: { type: String, enum: ['added', 'removed'], default: 'added' },
  status: { type: String, enum: ['active', 'paused'], default: 'active', index: true },

  /** Sequence to enrol the contact into. */
  enrolSequenceId: { type: Schema.Types.ObjectId, default: null },
  /** Sequence to exit. Applied before enrolment, as with pipeline stages. */
  exitSequenceId: { type: Schema.Types.ObjectId, default: null },
  /** Lifecycle status to set. */
  setLifecycleStatus: {
    type: String,
    enum: ['lead', 'engaged', 'qualified', 'customer', 'churned', 'unqualified', null],
    default: null,
  },
  /** Tags to add or remove as a consequence. */
  addTags: { type: [String], default: [] },
  removeTags: { type: [String], default: [] },
  /** Task raised against the contact owner. */
  createTask: {
    title: String,
    dueInHours: { type: Number, default: null },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
  },
  lastFiredAt: Date,
  fireCount: { type: Number, default: 0 },
  createdBy: String,
}, { timestamps: true });

TagRuleSchema.index({ organizationId: 1, tagKey: 1, event: 1, status: 1 });

export default model('TagRule', TagRuleSchema);
