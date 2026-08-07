import { Schema, model } from 'mongoose';

/**
 * A named, reusable contact filter.
 *
 * The filter is stored as a structured, validated condition tree — never as a
 * raw Mongo query. Storing a query fragment supplied by a client and handing it
 * to the driver is a query-injection sink: `$where`, `$function` and an
 * unbounded `$regex` are all reachable that way. `services/crm/segments.ts`
 * compiles this tree into a query with an organisation predicate that a caller
 * cannot displace.
 */
const SegmentConditionSchema = new Schema({
  field: { type: String, required: true },
  operator: { type: String, required: true },
  value: Schema.Types.Mixed,
}, { _id: false });

const SavedSegmentSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  description: String,
  /** All conditions must match, or any of them, per `match`. */
  match: { type: String, enum: ['all', 'any'], default: 'all' },
  conditions: { type: [SegmentConditionSchema], default: [] },
  /** Cached count, with the time it was computed. Never presented as live. */
  lastCount: { type: Number, default: null },
  lastCountedAt: { type: Date, default: null },
  createdBy: String,
}, { timestamps: true });

SavedSegmentSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export default model('SavedSegment', SavedSegmentSchema);
