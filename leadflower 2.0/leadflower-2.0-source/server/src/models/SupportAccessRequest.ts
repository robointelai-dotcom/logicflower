import { Schema, model } from 'mongoose'

const SupportAccessRequestSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  reason: { type: String, required: true, maxlength: 1_000 },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'expired'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true, index: true },
  decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  decidedAt: Date,
  decisionNote: { type: String, maxlength: 1_000 },
  /**
   * Whether an APPROVED request actually admits support into the workspace.
   *
   * This was previously immutable false — the record was consent evidence and
   * granted nothing. It now grants time-limited access, because support that
   * cannot see a workspace cannot support it. The controls that make that
   * acceptable are deliberate and must not be loosened:
   *
   *   - A customer administrator approves. Support cannot self-approve.
   *   - Access expires at `expiresAt`, checked on every request, with a hard
   *     ceiling enforced when the request is raised. There is no renewal
   *     without a fresh approval.
   *   - It can be revoked instantly, mid-session.
   *   - Every request made under a grant is audited and attributed to the
   *     support user, not to the customer.
   *   - The customer can see, at any time, who has access and until when.
   *
   * An always-on support login would be simpler and is precisely what a
   * customer is entitled to object to.
   */
  dataAccessEnabled: { type: Boolean, default: false },
  /** Set when a customer withdraws access before it expires. */
  revokedAt: { type: Date, default: null },
  revokedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  /** Bumped on every request made under this grant, for the customer's view. */
  useCount: { type: Number, default: 0 },
  lastUsedAt: { type: Date, default: null },
}, { timestamps: true })

SupportAccessRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 })

export default model('SupportAccessRequest', SupportAccessRequestSchema)
