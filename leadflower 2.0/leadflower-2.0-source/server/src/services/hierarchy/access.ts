import Membership from '../../models/Membership'
import Organization from '../../models/Organization'
import SupportAccessRequest from '../../models/SupportAccessRequest'
import User from '../../models/User'

/**
 * Who may act inside which organisation.
 *
 * THE RULE THIS MODULE EXISTS TO PROTECT
 *
 * Every data query in this system is scoped to exactly ONE organisation. That
 * has been true since the first tenant-isolation guard and it does not change
 * here. What changes is *how a user comes to be acting in* an organisation:
 * previously only through their own membership, now also as an agency over its
 * clients, or as support under a time-limited grant.
 *
 * The distinction is the whole design. Access is RESOLVED, not RELAXED. A
 * resolved request carries a single organizationId and every downstream query
 * is identical to one made by a direct member. Nothing anywhere issues a query
 * spanning several organisations for tenant data.
 *
 * The one exception is the hierarchy views at the bottom of this file, which
 * return organisation NAMES AND COUNTS ONLY — never a contact, a message or a
 * deal. That boundary is what keeps "show me my clients" from becoming "show me
 * everyone's data".
 */

export type AccessVia = 'membership' | 'agency' | 'support_grant' | 'corporate'

export interface ResolvedAccess {
  granted: boolean
  organizationId: string
  /** How the user came to be here. Recorded on every audited action. */
  via?: AccessVia
  /** The role to enforce for this request. */
  role?: string
  /** For a support grant: when it lapses. */
  expiresAt?: Date | null
  reason?: string
}

/** Maximum life of a support grant, whatever was requested. */
export const MAX_SUPPORT_GRANT_HOURS = 24

/**
 * Resolve a user's access to one organisation.
 *
 * Checked in order of directness: a member's own role wins, then agency
 * authority, then corporate, then a support grant. Support is last on purpose —
 * if a support engineer also happens to be a member of an organisation, their
 * membership is what governs, and no grant is consumed or audited as one.
 */
export async function resolveAccess(input: {
  userId: string
  organizationId: string
}): Promise<ResolvedAccess> {
  const base: ResolvedAccess = { granted: false, organizationId: input.organizationId }

  const organization: any = await Organization.findOne({ _id: input.organizationId })
    .select('kind parentOrganizationId name agencyAccessMode').lean()
  if (!organization) return { ...base, reason: 'organization_not_found' }

  // 1. Direct membership.
  const membership: any = await Membership.findOne({
    organizationId: input.organizationId,
    userId: input.userId,
    status: 'active',
  }).select('role').lean()
  if (membership) return { ...base, granted: true, via: 'membership', role: membership.role }

  // 2. Agency authority over its own client. One level, never a walk upward.
  if (organization.kind === 'client' && organization.parentOrganizationId) {
    const agencyMembership: any = await Membership.findOne({
      organizationId: organization.parentOrganizationId,
      userId: input.userId,
      status: 'active',
      role: { $in: ['agency_owner', 'owner', 'admin'] },
    }).select('role').lean()
    if (agencyMembership) {
      // Whether the agency may simply walk in is the CLIENT's decision, held on
      // their own workspace. Under `on_request` the agency is treated exactly
      // as support is: refused without a live, approved, expiring grant.
      if (organization.agencyAccessMode === 'on_request') {
        const grant: any = await SupportAccessRequest.findOne({
          organizationId: input.organizationId,
          requestedBy: input.userId,
          status: 'approved',
          dataAccessEnabled: true,
          revokedAt: null,
          expiresAt: { $gt: new Date() },
        }).select('_id expiresAt').lean()
        if (!grant) return { ...base, reason: 'agency_access_not_granted' }
        return { ...base, granted: true, via: 'agency', role: 'owner', expiresAt: grant.expiresAt }
      }
      // Standing access. Not silent: `via` reaches the audit record on every
      // action, and the client can see and revoke it at any time.
      return { ...base, granted: true, via: 'agency', role: 'owner' }
    }
  }

  const user: any = await User.findOne({ _id: input.userId }).select('platformRole').lean()
  const platformRole = String(user?.platformRole || 'user')

  // 3. Corporate. Reaches everything, and is the smallest possible set of
  //    people — the platform operator's own owners and admins.
  if (platformRole === 'owner' || platformRole === 'admin') {
    return { ...base, granted: true, via: 'corporate', role: 'owner' }
  }

  // 4. Support, only under a live approved grant.
  if (platformRole === 'support') {
    const now = new Date()
    const grant: any = await SupportAccessRequest.findOne({
      organizationId: input.organizationId,
      requestedBy: input.userId,
      status: 'approved',
      dataAccessEnabled: true,
      revokedAt: null,
      expiresAt: { $gt: now },
    }).select('_id expiresAt').lean()

    if (!grant) {
      // Support with no grant is refused exactly as a stranger would be. That
      // is the property a customer is being asked to trust.
      return { ...base, reason: 'support_access_not_granted' }
    }
    return { ...base, granted: true, via: 'support_grant', role: 'operator', expiresAt: grant.expiresAt }
  }

  return { ...base, reason: 'not_a_member' }
}

