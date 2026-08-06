import { Schema, model } from 'mongoose';

const TagSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, index: true },
  nameLower: { type: String, index: true },
  ghlId: { type: String, index: true },
  name: String,
  source: { type: String, enum: ['ghl','custom'], default: 'ghl' },
}, { timestamps: true });

TagSchema.index({ organizationId: 1, connectionId: 1, ghlId: 1 }, { unique: true, sparse: true });
TagSchema.index({ organizationId: 1, connectionId: 1, nameLower: 1 });

TagSchema.pre('save', function(next){
  try {
    // @ts-ignore
    const n = (this.name || '').trim().toLowerCase();
    // @ts-ignore
    this.nameLower = n || undefined;
  } catch {}
  next();
});

export default model('Tag', TagSchema);
