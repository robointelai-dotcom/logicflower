import { Schema, model } from 'mongoose';

/**
 * An organisation a contact belongs to.
 *
 * Exists because a B2B sale has several people in it. Without this, five people
 * at the same firm are five unrelated records with the same company name typed
 * five times, and there is no way to ask "who else do we know there?" or to
 * hold a deal at the company rather than the person.
 *
 * Deliberately thin. This is not an account-management product; it is enough
 * structure to group contacts, hold shared details, and let a deal belong to a
 * company rather than to whichever individual happened to reply first.
 */
const CompanySchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  /** Lowercased for duplicate detection and case-insensitive lookup. */
  nameLower: { type: String, required: true },
  website: String,
  phone: String,
  email: String,
  industry: String,
  /** Rough size band rather than a headcount nobody keeps current. */
  sizeBand: { type: String, enum: ['sole_trader', '2-10', '11-50', '51-250', '250+', null], default: null },
  addressLine1: String,
  addressLine2: String,
  city: String,
  region: String,
  postalCode: String,
  country: String,
  ownerUserId: { type: String, default: null, index: true },
  tags: { type: [String], default: [], index: true },
  notes: String,
  /** Sum of payments across every contact at this company, in minor units. */
  revenueMinorUnits: { type: Number, default: 0 },
  revenueCurrency: { type: String, default: null },
  archivedAt: { type: Date, default: null },
  createdBy: String,
}, { timestamps: true });

CompanySchema.index({ organizationId: 1, nameLower: 1 }, { unique: true });
CompanySchema.index({ organizationId: 1, updatedAt: -1 });
CompanySchema.index({ name: 'text' });

export default model('Company', CompanySchema);
