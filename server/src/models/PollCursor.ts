import { Schema, model } from 'mongoose';

const PollCursorSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, index: true },
  provider: { type: String, index: true },   // 'ghl'
  key: { type: String, index: true },        // 'contacts'
  cursor: { type: Number, default: 0 },      // epoch millis
}, { timestamps: true });

PollCursorSchema.index({ organizationId: 1, connectionId: 1, provider: 1, key: 1 }, { unique: true });

export default model('PollCursor', PollCursorSchema);
