import { Schema, model } from 'mongoose';

/**
 * A per-organisation sending identity.
 *
 * The operator is the sender, not the platform and not the customer's CRM.
 * That is the entire commercial premise: routing a send back through GoHighLevel
 * reintroduces the per-action charge the product exists to remove.
 *
 * Credentials are held as an encrypted envelope with a per-record AAD, never in
 * clear and never in the environment, so one organisation's SMTP password
 * cannot be replayed against another organisation's record.
 */
const MessagingIdentitySchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  channel: { type: String, enum: ['email', 'sms', 'whatsapp'], required: true },
  provider: { type: String, enum: ['smtp', 'sendgrid', 'twilio', 'whatsapp_cloud'], required: true },
  label: { type: String, required: true },
  status: { type: String, enum: ['active', 'disabled'], default: 'active', index: true },
  isDefault: { type: Boolean, default: false },

  /** Email: envelope sender and display name. */
  fromAddress: String,
  fromName: String,
  replyToAddress: String,
  /** SMS/WhatsApp: E.164 sending number or provider sender id. */
  fromNumber: String,

  /** Non-secret provider settings: host, port, region, sender id. */
  settings: { type: Schema.Types.Mixed, default: {} },
  /** Encrypted credential envelope. Never selected by default. */
  credentialsCiphertext: { type: String, select: false },

  /**
   * Domain alignment evidence. Recorded, not asserted: a green tick here means
   * a check was run and what it returned, not that mail will be delivered.
   */
  domainAuth: {
    spfChecked: { type: Boolean, default: false },
    dkimChecked: { type: Boolean, default: false },
    dmarcChecked: { type: Boolean, default: false },
    lastCheckedAt: Date,
    detail: String,
  },
  lastUsedAt: Date,
  createdBy: String,
}, { timestamps: true });

MessagingIdentitySchema.index({ organizationId: 1, channel: 1, label: 1 }, { unique: true });
MessagingIdentitySchema.index({ organizationId: 1, channel: 1, isDefault: 1 });

export default model('MessagingIdentity', MessagingIdentitySchema);
