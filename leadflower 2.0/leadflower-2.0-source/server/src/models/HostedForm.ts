import { Schema, model } from 'mongoose';

/**
 * A hosted, embeddable lead capture form.
 *
 * This is what makes a Type B customer independent of any external CRM: the
 * lead originates here rather than being pulled from somewhere else.
 *
 * The public identifier is a random slug, not the document id. An enumerable
 * endpoint invites someone to walk every form in the estate.
 */
const FormFieldSchema = new Schema({
  /** Built-in contact field, or `custom:<key>` for a declared custom field. */
  field: { type: String, required: true },
  label: { type: String, required: true },
  required: { type: Boolean, default: false },
  placeholder: String,
  position: { type: Number, default: 0 },
}, { _id: false });

const HostedFormSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  /** Unguessable public identifier used by the embed endpoint. */
  slug: { type: String, required: true, unique: true },
  status: { type: String, enum: ['draft', 'published', 'disabled'], default: 'draft', index: true },
  fields: { type: [FormFieldSchema], default: [] },
  /** Sequence to enrol a submitter into. */
  enrolSequenceId: { type: Schema.Types.ObjectId, default: null },
  /** Pipeline and stage to open a deal in on submission. */
  createDealInPipelineId: { type: Schema.Types.ObjectId, default: null },
  createDealInStageId: { type: String, default: null },
  applyTags: { type: [String], default: [] },
  successMessage: { type: String, default: 'Thanks — we have your details.' },
  redirectUrl: { type: String, default: null },
  /**
   * Origins permitted to submit this form. Empty means any origin, which is
   * the only workable default for an embeddable widget but is recorded so an
   * operator can tighten it.
   */
  allowedOrigins: { type: [String], default: [] },
  /**
   * Consent text shown at submission and stored verbatim with every
   * submission. The wording at the time of consent is the evidence; a later
   * edit must not rewrite what past submitters agreed to.
   */
  consentText: { type: String, default: null },
  submissionCount: { type: Number, default: 0 },
  source: { type: String, default: 'operator' },
  createdBy: String,
}, { timestamps: true });

HostedFormSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export default model('HostedForm', HostedFormSchema);
