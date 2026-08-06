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
] as const

export type ArtifactKind = (typeof artifactKinds)[number]

const ArtifactSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
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
