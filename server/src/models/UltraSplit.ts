import { Schema, model } from 'mongoose';

const UltraSplitSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  key: { type: String, required: true, index: true },
  seq: { type: Number, default: 0, index: true },
}, { timestamps: true });

UltraSplitSchema.index({ organizationId: 1, key: 1 }, { unique: true });

export default model('UltraSplit', UltraSplitSchema);
