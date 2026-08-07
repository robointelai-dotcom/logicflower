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
  /**
   * Values for this organisation's declared custom fields, keyed by the
   * normalised field key.
   *
   * Remains `Mixed` because Mongo has no per-tenant schema. The schema is
   * enforced in `services/crm/customFields.ts` on every write that goes through
   * the CRM surface: a key with no CustomFieldDefinition is rejected on an
   * operator-driven write and reported-but-not-stored on an inbound CRM sync.
   *
   * Records written before Phase 2 may carry keys with no definition. They are
   * left in place rather than deleted — silently discarding a customer's data
   * to satisfy a newer rule is the wrong trade — and surfaced through the
   * undefined-key report so an operator can define or clear them.
   */
  customFields: Schema.Types.Mixed,
  ghlUpdatedAt: Date,

  // ---- Micro-CRM fields (Phase 2) ----
  /** Membership user id of the owner. Not a hard reference: an owner can leave. */
  ownerUserId: { type: String, default: null, index: true },
  lifecycleStatus: {
    type: String,
    enum: ['lead', 'engaged', 'qualified', 'customer', 'churned', 'unqualified'],
    default: 'lead',
    index: true,
  },
  /**
   * Sum of payments received, in minor units of `revenueCurrency`.
   *
   * Minor units because floating-point currency arithmetic silently loses
   * fractions, and a total that is a cent out is worse than no total.
   */
  revenueMinorUnits: { type: Number, default: 0 },
  revenueCurrency: { type: String, default: null },
  lastActivityAt: { type: Date, default: null },
  /** Set when a contact replies on any channel. Drives the reply exit condition. */
  lastInboundAt: { type: Date, default: null },
  archivedAt: { type: Date, default: null },

  /**
   * Position, as GeoJSON [longitude, latitude].
   *
   * GeoJSON order is longitude first, which is the reverse of how every human
   * writes a coordinate pair and the single most common way geospatial queries
   * silently return nothing. `setContactLocation` is the only sanctioned writer
   * and takes named lat/lng arguments for that reason.
   *
   * There is no geocoding: an address is not turned into coordinates anywhere
   * in this system. Coordinates arrive from a form, an import, or a device's
   * GPS. Adding geocoding means a third-party contract and a billing decision,
   * neither of which is settled.
   */
  location: {
    type: { type: String, enum: ['Point'], default: undefined },
    coordinates: { type: [Number], default: undefined },
  },
  /** How the coordinates were obtained, so accuracy is never overstated. */
  locationSource: { type: String, enum: ['device_gps', 'form', 'import', 'manual', null], default: null },
  locationUpdatedAt: { type: Date, default: null },

  // ---- Standard CRM fields ----
  /**
   * Postal address. Held as separate lines rather than one blob because a
   * trades business needs to know which city a job is in, and a single
   * free-text field cannot be filtered, sorted or geocoded.
   */
  addressLine1: String,
  addressLine2: String,
  city: { type: String, index: true },
  region: String,
  jobTitle: String,
  secondaryPhone: String,
  preferredContactMethod: { type: String, enum: ['email', 'phone', 'sms', 'whatsapp', null], default: null },
  referredBy: String,
  /**
   * Company this person belongs to.
   *
   * `companyName` above remains as a plain string, because contacts arrive from
   * imports and forms carrying a company name with no matching record, and
   * refusing them would lose the lead. The two coexist: the string is what was
   * supplied, the reference is what an operator has linked.
   */
  companyId: { type: Schema.Types.ObjectId, default: null, index: true },
  /**
   * Operator-assigned priority, 0-100. Deliberately manual: an automatic score
   * derived from engagement would be a guess presented as a fact, and every
   * business weighs its own signals differently.
   */
  leadScore: { type: Number, default: null, min: 0, max: 100 },
  /** When someone should next do something about this person. */
  nextActionAt: { type: Date, default: null },
  nextActionNote: String,
}, { timestamps: true });

/**
 * Full-text search over the fields an operator actually types into a search
 * box. Weighted so a name match outranks a company match, which outranks a
 * note-style match on an address.
 */
ContactSchema.index(
  { name: 'text', firstName: 'text', lastName: 'text', companyName: 'text', email: 'text' },
  { weights: { name: 10, firstName: 8, lastName: 8, companyName: 4, email: 2 }, name: 'contact_search' },
);
ContactSchema.index({ organizationId: 1, lifecycleStatus: 1, updatedAt: -1 });
ContactSchema.index({ organizationId: 1, ownerUserId: 1, updatedAt: -1 });
ContactSchema.index({ organizationId: 1, lastActivityAt: -1 });
ContactSchema.index({ organizationId: 1, nextActionAt: 1 });
ContactSchema.index({ organizationId: 1, companyId: 1 });
ContactSchema.index({ organizationId: 1, leadScore: -1 });
/**
 * Geospatial index for radius targeting.
 *
 * Sparse, because most contacts will never carry coordinates and a non-sparse
 * 2dsphere index over mostly-absent values is wasted space.
 */
ContactSchema.index({ location: '2dsphere' }, { sparse: true });
ContactSchema.index({ organizationId: 1, connectionId: 1, ghlId: 1 }, { unique: true, sparse: true });
ContactSchema.index({ organizationId: 1, email: 1 }, { sparse: true });
ContactSchema.index({ organizationId: 1, phone: 1 }, { sparse: true });

export default model('Contact', ContactSchema);
