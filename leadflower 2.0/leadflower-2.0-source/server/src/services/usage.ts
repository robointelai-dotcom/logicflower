import UsageRecord from '../models/UsageRecord'
import { quotaMetrics, QuotaMetric } from '../models/UsageCounter'
import { reserveMeteredUsage } from './entitlements'

export type UsageMetric = 'workflow_execution' | 'contact_processed' | 'api_call' | 'storage_byte' | 'ai_request' | 'ai_input_token' | 'ai_output_token'

export async function recordUsage(input: {
  organizationId: string
  metric: UsageMetric
  quantity: number
  idempotencyKey: string
  source?: string
  occurredAt?: Date
  metadata?: Record<string, unknown>
}): Promise<void> {
  if (!Number.isFinite(input.quantity) || input.quantity < 0) throw new Error('Usage quantity must be a non-negative finite number')
  if (quotaMetrics.includes(input.metric as QuotaMetric)) {
    await reserveMeteredUsage({
      ...input,
      metric: input.metric as QuotaMetric,
      quantity: input.quantity,
    })
    return
  }
  await UsageRecord.updateOne({ organizationId: input.organizationId, idempotencyKey: input.idempotencyKey }, {
    $setOnInsert: {
      organizationId: input.organizationId,
      metric: input.metric,
      quantity: input.quantity,
      source: input.source,
      occurredAt: input.occurredAt || new Date(),
      metadata: input.metadata || {},
      idempotencyKey: input.idempotencyKey,
    },
  }, { upsert: true })
}
