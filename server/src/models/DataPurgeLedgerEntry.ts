import { Schema, model } from 'mongoose'

/**
 * Append-only evidence that provider-derived data was purged.
 *
 * A deletion obligation that cannot be evidenced is not a control, it is an
 * intention. Each entry records what was deleted, how many records, under which
 * policy and legal basis, and carries a hash chained to the previous entry for
 * the same connection so that a removed or edited entry is detectable.
 */
const DataPurgeLedgerEntrySchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, ref: 'PlatformConnection', index: true },
  provider: { type: String, required: true, index: true },
  trigger: {
    type: String,
    enum: ['connection_disconnected', 'connection_revoked', 'connection_deleted', 'organization_closed', 'retention_schedule', 'operator_request'],
    required: true,
    index: true,
  },
  legalBasis: {
    type: String,
    enum: ['unreviewed', 'counsel_confirmed_retention_permitted', 'counsel_confirmed_deletion_required'],
    required: true,
  },
  retentionDaysApplied: { type: Number, required: true, min: 0 },
  /** Per-collection deletion counts, e.g. { WorkflowSnapshot: 42, Contact: 1180 }. */
  deletedCounts: { type: Schema.Types.Mixed, required: true },
  totalDeleted: { type: Number, required: true, min: 0 },
  /** SHA-256 over the canonical entry plus the previous entry hash. */
  entryHash: { type: String, required: true, maxlength: 64, index: true },
  previousEntryHash: { type: String, maxlength: 64 },
  executedAt: { type: Date, required: true, default: Date.now, index: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  correlationId: { type: String, maxlength: 120 },
  note: { type: String, maxlength: 1_000 },
}, { timestamps: true })

DataPurgeLedgerEntrySchema.index({ organizationId: 1, connectionId: 1, executedAt: -1 })

export default model('DataPurgeLedgerEntry', DataPurgeLedgerEntrySchema)
