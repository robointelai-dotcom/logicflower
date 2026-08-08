import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { READ_ONLY_ROLES, roleLabel, readOnlyNotice } from './hooks/usePermissions'

/**
 * A read-only user must not be shown a control the server will refuse.
 *
 * Nothing was ever wrongly saved — the API refused every one of these writes
 * correctly. The defect was in what the user was told: they filled in a form,
 * pressed Create, and got a bare 403 with no way to tell whether they lacked
 * permission or the product was broken.
 */
describe('workspace permissions', () => {
  it('treats viewer, billing and customer as read-only', () => {
    expect([...READ_ONLY_ROLES].sort()).toEqual(['billing', 'customer', 'viewer'])
  })

  it('names the customer role for what it actually does', () => {
    // `customer` is NOT the role a paying customer receives — ordinary
    // registration creates an owner. Left labelled "Customer" in the picker it
    // invites an admin to assign it to their real customer, who then cannot
    // edit anything in their own workspace.
    expect(roleLabel('customer')).toBe('Guest (read-only)')
    expect(roleLabel('viewer')).toContain('read-only')
    expect(roleLabel('owner')).toBe('Owner')
  })

  it('explains the absence of controls rather than leaving it a mystery', () => {
    expect(readOnlyNotice('customer')).toMatch(/read-only/i)
    expect(readOnlyNotice('billing')).toMatch(/Billing/)
  })
})

describe('write controls are gated on the pages that render them', () => {
  const pages = path.join(__dirname, 'pages')
  const gated = [
    'ContactsPage.tsx', 'PipelinePage.tsx', 'SequencesPage.tsx', 'SocialPage.tsx',
    'BookingPage.tsx', 'VoicePage.tsx', 'InboxPage.tsx', 'ContactDetailPage.tsx',
  ]

  for (const page of gated) {
    it(`${page} asks whether the user may write`, () => {
      const source = fs.readFileSync(path.join(pages, page), 'utf8')
      expect(source).toContain('usePermissions()')
      expect(source).toContain('canOperate')
    })
  }

  it('uses the shared hook rather than re-deriving the role list', () => {
    // Several pages hardcoded ['owner','admin','operator'] inline and drifted.
    for (const page of gated) {
      const source = fs.readFileSync(path.join(pages, page), 'utf8')
      expect(source).not.toMatch(/\['owner',\s*'admin',\s*'operator'\]/)
    }
  })

  it('labels roles through the shared helper on the team screen', () => {
    const source = fs.readFileSync(path.join(pages, 'TeamPage.tsx'), 'utf8')
    expect(source).toContain('roleLabel(role)')
  })
})