/**
 * Record that a grant was used.
 *
 * Deliberately per request rather than per session, so the customer's view of
 * "what did support actually do" is a count they can compare against the reason
 * given, not a single "logged in once".
 */
export async function noteSupportGrantUse(input: { userId: string; organizationId: string }): Promise<void> {
  await SupportAccessRequest.updateOne(
    { organizationId: input.organizationId, requestedBy: input.userId, status: 'approved', dataAccessEnabled: true, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } },
  )
}

/* -------------------------------------------------------- hierarchy views */

export interface OrganizationSummary {
  id: string
  name: string
  kind: string
  parentOrganizationId: string | null
  memberCount: number
  createdAt: Date
}

/**
 * The organisations an agency owns.
 *
 * Returns NAMES AND COUNTS ONLY. This is deliberately not a route into tenant
 * data: to see a client's contacts, an agency switches into that client and the
 * request is then scoped to it like any other. Letting a hierarchy view return
 * records would be the exact leak the tenant guard exists to prevent.
 */
export async function clientsOfAgency(agencyOrganizationId: string): Promise<OrganizationSummary[]> {
  const rows: any[] = await Organization.find({ parentOrganizationId: agencyOrganizationId, kind: 'client' })
    .select('name kind parentOrganizationId createdAt').sort({ name: 1 }).limit(500).lean()
  return withMemberCounts(rows)
}

/** Every agency, for the corporate view. Names and counts only, as above. */
export async function allAgencies(): Promise<OrganizationSummary[]> {
  const rows: any[] = await Organization.find({ kind: 'agency' })
    .select('name kind parentOrganizationId createdAt').sort({ name: 1 }).limit(500).lean()
  return withMemberCounts(rows)
}

/** Clients that belong to no agency — direct signups. */
export async function unaffiliatedClients(): Promise<OrganizationSummary[]> {
  const rows: any[] = await Organization.find({ kind: 'client', parentOrganizationId: null })
    .select('name kind parentOrganizationId createdAt').sort({ name: 1 }).limit(500).lean()
  return withMemberCounts(rows)
}

async function withMemberCounts(rows: any[]): Promise<OrganizationSummary[]> {
  const summaries: OrganizationSummary[] = []
  for (const row of rows) {
    const memberCount = await Membership.countDocuments({ organizationId: row._id, status: 'active' })
    summaries.push({
      id: String(row._id),
      name: row.name,
      kind: row.kind,
      parentOrganizationId: row.parentOrganizationId ? String(row.parentOrganizationId) : null,
      memberCount,
      createdAt: row.createdAt,
    })
  }
  return summaries
}

/**
 * Is this user an agency owner or admin, and of which agency?
 *
 * Used to decide whether to show the agency console at all. A client's own
 * staff must never see evidence that they sit under an agency — a business
 * owner logging in should see their business, not their position in somebody
 * else's portfolio.
 */
export async function agencyContextFor(userId: string): Promise<{ agencyOrganizationId: string; role: string } | null> {
  // tenant-safe: finds which organisations THIS user belongs to, keyed on their own userId; returns no tenant data and grants nothing on its own
  const memberships: any[] = await Membership.find({
    userId,
    status: 'active',
    role: { $in: ['agency_owner', 'owner', 'admin'] },
  }).select('organizationId role').limit(50).lean()
  if (!memberships.length) return null

  for (const membership of memberships) {
    const organization: any = await Organization.findOne({ _id: membership.organizationId, kind: 'agency' }).select('_id').lean()
    if (organization) return { agencyOrganizationId: String(organization._id), role: membership.role }
  }
  return null
}
