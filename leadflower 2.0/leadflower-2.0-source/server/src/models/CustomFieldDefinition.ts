import { Schema, model } from 'mongoose';

/**
 * Per-organisation declaration of a custom contact field.
 *
 * The existence of this collection is what stops the contact store becoming
 * unqueryable. Values live in a map on the Contact; the schema for that map
 * lives here, one document per field per organisation, so a segment or an
 * import can be validated against something rather than hoping.
 *
 * `key` is normalised to snake_case before storage, so "Preferred Contact Time"
 * and "preferredContactTime" converge on one field rather than becoming two.
 */
const CustomFieldDefinitionSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  key: { type: String, required: true },
  label: { type: String, required: true },
  type: {
    type: String,
    enum: ['text', 'longtext', 'number', 'boolean', 'date', 'email', 'phone', 'url', 'single_select', 'multi_select', 'timezone'],
    required: true,
  },
  required: { type: Boolean, default: false },
  options: { type: [String], default: [] },
  min: Number,
  max: Number,
  helpText: String,
  /** Where the definition came from: an operator, or an applied industry snapshot. */
  source: { type: String, default: 'operator' },
  createdBy: String,
}, { timestamps: true });

CustomFieldDefinitionSchema.index({ organizationId: 1, key: 1 }, { unique: true });

export default model('CustomFieldDefinition', CustomFieldDefinitionSchema);
