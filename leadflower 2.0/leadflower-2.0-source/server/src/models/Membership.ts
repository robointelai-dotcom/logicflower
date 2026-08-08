import { Schema, model } from 'mongoose'

/**
 * Roles within one organisation.
 *
 * `agency_owner` is only meaningful on an organisation of kind `agency`, and it
 * is what grants authority over that agency's client organisations. On a client
 * organisation it means nothing — authority flows downward from the parent, and
 * never upward or sideways.
 */
export const membershipRoles = ['agency_owner', 'owner', 'admin', 'operator', 'viewer', 'billing'] as const
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
