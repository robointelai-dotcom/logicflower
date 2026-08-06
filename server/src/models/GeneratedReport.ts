import { Schema, model } from 'mongoose';

const GeneratedReportSchema = new Schema({
  organizationId: { type: String, required: true, index: true },
  type: { type: String, enum: ['health', 'usage', 'savings', 'incident'], required: true },
  periodStart: Date,
  periodEnd: Date,
  status: { type: String, enum: ['generating', 'ready', 'failed'], default: 'generating' },
  data: { type: Schema.Types.Mixed },
  generatedAt: Date,
  error: { type: Schema.Types.Mixed },
}, { timestamps: true });

GeneratedReportSchema.index({ organizationId: 1, createdAt: -1 });
export default model('GeneratedReport', GeneratedReportSchema);
