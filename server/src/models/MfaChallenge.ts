import { Schema, model } from 'mongoose'

const MfaChallengeSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  challengeHash: { type: String, required: true, unique: true, index: true, select: false },
  ipHash: { type: String, required: true },
  attempts: { type: Number, default: 0, min: 0 },
  expiresAt: { type: Date, required: true, index: true },
  consumedAt: Date,
}, { timestamps: true })

MfaChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default model('MfaChallenge', MfaChallengeSchema)
