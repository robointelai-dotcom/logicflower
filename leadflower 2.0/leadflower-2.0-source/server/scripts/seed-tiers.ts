import '../src/loadEnv'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import mongoose from 'mongoose'
import { connectDB } from '../src/db'
import User from '../src/models/User'
import Organization from '../src/models/Organization'
import Membership from '../src/models/Membership'
import { hashPassword } from '../src/security/password'

/**
 * Create one signed-in account per tier, so the hierarchy can actually be
 * tested.
 *
 * The tier rules — a client seeing no evidence of an agency above it, an agency
 * reaching its own clients and no others, corporate seeing counts but never
 * contact names — cannot be verified from a single login. This builds the
 * smallest estate that exercises every rule:
 *
 *   Corporate ─┬─ Agency Alpha ─┬─ Ridgeway Plumbing   (standing access)
 *              │                └─ Calder Dental       (on request)
 *              ├─ Agency Beta  ─── Harlow Fitness      (standing access)
 *              └─ Direct Client                        (no agency above it)
 *
 * Two agencies rather than one is the point: with a single agency, "an agency
 * reaches only its own clients" cannot fail. Agency Alpha must not be able to
 * open Harlow Fitness, and that is only testable with a second agency.
 *
 * REFUSES TO RUN IN PRODUCTION. These are known accounts with a known password.
 */

const PASSWORD_ENV = 'SEED_PASSWORD'

interface Seed {
  email: string
  name: string
  platformRole: 'owner' | 'admin' | 'support' | 'user'
  organization: string
  kind: 'corporate' | 'agency' | 'client'
  parent?: string
  role: string
  agencyAccessMode?: 'standing' | 'on_request'
  purpose: string
}

