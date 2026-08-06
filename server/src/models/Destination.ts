import { Schema, model } from 'mongoose'

const DestinationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  encryptedConfig: { type: String, required: true, select: false },
  hostname: { type: String, required: true, index: true },
  pinnedAddresses: { type: [String], default: [] },
  allowedMethods: { type: [String], enum: ['GET', 'POST', 'PUT', 'PATCH'], default: ['POST'] },
  status: { type: String, enum: ['verified', 'disabled'], default: 'verified', index: true },
  verifiedAt: { type: Date, default: Date.now },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true })

DestinationSchema.index({ organizationId: 1, hostname: 1, name: 1 })

export default model('Destination', DestinationSchema)
