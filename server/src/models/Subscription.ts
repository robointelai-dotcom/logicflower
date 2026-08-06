import { Schema, model } from 'mongoose'

const SubscriptionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, unique: true, index: true },
  stripeCustomerId: { type: String, unique: true, sparse: true, index: true },
  stripeSubscriptionId: { type: String, unique: true, sparse: true, index: true },
  plan: { type: String, enum: ['free', 'starter', 'agency', 'scale'], default: 'free' },
  status: { type: String, enum: ['inactive', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'], default: 'inactive', index: true },
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
  cancelAtPeriodEnd: { type: Boolean, default: false },
  seats: { type: Number, default: 1, min: 1 },
}, { timestamps: true })

export default model('Subscription', SubscriptionSchema)
