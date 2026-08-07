import { Schema, model } from 'mongoose'

export const artifactKinds = [
  'batch_source',
  'batch_failed_export',
  'batch_before_state',
  'merge_before_state',
  'vault_export',
  'report_export',
  'execution_export',
  'organization_export',
  // A file attached to a contact record by an operator. Same encrypted store,
  // same retention machinery as every other artifact — attachments get no
  // special-case storage path.
  'contact_attachment',
] as const

export type ArtifactKind = (typeof artifactKinds)[number]

const ArtifactSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  /** Set for contact_attachment, so a contact's files can be listed. */
  contactId: { type: Schema.Types.ObjectId, default: null, index: true },
  kind: { type: String, enum: artifactKinds, required: true, index: true },
  storageDriver: { type: String, enum: ['local', 's3'], required: true },
  storageKey: { type: String, required: true, unique: true, select: false },
  fileName: { type: String, required: true },
  contentType: { type: String, required: true },
  plaintextSize: { type: Number, required: true, min: 0 },
  sha256: { type: String, required: true },
  encryptionVersion: { type: Number, required: true, default: 1 },
  encryptionIv: { type: String, required: true, select: false },
  encryptionTag: { type: String, required: true, select: false },
  status: {
    type: String,
    enum: ['pending', 'ready', 'failed', 'deleted'],
    default: 'pending',
    required: true,
    index: true,
  },
  createdBy: String,
  metadata: { type: Schema.Types.Mixed, default: {} },
  expiresAt: { type: Date, index: true },
  deletedAt: Date,
  error: { type: String, select: false },
}, { timestamps: true })

ArtifactSchema.index({ organizationId: 1, createdAt: -1 })
ArtifactSchema.index({ organizationId: 1, kind: 1, createdAt: -1 })

export default model('Artifact', ArtifactSchema)