const SEEDS: Seed[] = [
  /* ============================== CORPORATE ============================== */
  { email: 'corp.owner@seed.local', name: 'Corporate Super Admin', platformRole: 'owner',
    organization: 'LogicFlower Corporate', kind: 'corporate', role: 'owner',
    purpose: 'Estate + Website + every workspace. Estate must show counts and NEVER a contact name.' },
  { email: 'corp.admin@seed.local', name: 'Corporate Admin', platformRole: 'admin',
    organization: 'LogicFlower Corporate', kind: 'corporate', role: 'admin',
    purpose: 'Same reach as the owner. Confirm Website writes demand a second factor.' },
  { email: 'corp.editor@seed.local', name: 'Corporate Editor', platformRole: 'admin',
    organization: 'LogicFlower Corporate', kind: 'corporate', role: 'operator',
    purpose: 'Writes the blog. Needs platform admin for /website; an ordinary operator is refused.' },
  { email: 'corp.support@seed.local', name: 'Corporate Support', platformRole: 'support',
    organization: 'LogicFlower Corporate', kind: 'corporate', role: 'viewer',
    purpose: 'Must reach NOTHING until a client approves. Verify the refusal before the grant.' },
  { email: 'corp.billing@seed.local', name: 'Corporate Finance', platformRole: 'user',
    organization: 'LogicFlower Corporate', kind: 'corporate', role: 'billing',
    purpose: 'Billing and reports only. Should be redirected away from the dashboard.' },

  /* ============================= AGENCY ALPHA ============================ */
  { email: 'alpha.owner@seed.local', name: 'Alpha Agency Owner', platformRole: 'user',
    organization: 'Agency Alpha', kind: 'agency', role: 'agency_owner',
    purpose: 'Clients console. Reaches Ridgeway and Calder. Must NOT reach Harlow or Beta.' },
  { email: 'alpha.admin@seed.local', name: 'Alpha Account Manager', platformRole: 'user',
    organization: 'Agency Alpha', kind: 'agency', role: 'admin',
    purpose: 'Agency staff. Should reach client workspaces but not agency billing.' },
  { email: 'alpha.operator@seed.local', name: 'Alpha Coordinator', platformRole: 'user',
    organization: 'Agency Alpha', kind: 'agency', role: 'operator',
    purpose: 'Day-to-day agency work. No Team, Billing or Connections in the sidebar.' },
  { email: 'alpha.viewer@seed.local', name: 'Alpha Analyst', platformRole: 'user',
    organization: 'Agency Alpha', kind: 'agency', role: 'viewer',
    purpose: 'Read only. No Sequences, Booking, Social, Calling or Workflows offered.' },

  /* ============================== AGENCY BETA ============================ */
  { email: 'beta.owner@seed.local', name: 'Beta Agency Owner', platformRole: 'user',
    organization: 'Agency Beta', kind: 'agency', role: 'agency_owner',
    purpose: 'The cross-agency test. Must NOT reach any Agency Alpha client.' },
  { email: 'beta.operator@seed.local', name: 'Beta Coordinator', platformRole: 'user',
    organization: 'Agency Beta', kind: 'agency', role: 'operator',
    purpose: 'Agency staff at the second agency. Must not see Alpha at all.' },

  /* ========== CLIENT: Ridgeway Plumbing (Alpha, standing access) ========= */
  { email: 'ridgeway.owner@seed.local', name: 'Ridgeway Owner', platformRole: 'user',
    organization: 'Ridgeway Plumbing', kind: 'client', parent: 'Agency Alpha',
    role: 'owner', agencyAccessMode: 'standing',
    purpose: 'Full client owner. Sidebar must show NO Agency or Corporate section, in the MARKUP.' },
  { email: 'ridgeway.admin@seed.local', name: 'Ridgeway Office Manager', platformRole: 'user',
    organization: 'Ridgeway Plumbing', kind: 'client', parent: 'Agency Alpha', role: 'admin',
    purpose: 'Everything except owner-only actions. Cannot change the calling policy.' },
  { email: 'ridgeway.operator@seed.local', name: 'Ridgeway Engineer', platformRole: 'user',
    organization: 'Ridgeway Plumbing', kind: 'client', parent: 'Agency Alpha', role: 'operator',
    purpose: 'Sees Sequences, Booking, Social, Calling. Not Team, Billing or Connections.' },
  { email: 'ridgeway.viewer@seed.local', name: 'Ridgeway Viewer', platformRole: 'user',
    organization: 'Ridgeway Plumbing', kind: 'client', parent: 'Agency Alpha', role: 'viewer',
    purpose: 'Read only. This is the least-privilege test; check the sidebar closely.' },
  { email: 'ridgeway.billing@seed.local', name: 'Ridgeway Bookkeeper', platformRole: 'user',
    organization: 'Ridgeway Plumbing', kind: 'client', parent: 'Agency Alpha', role: 'billing',
    purpose: 'Billing and reports only. Must not reach contacts or the inbox.' },
  { email: 'ridgeway.customer@seed.local', name: 'Ridgeway Portal User', platformRole: 'user',
    organization: 'Ridgeway Plumbing', kind: 'client', parent: 'Agency Alpha', role: 'customer',
    purpose: 'The narrowest role, and the least tested. Confirm what it can actually reach.' },

  /* ========== CLIENT: Calder Dental (Alpha, access on request) =========== */
  { email: 'calder.owner@seed.local', name: 'Calder Dental Owner', platformRole: 'user',
    organization: 'Calder Dental', kind: 'client', parent: 'Agency Alpha',
    role: 'owner', agencyAccessMode: 'on_request',
    purpose: 'Agency Alpha must be REFUSED here until this owner approves a request.' },
  { email: 'calder.operator@seed.local', name: 'Calder Receptionist', platformRole: 'user',
    organization: 'Calder Dental', kind: 'client', parent: 'Agency Alpha', role: 'operator',
    purpose: 'Booking-led business. Test the booking page and appointments here.' },
  { email: 'calder.viewer@seed.local', name: 'Calder Associate', platformRole: 'user',
    organization: 'Calder Dental', kind: 'client', parent: 'Agency Alpha', role: 'viewer',
    purpose: 'Read only inside an on-request workspace.' },

  /* ========== CLIENT: Harlow Fitness (Beta, standing access) ============= */
  { email: 'harlow.owner@seed.local', name: 'Harlow Fitness Owner', platformRole: 'user',
    organization: 'Harlow Fitness', kind: 'client', parent: 'Agency Beta',
    role: 'owner', agencyAccessMode: 'standing',
    purpose: 'Belongs to Beta. Agency Alpha opening this is a tenant-isolation failure.' },
  { email: 'harlow.admin@seed.local', name: 'Harlow Manager', platformRole: 'user',
    organization: 'Harlow Fitness', kind: 'client', parent: 'Agency Beta', role: 'admin',
    purpose: 'Confirm Beta staff reach this and Alpha staff do not.' },
  { email: 'harlow.operator@seed.local', name: 'Harlow Trainer', platformRole: 'user',
    organization: 'Harlow Fitness', kind: 'client', parent: 'Agency Beta', role: 'operator',
    purpose: 'Day-to-day work inside a second agency\u2019s client.' },

  /* ================ DIRECT CLIENTS — no agency above them =============== */
  { email: 'fairfield.owner@seed.local', name: 'Fairfield Joinery Owner', platformRole: 'user',
    organization: 'Fairfield Joinery', kind: 'client', role: 'owner',
    purpose: 'Signed up directly. Must be indistinguishable, from inside, from an agency-owned one.' },
  { email: 'fairfield.operator@seed.local', name: 'Fairfield Joiner', platformRole: 'user',
    organization: 'Fairfield Joinery', kind: 'client', role: 'operator',
    purpose: 'Staff in a direct client. No agency should reach this workspace at all.' },
  { email: 'brightside.owner@seed.local', name: 'Brightside Cleaning Owner', platformRole: 'user',
    organization: 'Brightside Cleaning', kind: 'client', role: 'owner',
    purpose: 'A second direct client. Must not reach Fairfield — client-to-client isolation.' },
]

