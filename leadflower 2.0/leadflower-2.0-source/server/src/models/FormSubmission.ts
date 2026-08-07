import { Schema, model } from 'mongoose';

/**
 * One submission of a hosted form.
 *
 * Retained separately from the Contact it created because it is the evidence of
 * how and when that person gave their details, including the exact consent
 * wording shown at the time. A contact record shows the current state; this
 * shows the provenance, which is what a consent challenge actually asks for.
 */
const FormSubmissionSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  formId: { type: Schema.Types.ObjectId, required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, default: null, index: true },
  /** Validated values as submitted, after coercion. */
  values: { type: Schema.Types.Mixed, default: {} },
  /** Consent wording as displayed at submission time, copied not referenced. */
  consentTextShown: { type: String, default: null },
  consentGivenAt: { type: Date, default: null },
  /** Truncated, for abuse investigation only. */
  submittedFromIp: String,
  userAgent: String,
  origin: String,
  enrolmentId: { type: Schema.Types.ObjectId, default: null },
  dealId: { type: Schema.Types.ObjectId, default: null },
}, { timestamps: true });

FormSubmissionSchema.index({ organizationId: 1, formId: 1, createdAt: -1 });

export default model('FormSubmission', FormSubmissionSchema);
