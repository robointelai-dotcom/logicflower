import { Schema, model } from 'mongoose';

/**
 * The customer's own business, as an entity search engines can read.
 *
 * One per workspace. This is the foundation the rest of the "Getting found"
 * module hangs off: the schema on their website, the FAQ block, and the
 * attribution report all reference it.
 *
 * Deliberately scoped to organizationId. The blog and marketing site are
 * platform-owned because there is one public website; this is the opposite —
 * every client has their own, on their own domain.
 */
const BusinessProfileSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },

  legalName: { type: String, default: '' },
  tradingName: { type: String, default: '' },

  addressLine1: String,
  addressLine2: String,
  city: String,
  region: String,
  postalCode: String,
  country: String,
  latitude: Number,
  longitude: Number,

  /**
   * Where they work, which is often not where they are.
   *
   * A plumber has a home address and covers thirty miles; a dentist has a
   * surgery people travel to. Emitting the address alone gets the first one
   * wrong.
   */
  serviceAreaKind: { type: String, enum: ['radius', 'named', 'none'], default: 'none' },
  serviceAreaRadiusKm: { type: Number, default: 0 },
  serviceAreaPlaces: { type: [String], default: [] },

  /**
   * The schema.org subtype.
   *
   * Must be specific. A dentist emitting a bare LocalBusiness loses the
   * properties that make a dentist findable, and search engines have no way to
   * infer them from the name.
   */
  businessType: { type: String, default: 'LocalBusiness' },
  services: { type: [String], default: [] },

  telephone: String,
  email: String,
  website: String,

  /** Per weekday. `closed` beats any times supplied alongside it. */
  openingHours: {
    type: [{ day: String, opens: String, closes: String, closed: Boolean }],
    default: [],
  },
  /**
   * Bank holidays and one-off closures.
   *
   * Emitted because a business showing "open" on a public holiday produces a
   * wasted journey and a one-star review — the exact opposite of what this
   * module is for.
   */
  hoursExceptions: {
    type: [{ date: String, closed: Boolean, opens: String, closes: String, note: String }],
    default: [],
  },

  priceRange: String,
  paymentAccepted: { type: [String], default: [] },
  currenciesAccepted: { type: [String], default: [] },
  languagesSpoken: { type: [String], default: [] },

  /**
   * Registrations, licences, memberships.
   *
   * Emitted ONLY where entered. A fabricated professional credential is a false
   * statement about a regulated trade, not an optimisation — the same rule that
   * governs `reviewedBy` on articles.
   */
  credentials: {
    type: [{ name: String, issuedBy: String, identifier: String, url: String }],
    default: [],
  },
  acceptedInsurance: { type: [String], default: [] },

  foundingYear: Number,
  updatedBy: String,
}, { timestamps: true });

export default model('BusinessProfile', BusinessProfileSchema);
