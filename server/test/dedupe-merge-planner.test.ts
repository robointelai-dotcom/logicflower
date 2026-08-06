import { describe, expect, it } from 'vitest'
import { buildMergePlan, groupDuplicates, MAX_GROUP_SIZE, DedupeRecord } from '../src/services/dedupe/mergePlanner'

function record(id: string, over: Partial<DedupeRecord> = {}): DedupeRecord {
  return { id, fields: {}, ...over }
}

describe('duplicate grouping', () => {
  it('groups on email OR phone, not AND', () => {
    const groups = groupDuplicates([
      record('a', { email: 'x@example.com', phone: '+15550001' }),
      record('b', { email: 'x@example.com', phone: '+15559999' }),
      record('c', { email: 'other@example.com', phone: '+15550001' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.members.map((m) => m.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('links records transitively through a shared intermediary', () => {
    // A~B by email, B~C by phone. All three are one identity; treating them as
    // two overlapping pairs would produce two merges that fight each other.
    const groups = groupDuplicates([
      record('a', { email: 'same@example.com' }),
      record('b', { email: 'same@example.com', phone: '+15551234' }),
      record('c', { phone: '+15551234' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.members).toHaveLength(3)
  })

  it('ignores blank identifiers rather than grouping every empty record together', () => {
    const groups = groupDuplicates([
      record('a', { email: '', phone: '' }),
      record('b', { email: '   ', phone: undefined }),
      record('c', { email: '' }),
    ])
    expect(groups).toHaveLength(0)
  })

  it('matches identifiers case-insensitively', () => {
    const groups = groupDuplicates([
      record('a', { email: 'Person@Example.com' }),
      record('b', { email: 'person@example.COM' }),
    ])
    expect(groups).toHaveLength(1)
  })
})

describe('merge plan safety', () => {
  const base: DedupeRecord[] = [
    record('old', { email: 'a@example.com', createdAt: '2024-01-01', updatedAt: '2024-01-01', fields: { firstName: 'Ann', company: '' } }),
    record('new', { email: 'a@example.com', createdAt: '2025-01-01', updatedAt: '2025-06-01', fields: { firstName: 'Anne', company: 'Acme' } }),
  ]

  it('is deterministic — the same input yields the same plan hash', () => {
    const first = buildMergePlan(base)
    const second = buildMergePlan(base.slice().reverse())
    expect(first.planHash).toBe(second.planHash)
  })

  it('fills blanks on the survivor without recording a conflict', () => {
    const plan = buildMergePlan(base, { survivorRule: 'oldest_created' })
    const company = plan.groups[0]!.fieldResolutions.find((item) => item.field === 'company')!
    expect(company.chosenValue).toBe('Acme')
    expect(company.conflict).toBe(false)
  })

  it('keeps the survivor value under prefer_survivor and reports what was discarded', () => {
    const plan = buildMergePlan(base, { survivorRule: 'oldest_created', conflictPolicy: 'prefer_survivor' })
    const firstName = plan.groups[0]!.fieldResolutions.find((item) => item.field === 'firstName')!
    expect(firstName.chosenValue).toBe('Ann')
    expect(firstName.conflict).toBe(true)
    expect(firstName.discardedValues).toContain('Anne')
  })

  it('blocks the group entirely under require_manual instead of guessing', () => {
    const plan = buildMergePlan(base, { conflictPolicy: 'require_manual' })
    expect(plan.groups[0]!.blocked?.code).toBe('MANUAL_REVIEW_REQUIRED')
    expect(plan.impact.executableGroups).toBe(0)
  })

  it('refuses a group larger than the safe limit', () => {
    const many = Array.from({ length: MAX_GROUP_SIZE + 1 }, (_, index) =>
      record(`r${index}`, { email: 'bulk@example.com', fields: { firstName: `Name${index}` } }))
    const plan = buildMergePlan(many)
    expect(plan.groups[0]!.blocked?.code).toBe('GROUP_TOO_LARGE')
    expect(plan.impact.recordsDeleted).toBe(0)
  })

  it('never plans a deletion unless deletion was explicitly requested', () => {
    const plan = buildMergePlan(base)
    expect(plan.policy.deleteDuplicates).toBe(false)
    expect(plan.impact.recordsDeleted).toBe(0)
    const withDelete = buildMergePlan(base, { deleteDuplicates: true })
    expect(withDelete.impact.recordsDeleted).toBe(1)
  })

  it('changes the plan hash when the deletion policy changes', () => {
    // An approval is a signature over a hash. If enabling deletion did not
    // change the hash, a merge-only approval could authorise deletions.
    expect(buildMergePlan(base).planHash).not.toBe(buildMergePlan(base, { deleteDuplicates: true }).planHash)
  })

  it('changes the plan hash when the survivor changes', () => {
    expect(buildMergePlan(base, { survivorRule: 'oldest_created' }).planHash)
      .not.toBe(buildMergePlan(base, { survivorRule: 'most_recently_updated' }).planHash)
  })

  it('produces no groups and no impact when there are no duplicates', () => {
    const plan = buildMergePlan([
      record('a', { email: 'a@example.com' }),
      record('b', { email: 'b@example.com' }),
    ])
    expect(plan.groups).toHaveLength(0)
    expect(plan.impact.recordsUpdated).toBe(0)
  })
})
