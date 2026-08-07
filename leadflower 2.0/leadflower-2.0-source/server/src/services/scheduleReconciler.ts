import crypto from 'crypto'
import Schedule from '../models/Schedule'
import Workflow from '../models/Workflow'
import { workflowQueue } from '../queue'
import pino from '../logger'

export async function restorePublishedSchedules(): Promise<{ restored: number; skipped: number }> {
  // tenant-safe: boot-time reconciliation across all organisations
  const schedules: any[] = await Schedule.find({ enabled: true }).lean()
  let restored = 0
  let skipped = 0
  for (const schedule of schedules) {
    const organizationId = String(schedule.organizationId || '')
    const workflowId = String(schedule.workflowId || '')
    const nodeId = String(schedule.nodeId || '')
    const workflow: any = await Workflow.findOne({ _id: workflowId, organizationId, status: 'published' }).select('nodes').lean()
    const triggerExists = workflow?.nodes?.some((node: any) => String(node?.id) === nodeId && node?.data?.kind === 'trigger.schedule')
    if (!organizationId || !workflow || !triggerExists) {
      skipped += 1
      pino.warn({ scheduleId: schedule._id, organizationId, workflowId }, 'skipping orphaned schedule during reconciliation')
      continue
    }
    const nodeHash = crypto.createHash('sha256').update(nodeId).digest('hex').slice(0, 16)
    const jobName = `schedule-${organizationId}-${workflowId}-${nodeHash}`
    await workflowQueue.add('run', {
      organizationId,
      workflowId,
      startNodeId: nodeId,
      triggerKind: 'trigger.schedule',
      correlationId: crypto.randomUUID(),
      payload: {},
    }, {
      jobId: jobName,
      repeat: { pattern: String(schedule.cron), tz: String(schedule.timezone || 'UTC') },
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 1_000,
    })
    // tenant-safe: boot-time reconciliation across all organisations
    if (schedule.jobName !== jobName) await Schedule.updateOne({ _id: schedule._id }, { $set: { jobName } })
    restored += 1
  }
  return { restored, skipped }
}