/**
 * A distinct password per account, derived from one base secret.
 *
 * Distinct because a single shared password means one leaked credential exposes
 * every tier at once — including corporate, which reaches the whole estate.
 * Derived rather than random so a second run reproduces the same set: a tester
 * who loses the printout re-runs the script instead of resetting ten accounts.
 *
 * The base secret never appears in a password, so holding one account's
 * credential does not yield any other.
 */
function passwordFor(base: string, email: string): string {
  const digest = crypto.createHmac('sha256', base).update(`logicflower-seed:${email}`).digest('base64url')
  // Mixed case, digits and a symbol, to satisfy complexity rules without a
  // second pass over the result.
  return `Lf!${digest.slice(0, 16)}9`
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed in production: these are known accounts with a shared, known password.')
  }
  const password = process.env[PASSWORD_ENV]
  if (!password) {
    throw new Error(`Set ${PASSWORD_ENV} in the environment. It is never taken from the command line, where it would land in shell history and process listings.`)
  }
  if (password.length < 12) throw new Error(`${PASSWORD_ENV} must be at least 12 characters.`)

  await connectDB()
  const organizations = new Map<string, any>()
  const issued: Array<{ seed: Seed; password: string }> = []

  // Organisations first, parents before children — a client cannot reference an
  // agency that does not yet exist.
  const ordered = ['corporate', 'agency', 'client'] as const
  for (const kind of ordered) {
    for (const seed of SEEDS.filter((entry) => entry.kind === kind)) {
      if (organizations.has(seed.organization)) continue
      const existing = await Organization.findOne({ name: seed.organization }).lean()
      if (existing) {
        organizations.set(seed.organization, existing)
        continue
      }
      const parent = seed.parent ? organizations.get(seed.parent) : null
      const created = await Organization.create({
        name: seed.organization,
        kind: seed.kind,
        parentOrganizationId: parent?._id ?? null,
        ...(seed.agencyAccessMode ? { agencyAccessMode: seed.agencyAccessMode } : {}),
      })
      organizations.set(seed.organization, created)
    }
  }

  for (const seed of SEEDS) {
    const organization = organizations.get(seed.organization)
    const accountPassword = passwordFor(password, seed.email)
    const passwordHash = await hashPassword(accountPassword)
    issued.push({ seed, password: accountPassword })

    let user: any = await User.findOne({ email: seed.email })
    if (!user) {
      user = await User.create({
        email: seed.email,
        displayName: seed.name,
        passwordHash,
        platformRole: seed.platformRole,
        status: 'active',
        emailVerifiedAt: new Date(),
      })
    } else {
      // Re-running resets the password and role, so a half-finished run does not
      // leave an account nobody can sign in to.
      await User.updateOne({ _id: user._id }, { $set: { passwordHash, platformRole: seed.platformRole, status: 'active' } })
    }

    const membership = await Membership.findOne({ organizationId: organization._id, userId: user._id })
    if (!membership) {
      await Membership.create({ organizationId: organization._id, userId: user._id, role: seed.role, status: 'active' })
    } else {
      await Membership.updateOne({ _id: membership._id }, { $set: { role: seed.role, status: 'active' } })
    }
  }

  const lines: string[] = []
  lines.push('LogicFlower — seeded test accounts')
  lines.push('')
  lines.push('LogicFlower Corporate')
  lines.push('  ├─ Agency Alpha ──┬─ Ridgeway Plumbing   (standing access)')
  lines.push('  │                 └─ Calder Dental       (access on request)')
  lines.push('  ├─ Agency Beta  ──── Harlow Fitness      (standing access)')
  lines.push('  ├─ Fairfield Joinery                     (direct, no agency)')
  lines.push('  └─ Brightside Cleaning                   (direct, no agency)')
  lines.push('')
  lines.push('Every account has its OWN password. One leaked credential does not open another tier.')
  lines.push('Re-running this script with the same SEED_PASSWORD reproduces exactly these passwords.')
  lines.push('')

  for (const kind of ['corporate', 'agency', 'client'] as const) {
    const group = issued.filter((entry) => entry.seed.kind === kind)
    if (!group.length) continue
    lines.push(`── ${kind.toUpperCase()} ──`)
    lines.push('')
    for (const { seed, password } of group) {
      lines.push(`  ${seed.name}`)
      lines.push(`    workspace  ${seed.organization}   (role: ${seed.role})`)
      lines.push(`    email      ${seed.email}`)
      lines.push(`    password   ${password}`)
      lines.push(`    test       ${seed.purpose}`)
      lines.push('')
    }
  }

  lines.push('══ VERIFY IN THIS ORDER ══')
  lines.push('')
  lines.push('Each refusal BEFORE the matching permission. A test that only confirms')
  lines.push('something works has not shown the guard exists.')
  lines.push('')
  lines.push('ISOLATION — a failure here stops a release')
  lines.push('  1. alpha.owner     opening Harlow Fitness by id is REFUSED')
  lines.push('  2. beta.owner      Clients console shows Harlow only, never Ridgeway or Calder')
  lines.push('  3. fairfield.owner cannot reach Brightside, and no agency can reach either')
  lines.push('  4. corp.support    reaches nothing until a client approves a request')
  lines.push('  5. corp.owner      Estate PAYLOAD contains no contact, message or deal')
  lines.push('')
  lines.push('ACCESS MODE')
  lines.push('  6. alpha.owner     Calder shows "Request access"; Ridgeway shows "Open"')
  lines.push('  7. calder.owner    can switch Calder to standing, and back')
  lines.push('')
  lines.push('LEAST PRIVILEGE — check the sidebar MARKUP, not just the screen')
  lines.push('  8. ridgeway.viewer   no Sequences, Booking, Social, Calling, Workflows')
  lines.push('  9. ridgeway.operator no Team, Billing, Connections, Vault')
  lines.push(' 10. ridgeway.billing  billing and reports only, redirected off the dashboard')
  lines.push(' 11. ridgeway.customer confirm what this narrowest role can actually reach')
  lines.push(' 12. ridgeway.owner    NO Agency or Corporate section anywhere in the DOM')
  lines.push('')
  lines.push('CORPORATE')
  lines.push(' 13. corp.editor    can publish a blog article (platform admin + MFA)')
  lines.push(' 14. alpha.owner    /website returns 403 — a workspace role is not enough')
  lines.push('')
  lines.push('MODULES — one workspace is enough for these')
  lines.push(' 15. ridgeway.owner   run /setup, publish sequence steps, activate')
  lines.push(' 16. calder.operator  publish a booking page, open the link in a private window')
  lines.push(' 17. ridgeway.operator add a tag and confirm it fires what you expect')
  lines.push('')

  const report = lines.join('\n')
  console.log('\n' + report)

  // Written out as well, because ten credentials scroll off a terminal. The
  // filename is in .gitignore; it still holds live passwords for this
  // environment and should be deleted once testing is done.
  const outPath = path.join(process.cwd(), 'seed-accounts.local.txt')
  fs.writeFileSync(outPath, report + '\n', { mode: 0o600 })
  console.log(`  Written to ${outPath} — delete it when you have finished testing.\n`)

  await mongoose.disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
