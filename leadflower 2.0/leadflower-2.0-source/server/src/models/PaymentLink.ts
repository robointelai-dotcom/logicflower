import { Schema, model } from 'mongoose';

/**
 * A customer-facing payment link, generated per contact.
 *
 * STRICTLY separate from platform billing. The organisation's own Stripe
 * account collects these payments; the platform's Stripe account collects
 * subscription revenue. They are different accounts, different keys, different
 * webhooks, and sharing configuration between them would let a bug in one
 * charge customers through the other. Nothing in this model or its service
 * reads `env.STRIPE_SECRET_KEY`.
 */
const PaymentLinkSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, required: true, index: true },
  dealId: { type: Schema.Types.ObjectId, default: null },
  provider: { type: String, enum: ['stripe', 'paypal'], default: 'stripe' },
  description: { type: String, required: true },
  amountMinorUnits: { type: Number, required: true },
  currency: { type: String, required: true },
  status: { type: String, enum: ['created', 'paid', 'cancelled', 'expired'], default: 'created', index: true },
  /** Identifier in the operator's own payment account. */
  providerObjectId: { type: String, index: true },
  url: String,
  paidAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
  createdBy: String,
}, { timestamps: true });

PaymentLinkSchema.index({ organizationId: 1, contactId: 1, createdAt: -1 });

export default model('PaymentLink', PaymentLinkSchema);
