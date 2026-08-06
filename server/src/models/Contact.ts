import { Schema, model } from 'mongoose';

const ContactSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, index: true },
  ghlId: { type: String, index: true },
  name: String,
  firstName: String,
  lastName: String,
  companyName: String,
  phone: String,
  email: String,
  timezone: String,
  country: String,
  source: String,
  dateAdded: Date,
  postalCode: String,
  website: String,
  tags: { type: [String], index: true },
  customFields: Schema.Types.Mixed,
  ghlUpdatedAt: Date,
}, { timestamps: true });

ContactSchema.index({ name: 'text' });
ContactSchema.index({ organizationId: 1, connectionId: 1, ghlId: 1 }, { unique: true, sparse: true });
ContactSchema.index({ organizationId: 1, email: 1 }, { sparse: true });
ContactSchema.index({ organizationId: 1, phone: 1 }, { sparse: true });

export default model('Contact', ContactSchema);
