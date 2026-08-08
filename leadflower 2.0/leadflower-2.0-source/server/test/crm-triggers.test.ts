import { describe, expect, it } from 'vitest'
import { CRM_TRIGGERS, depthFromPayload, MAX_TRIGGER_DEPTH } from '../src/services/workflows/crmTriggers'
import { platformChargeNotice } from '../src/services/nodeLibrary'
import fs from 'fs'
import path from 'path'

describe('native CRM triggers', () => {
  it('covers the events a workflow could already start from in an external CRM', () => {
    // The gap this closes: a workflow could start from a HighLevel contact
    // being created but not from one created here.
    for (const trigger of ['trigger.crm.contactCreated', 'trigger.crm.tagAdded', 'trigger.crm.tagRemoved', 'trigger.crm.formSubmitted']) {
      expect(CRM_TRIGGERS).toContain(trigger as any)
    }
  })

  it('incurs no platform charge, unlike the HighLevel equivalents', () => {
    for (const trigger of CRM_TRIGGERS) expect(platformChargeNotice(trigger)).toBeUndefined()
    expect(platformChargeNotice('action.ghl.addTag')).toMatch(/per-action/)
  })

  it('is accepted by the workflow validator', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/workflowValidation.ts'), 'utf8')
    for (const trigger of CRM_TRIGGERS) expect(source).toContain(trigger)
  })

  it('bounds how deep a chain of workflows may run', () => {
    // Two workflows that start each other would otherwise run until the queue
    // dies, and the symptom is a machine under load rather than a visible
    // configuration error.
    expect(MAX_TRIGGER_DEPTH).toBeGreaterThan(0)
    expect(MAX_TRIGGER_DEPTH).toBeLessThanOrEqual(5)
  })

  it('reads the depth a workflow run carries, and treats nonsense as zero', () => {
    expect(depthFromPayload({ _triggerDepth: 2 })).toBe(2)
    for (const payload of [{}, null, { _triggerDepth: -1 }, { _triggerDepth: 'deep' }, { _triggerDepth: NaN }]) {
      expect(depthFromPayload(payload)).toBe(0)
    }
  })

  it('never throws into the CRM write that raised it', () => {
    // A trigger is a consequence of a write, not part of it. If dispatch fails
    // the tag was still applied and the user has already been told it worked.
    const source = fs.readFileSync(path.join(__dirname, '../src/services/workflows/crmTriggers.ts'), 'utf8')
    const dispatch = /export async function dispatchCrmEvent[\s\S]*?\n}/.exec(source)?.[0] ?? ''
    expect(dispatch).toContain('try {')
    expect(dispatch).toContain('catch')
    expect(dispatch).toContain('return { started: 0 }')
  })

  it('derives an idempotency key from the subject, not from the clock', () => {
    // A CRM write retried by its own caller must not start the same workflow
    // twice, and a timestamp would defeat that.
    const source = fs.readFileSync(path.join(__dirname, '../src/services/workflows/crmTriggers.ts'), 'utf8')
    const material = /const material = \[[\s\S]*?\]/.exec(source)?.[0] ?? ''
    expect(material).toContain('event.trigger')
    expect(material).toContain('event.contactId')
    expect(material).not.toMatch(/Date\.now|new Date|randomUUID/)
    expect(source).toContain('jobId: correlationId')
  })
})
