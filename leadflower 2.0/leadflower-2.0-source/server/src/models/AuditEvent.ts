import { Schema, model } from 'mongoose'

const AuditEventSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true, immutable: true },
  actorUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true, immutable: true },
  actorType: { type: String, enum: ['user', 'system', 'webhook'], default: 'user', immutable: true },
  action: { type: String, required: true, index: true, immutable: true, maxlength: 160 },
  entityType: { type: String, maxlength: 120, immutable: true },
  entityId: { type: String, maxlength: 180, immutable: true },
  ipAddress: { type: String, maxlength: 128, immutable: true },
  userAgent: { type: String, maxlength: 512, immutable: true },
  requestId: { type: String, maxlength: 120, immutable: true },
  metadata: { type: Schema.Types.Mixed, default: {}, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false }, minimize: false })

AuditEventSchema.index({ organizationId: 1, createdAt: -1 })
AuditEventSchema.index({ actorUserId: 1, createdAt: -1 })

const immutableError = (next: (error?: Error) => void) => next(new Error('Audit events are append-only'))
AuditEventSchema.pre('updateOne', function(next) { immutableError(next) })
AuditEventSchema.pre('updateMany', function(next) { immutableError(next) })
AuditEventSchema.pre('findOneAndUpdate', function(next) { immutableError(next) })
AuditEventSchema.pre('deleteOne', function(next) { immutableError(next) })
AuditEventSchema.pre('deleteMany', function(next) { immutableError(next) })
AuditEventSchema.pre('findOneAndDelete', function(next) { immutableError(next) })

export default model('AuditEvent', AuditEventSchema)
