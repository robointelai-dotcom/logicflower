import { Schema, model } from 'mongoose'
import { membershipRoles } from './Membership'

const InvitationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  role: { type: String, enum: membershipRoles, required: true },
  tokenHash: { type: String, required: true, unique: true, index: true, select: false },
  invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true, index: true },
  acceptedAt: Date,
  revokedAt: Date,
}, { timestamps: true })

InvitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
InvitationSchema.index({ organizationId: 1, email: 1, acceptedAt: 1, revokedAt: 1 })

export default model('Invitation', InvitationSchema)
