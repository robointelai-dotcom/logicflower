import { Schema, model } from 'mongoose'

export const membershipRoles = ['owner', 'admin', 'operator', 'viewer', 'billing'] as const
export type MembershipRole = typeof membershipRoles[number]

const MembershipSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, enum: membershipRoles, required: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
  invitedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  joinedAt: { type: Date, default: Date.now },
}, { timestamps: true })

MembershipSchema.index({ organizationId: 1, userId: 1 }, { unique: true })
MembershipSchema.index({ userId: 1, status: 1 })

export default model('Membership', MembershipSchema)
