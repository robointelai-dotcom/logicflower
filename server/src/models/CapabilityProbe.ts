import { Schema, model } from 'mongoose'
import { CAPABILITIES, CAPABILITY_STATES } from '../services/capability/capabilityModel'

/**
 * The durable record of a live, read-only observation of a provider's actual
 * behaviour for one capability on one connection. This is the only artefact in
 * the system that can move a capability to `available` when the provider does
 * not return an explicit scope grant.
 *
 * Probes are append-only: `latestProbe` reads the newest record. Retaining the
 * history means an operator can show an auditor when a capability was last
 * confirmed and what the provider actually returned.
 */
const CapabilityProbeSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  connectionId: { type: Schema.Types.ObjectId, ref: 'PlatformConnection', required: true, index: true },
  provider: { type: String, required: true, index: true },
  capability: { type: String, enum: CAPABILITIES, required: true, index: true },
  state: { type: String, enum: CAPABILITY_STATES, required: true },
  statusCode: { type: Number },
  /** Redacted, non-sensitive summary of what was observed. Never a payload. */
  detail: { type: String, maxlength: 1_000 },
  /** SHA-256 over the canonical observation, so evidence cannot be edited silently. */
  evidenceHash: { type: String, required: true, maxlength: 64 },
  observedAt: { type: Date, required: true, default: Date.now, index: true },
  observedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  correlationId: { type: String, maxlength: 120 },
}, { timestamps: true })

CapabilityProbeSchema.index({ organizationId: 1, connectionId: 1, capability: 1, observedAt: -1 })

export default model('CapabilityProbe', CapabilityProbeSchema)
