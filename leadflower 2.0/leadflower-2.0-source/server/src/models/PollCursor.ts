import { Schema, model } from 'mongoose';

const PollCursorSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, index: true },
  provider: { type: String, index: true },   // 'ghl'
  key: { type: String, index: true },        // 'contacts'
  cursor: { type: Number, default: 0 },      // epoch millis high-water mark
  /**
   * Opaque provider pagination token for the page after the last one fully
   * processed. Advanced only once every contact on a page has been enrolled or
   * deliberately skipped — persisting it earlier would step over leads on the
   * next run and lose them silently.
   */
  pageCursor: { type: String, default: null },
  /**
   * External record ids already acted on, most recent first and bounded.
   *
   * This is the de-duplication mechanism, and it is id-based rather than
   * timestamp-based because provider timestamps are not reliably monotonic:
   * two records written in the same second, or a clock correction on the
   * provider's side, will otherwise cause a lead to be skipped or enrolled
   * twice.
   */
  seenExternalIds: { type: [String], default: [] },
  lastRunAt: Date,
  lastEnrolledCount: { type: Number, default: 0 },
  exhausted: { type: Boolean, default: false },
}, { timestamps: true });

PollCursorSchema.index({ organizationId: 1, connectionId: 1, provider: 1, key: 1 }, { unique: true });

export default model('PollCursor', PollCursorSchema);
