import { Router } from 'express'
import { Types } from 'mongoose'
import Invitation from '../models/Invitation'
import Invoice from '../models/Invoice'
import Membership from '../models/Membership'
import Organization from '../models/Organization'
import Package from '../models/Package'
import Session from '../models/Session'
import Subscription from '../models/Subscription'
import UsageCounter, { quotaMetrics } from '../models/UsageCounter'
import User from '../models/User'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { pageLimit } from '../http/cursor'
import { recordAudit } from '../services/audit'
import { hashOpaqueToken, randomToken } from '../security/tokens'
import { sendInvitationEmail } from '../services/email'
import { provisionClient } from '../services/hierarchy/provisioning'
import { packageForSubscription, resolveLimits } from '../services/packages'
import { requireRecentAuthentication } from '../middleware/platformAdmin'

/**
 * Customer management.
 *
 * The admin surface offered counts, a list of organisation names, and a button
 * to request support access. Everything an operator actually does to a customer
 * — create one, look at one, suspend one, change what they pay, see why their
 * card failed, get them signed in again — had no route at all, so it was done
 * by hand in the database or not at all.
 *
 * MOUNTED UNDER /admin: platform admin/owner plus MFA is already enforced on
 * the mount. Individually destructive actions additionally demand RECENT
 * authentication, because "suspend this customer" and "revoke every session"
 * should not be available to a laptop somebody walked away from.
 */

const router = Router()

function objectId(value: unknown, label: string): string {
  const id = String(value || '')
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, `Invalid ${label}`, `${label} identifier is invalid`)
  return id
}

async function customerOrFail(organizationId: string): Promise<any> {
  const found: any = await Organization.findOne({ _id: organizationId }).lean()
  if (!found) throw new HttpError(404, 'Customer not found', 'No organisation with that identifier exists')
  return found
}

/* -------------------------------------------------------------------- list */

/**
 * The customer list, filterable by the things support is actually asked about.
 *
 * Deliberately paginated and projected: this is the one screen on the platform
 * that reads across every tenant, so it returns organisation metadata and
 * commercial state only, and never a contact, message or deal.
 */
router.get('/', asyncHandler(async (req, res) => {
  const limit = pageLimit(req.query.limit)
  const query: Record<string, unknown> = {}

  if (req.query.status) query.status = String(req.query.status)
  if (req.query.kind) query.kind = String(req.query.kind)
  if (req.query.agencyId) query.parentOrganizationId = objectId(req.query.agencyId, 'agency')
  if (req.query.search) {
    const search = String(req.query.search).trim().slice(0, 120)
    // Escaped: an unescaped user string in a regex is both an injection and a
    // way to pin the database with a catastrophic backtrack.
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // eslint-disable-next-line security/detect-non-literal-regexp -- every metacharacter is escaped above and the input is bounded to 120 characters, so no user string can alter the pattern or build a catastrophic backtrack; this suppression stops being justified if either precondition is removed
    query.$or = [{ name: new RegExp(safe, 'i') }, { slug: new RegExp(safe, 'i') }]
  }

  const rows: any[] = await Organization.find(query).sort({ createdAt: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const ids = page.map((row) => row._id)

  const [subscriptions, memberCounts] = await Promise.all([
    Subscription.find({ organizationId: { $in: ids } }).lean(),
    Membership.aggregate([
      { $match: { organizationId: { $in: ids }, status: 'active' } },
      { $group: { _id: '$organizationId', count: { $sum: 1 } } },
    ]),
  ])
  const subscriptionBy = new Map(subscriptions.map((row: any) => [String(row.organizationId), row]))
  const membersBy = new Map(memberCounts.map((row: any) => [String(row._id), row.count]))

  res.json({
    items: page.map((row) => {
      const subscription: any = subscriptionBy.get(String(row._id))
      return {
        id: String(row._id),
        name: row.name,
        slug: row.slug,
        kind: row.kind,
        status: row.status,
        parentOrganizationId: row.parentOrganizationId ? String(row.parentOrganizationId) : null,
        memberCount: membersBy.get(String(row._id)) ?? 0,
        plan: subscription?.plan ?? 'free',
        subscriptionStatus: subscription?.status ?? 'inactive',
        trialEndsAt: subscription?.trialEndsAt ?? null,
        createdAt: row.createdAt,
      }
    }),
    hasMore,
  })
}))

/* ------------------------------------------------------------------ detail */

/**
 * Everything about one customer on one screen.
 *
 * Assembled here rather than left to six separate requests from the client,
 * because a support agent with a customer on the phone needs the whole picture
 * at once — plan, quota headroom, who the users are, and whether the last
 * invoice was paid.
 */
router.get('/:organizationId', asyncHandler(async (req, res) => {
  const organizationId = objectId(req.params.organizationId, 'organization')
  const organization = await customerOrFail(organizationId)

  const [subscription, members, invoices, agency, pendingInvitations] = await Promise.all([
    Subscription.findOne({ organizationId }).lean(),
    Membership.find({ organizationId, status: 'active' }).populate('userId', 'email displayName status mfaEnabled lastLoginAt').limit(100).lean(),
    Invoice.find({ organizationId }).sort({ createdAt: -1 }).limit(20).lean(),
    organization.parentOrganizationId
      ? Organization.findOne({ _id: organization.parentOrganizationId }).select('name kind').lean()
      : Promise.resolve(null),
    Invitation.find({ organizationId, acceptedAt: null, revokedAt: null }).select('email role expiresAt createdAt').lean(),
  ])

  const packageDocument = await packageForSubscription(subscription)
  const resolved = resolveLimits({
    plan: (subscription as any)?.plan ?? 'free',
    subscription,
    packageDocument,
  })

  // Consumption against the resolved limits, so "are they about to hit a wall"
  // is answerable without opening the customer's own reports.
  const counters: any[] = await UsageCounter.find({ organizationId }).sort({ periodStart: -1 }).limit(quotaMetrics.length * 2).lean()
  const usage = quotaMetrics.map((metric) => {
    const counter = counters.find((row) => row.metric === metric)
    const limit = resolved.limits[metric]
    const used = Number(counter?.used || 0)
    return { metric, limit, used, remaining: Math.max(0, limit - used), source: resolved.sources[metric] }
  })

  res.json({
    customer: {
      id: String(organization._id),
      name: organization.name,
      slug: organization.slug,
      kind: organization.kind,
      status: organization.status,
      timezone: organization.timezone,
      createdAt: organization.createdAt,
      onboardingCompletedAt: organization.onboardingCompletedAt ?? null,
      priceLocked: Boolean(organization.priceLocked),
      agencyAccessMode: organization.agencyAccessMode,
      agency: agency ? { id: String((agency as any)._id), name: (agency as any).name } : null,
    },
    subscription: subscription
      ? {
        plan: (subscription as any).plan,
        status: (subscription as any).status,
        seats: (subscription as any).seats,
        trialEndsAt: (subscription as any).trialEndsAt ?? null,
        cancelAtPeriodEnd: Boolean((subscription as any).cancelAtPeriodEnd),
        currentPeriodEnd: (subscription as any).currentPeriodEnd ?? null,
        suspendedAt: (subscription as any).suspendedAt ?? null,
        packageCode: resolved.packageCode,
        packageVersion: resolved.packageVersion,
        quotaOverrides: (subscription as any).quotaOverrides ?? [],
      }
      : null,
    usage,
    members: members.map((row: any) => ({
      membershipId: String(row._id),
      role: row.role,
      user: row.userId
        ? {
          id: String(row.userId._id),
          email: row.userId.email,
          displayName: row.userId.displayName,
          status: row.userId.status,
          mfaEnabled: Boolean(row.userId.mfaEnabled),
          lastLoginAt: row.userId.lastLoginAt ?? null,
        }
        : null,
    })),
    pendingInvitations: pendingInvitations.map((row: any) => ({
      id: String(row._id), email: row.email, role: row.role, expiresAt: row.expiresAt, createdAt: row.createdAt,
    })),
    invoices: invoices.map((row: any) => ({
      id: String(row._id),
      number: row.number ?? null,
      status: row.status,
      currency: row.currency,
      totalMinorUnits: row.totalMinorUnits,
      amountPaidMinorUnits: row.amountPaidMinorUnits,
      lastPaymentError: row.lastPaymentError ?? null,
      attemptCount: row.attemptCount,
      dueAt: row.dueAt ?? null,
      paidAt: row.paidAt ?? null,
      hostedInvoiceUrl: row.hostedInvoiceUrl ?? null,
      createdAt: row.createdAt,
    })),
  })
}))

/* ------------------------------------------------------------------ create */

/**
 * Create a customer from the platform side.
 *
 * Uses exactly the same provisioning path an agency uses, so there is one
 * definition of what a complete customer is. The alternative — a second,
 * admin-only creation routine — is how the agency path came to create an
 * Organization and nothing else.
 */
router.post('/', asyncHandler(async (req: any, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 200)
  if (!name) throw new HttpError(400, 'Name required', 'A customer name is required')
  const ownerEmail = String(req.body?.ownerEmail || '').trim().toLowerCase()
  if (!ownerEmail) throw new HttpError(400, 'Owner email required', 'A customer needs an owner who can sign in')

  const agencyId = req.body?.agencyId ? objectId(req.body.agencyId, 'agency') : null
  if (agencyId) {
    const agency: any = await Organization.findOne({ _id: agencyId, kind: 'agency' }).select('_id').lean()
    if (!agency) throw new HttpError(400, 'Agency not found', 'No agency with that identifier exists')
  }

  const result = await provisionClient({
    name,
    createdBy: String(req.auth?.userId || ''),
    parentOrganizationId: agencyId,
    ownerEmail,
    ownerName: req.body?.ownerName ? String(req.body.ownerName).slice(0, 120) : undefined,
    // A business the operator attached to an agency did not choose that agency,
    // so access is asked for rather than assumed.
    agencyAccessMode: agencyId ? 'on_request' : 'standing',
  })

  let invitationDelivered = true
  try {
    await sendInvitationEmail(ownerEmail, name, result.invitationToken)
  } catch {
    invitationDelivered = false
  }

  await recordAudit({
    req, organizationId: String(result.organization._id), action: 'platform.customer_created',
    entityType: 'Organization', entityId: String(result.organization._id),
    metadata: { name, ownerEmail, agencyId, invitationDelivered },
  })
  res.status(201).json({
    id: String(result.organization._id),
    name,
    slug: result.organization.slug,
    ownerUserId: result.ownerUserId,
    ownerExisted: result.ownerExisted,
    invitationDelivered,
  })
}))

/* ------------------------------------------------------------------ update */

router.patch('/:organizationId', asyncHandler(async (req: any, res) => {
  const organizationId = objectId(req.params.organizationId, 'organization')
  await customerOrFail(organizationId)

  const update: Record<string, unknown> = {}
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 160)
    if (!name) throw new HttpError(400, 'Name required', 'A customer name cannot be empty')
    update.name = name
  }
  if (req.body?.timezone !== undefined) update.timezone = String(req.body.timezone).slice(0, 80)
  if (req.body?.retentionDays !== undefined) {
    const days = Number(req.body.retentionDays)
    if (!Number.isInteger(days) || days < 7 || days > 90) throw new HttpError(400, 'Invalid retention', 'Retention must be between 7 and 90 days')
    update.retentionDays = days
  }
  if (!Object.keys(update).length) throw new HttpError(400, 'Nothing to update', 'Provide at least one field to change')

  await Organization.updateOne({ _id: organizationId }, { $set: update })
  await recordAudit({ req, organizationId, action: 'platform.customer_updated', entityType: 'Organization', entityId: organizationId, metadata: { fields: Object.keys(update) } })
  res.json({ id: organizationId, updated: Object.keys(update) })
}))

/* -------------------------------------------------------------- lifecycle */

/**
 * Suspend, reactivate, or soft-delete.
 *
 * `status` on Organization is already checked by `authenticate`, so suspending
 * takes effect on the customer's very next request rather than whenever their
 * token happens to expire. Deletion is SOFT: a status change and nothing more.
 * An admin button that destroys a tenant's data irreversibly, one click and one
 * confirm away, is not a feature — purging is the retention pipeline's job,
 * with its own ledger and its own delay.
 */
router.post('/:organizationId/status', requireRecentAuthentication, asyncHandler(async (req: any, res) => {
  const organizationId = objectId(req.params.organizationId, 'organization')
  const organization = await customerOrFail(organizationId)

  const status = String(req.body?.status || '')
  if (!['active', 'suspended', 'deleted'].includes(status)) {
    throw new HttpError(400, 'Invalid status', 'Status must be active, suspended or deleted')
  }
  const reason = String(req.body?.reason || '').trim().slice(0, 300)
  if (status !== 'active' && !reason) {
    // Recorded because "why is this customer suspended" is asked months later,
    // usually by somebody who was not the person who suspended them.
    throw new HttpError(400, 'Reason required', 'Give a reason when suspending or deleting a customer; it is recorded on the audit trail')
  }

  await Organization.updateOne({ _id: organizationId }, { $set: { status } })
  if (status === 'suspended') {
    // Sessions are revoked so suspension is immediate rather than eventual.
    await Session.updateMany({ currentOrganizationId: organizationId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'organization_suspended' } })
    await Subscription.updateOne({ organizationId }, { $set: { suspendedAt: new Date(), suspendedReason: reason } })
  }
  if (status === 'active') {
    await Subscription.updateOne({ organizationId }, { $set: { suspendedAt: null, suspendedReason: null } })
  }

  await recordAudit({
    req, organizationId, action: `platform.customer_${status}`,
    entityType: 'Organization', entityId: organizationId,
    metadata: { reason, previousStatus: organization.status },
  })
  res.json({ id: organizationId, status, previousStatus: organization.status })
}))

/* ------------------------------------------------------------ plan & quota */

/** Assign a package, change tier, or set a trial. */
router.post('/:organizationId/plan', asyncHandler(async (req: any, res) => {
  const organizationId = objectId(req.params.organizationId, 'organization')
  await customerOrFail(organizationId)

  const update: Record<string, unknown> = {}
  let assigned: any = null

  if (req.body?.packageId !== undefined) {
    if (req.body.packageId === null) {
      // Back to the built-in defaults for the tier.
      update.packageId = null
      update.packageVersion = null
    } else {
      const packageId = objectId(req.body.packageId, 'package')
      assigned = await Package.findOne({ _id: packageId }).lean()
      if (!assigned) throw new HttpError(404, 'Package not found', 'No package with that identifier exists')
      if ((assigned as any).status === 'draft') {
        throw new HttpError(409, 'Package is a draft', 'Publish the package before assigning a customer to it', problemType('package-not-published'))
      }
      update.packageId = packageId
      update.packageVersion = (assigned as any).version
      // The tier follows the package, so metering and Stripe stay consistent
      // with what the customer was actually sold.
      update.plan = (assigned as any).tier
    }
  }

  if (req.body?.trialEndsAt !== undefined) {
    if (req.body.trialEndsAt === null) update.trialEndsAt = null
    else {
      const ends = new Date(String(req.body.trialEndsAt))
      if (Number.isNaN(ends.getTime())) throw new HttpError(400, 'Invalid date', 'trialEndsAt must be a valid date')
      update.trialEndsAt = ends
    }
  }

  if (req.body?.seats !== undefined) {
    const seats = Number(req.body.seats)
    if (!Number.isInteger(seats) || seats < 1) throw new HttpError(400, 'Invalid seats', 'Seats must be a whole number of at least 1')
    update.seats = seats
  }

  if (!Object.keys(update).length) throw new HttpError(400, 'Nothing to change', 'Provide a package, trial or seat count')

  await Subscription.updateOne({ organizationId }, { $set: update }, { upsert: true })
  await recordAudit({
    req, organizationId, action: 'platform.customer_plan_changed',
    entityType: 'Subscription', entityId: organizationId,
    metadata: { ...update, packageCode: assigned?.code ?? null },
  })
  res.json({ id: organizationId, ...update })
}))

/**
 * Raise or lower one customer's quota without touching the package.
 *
 * The case this exists for: a customer hits a limit mid-month and needs it
 * raised now. The alternatives are moving them to a plan they did not ask for,
 * or editing the package and raising the limit for every customer on it.
 */
router.post('/:organizationId/quota-overrides', asyncHandler(async (req: any, res) => {
  const organizationId = objectId(req.params.organizationId, 'organization')
  await customerOrFail(organizationId)

  const metric = String(req.body?.metric || '')
  if (!quotaMetrics.includes(metric as any)) {
    throw new HttpError(400, 'Invalid metric', `Metric must be one of: ${quotaMetrics.join(', ')}`)
  }
  const reason = String(req.body?.reason || '').trim().slice(0, 300)
  if (!reason) throw new HttpError(400, 'Reason required', 'Record why this customer has a different quota; it is reviewed against revenue')

  const unlimited = Boolean(req.body?.unlimited)
  const included = unlimited ? 0 : Number(req.body?.included)
  if (!unlimited && (!Number.isInteger(included) || included < 0)) {
    throw new HttpError(400, 'Invalid quota', 'Included units must be a whole number of at least 0')
  }

  let expiresAt: Date | null = null
  if (req.body?.expiresAt) {
    expiresAt = new Date(String(req.body.expiresAt))
    if (Number.isNaN(expiresAt.getTime())) throw new HttpError(400, 'Invalid date', 'expiresAt must be a valid date')
  }

  // Replace any existing override for this metric rather than stacking them, so
  // the effective quota is always readable from one entry.
  await Subscription.updateOne({ organizationId }, { $pull: { quotaOverrides: { metric } } })
  await Subscription.updateOne(
    { organizationId },
    { $push: { quotaOverrides: { metric, included, unlimited, reason, setBy: req.auth?.userId, setAt: new Date(), expiresAt } } },
    { upsert: true },
  )
  await recordAudit({
    req, organizationId, action: 'platform.customer_quota_override_set',
    entityType: 'Subscription', entityId: organizationId,
    metadata: { metric, included, unlimited, reason, expiresAt },
  })
  res.json({ id: organizationId, metric, included, unlimited, expiresAt })
}))

router.delete('/:organizationId/quota-overrides/:metric', asyncHandler(async (req: any, res) => {
  const organizationId = objectId(req.params.organizationId, 'organization')
  await customerOrFail(organizationId)
  const metric = String(req.params.metric)
  if (!quotaMetrics.includes(metric as any)) throw new HttpError(400, 'Invalid metric', 'Unknown quota metric')

  await Subscription.updateOne({ organizationId }, { $pull: { quotaOverrides: { metric } } })
  await recordAudit({ req, organizationId, action: 'platform.customer_quota_override_removed', entityType: 'Subscription', entityId: organizationId, metadata: { metric } })
  res.json({ id: organizationId, metric, removed: true })
}))

/* -------------------------------------------------------------- agency move */

router.post('/:organizationId/agency', asyncHandler(async (req: any, res) => {
  const organizationId = objectId(req.params.organizationId, 'organization')
  const organization = await customerOrFail(organizationId)
  if (organization.kind !== 'client') throw new HttpError(400, 'Not a client', 'Only a client workspace can belong to an agency')

  const agencyId = req.body?.agencyId === null ? null : objectId(req.body?.agencyId, 'agency')
  if (agencyId) {
    const agency: any = await Organization.findOne({ _id: agencyId, kind: 'agency' }).select('_id').lean()
    if (!agency) throw new HttpError(400, 'Agency not found', 'No agency with that identifier exists')
  }

  /**
   * Moving a customer between agencies revokes the OLD agency's access
   * immediately, and does not grant the new one standing access.
   *
   * The customer agreed to be managed by a particular agency. Handing that
   * relationship to a different company without asking is not a move; it is a
   * disclosure. The new agency asks, and the customer approves.
   */
  await Organization.updateOne({ _id: organizationId }, { $set: { parentOrganizationId: agencyId, agencyAccessMode: 'on_request' } })
  await recordAudit({
    req, organizationId, action: 'platform.customer_agency_changed',
    entityType: 'Organization', entityId: organizationId,
    metadata: { from: organization.parentOrganizationId ? String(organization.parentOrganizationId) : null, to: agencyId },
  })
  res.json({
    id: organizationId,
    agencyId,
    agencyAccessMode: 'on_request',
    note: 'The new agency must request access and the customer must approve it.',
  })
}))

/* ------------------------------------------------------------ user recovery */

/** Resend the owner invitation, for a customer who never got their email. */
router.post('/:organizationId/invitations/resend', asyncHandler(async (req: any, res) => {
  const organizationId = objectId(req.params.organizationId, 'organization')
  const organization = await customerOrFail(organizationId)

  const email = String(req.body?.email || '').trim().toLowerCase()
  if (!email) throw new HttpError(400, 'Email required', 'Give the email address to resend to')

  const existing: any = await Invitation.findOne({ organizationId, email, acceptedAt: null, revokedAt: null }).lean()
  if (!existing) throw new HttpError(404, 'No pending invitation', 'There is no pending invitation for that address in this workspace')

  // A fresh token, and the old one revoked: resending must not leave two live
  // invitations, because revoking one later would not revoke the other.
  const token = randomToken(48)
  await Invitation.updateOne({ _id: existing._id, organizationId }, { $set: { tokenHash: hashOpaqueToken(token), expiresAt: new Date(Date.now() + 14 * 86_400_000) } })
  try {
    await sendInvitationEmail(email, organization.name, token)
  } catch {
    throw new HttpError(503, 'Delivery failed', 'The invitation could not be delivered; try again shortly', 'about:blank', true)
  }

  await recordAudit({ req, organizationId, action: 'platform.invitation_resent', entityType: 'Invitation', entityId: String(existing._id), metadata: { email } })
  res.json({ id: String(existing._id), email, resent: true })
}))

/**
 * Sign every one of this customer's users out.
 *
 * For a compromised account or a departing employee, where waiting for tokens
 * to expire is not good enough.
 */
router.post('/:organizationId/sessions/revoke', requireRecentAuthentication, asyncHandler(async (req: any, res) => {
  const organizationId = objectId(req.params.organizationId, 'organization')
  await customerOrFail(organizationId)

  const memberships: any[] = await Membership.find({ organizationId, status: 'active' }).select('userId').lean()
  const userIds = memberships.map((row) => row.userId)
  const result = await Session.updateMany(
    { userId: { $in: userIds }, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'platform_admin_revoked' } },
  )
  await recordAudit({
    req, organizationId, action: 'platform.customer_sessions_revoked',
    entityType: 'Organization', entityId: organizationId,
    metadata: { userCount: userIds.length, sessionCount: Number((result as any).modifiedCount || 0) },
  })
  res.json({ id: organizationId, revokedSessions: Number((result as any).modifiedCount || 0), affectedUsers: userIds.length })
}))

/** Unlock an account locked out by failed sign-in attempts. */
router.post('/:organizationId/users/:userId/unlock', requireRecentAuthentication, asyncHandler(async (req: any, res) => {
  const organizationId = objectId(req.params.organizationId, 'organization')
  const userId = objectId(req.params.userId, 'user')
  await customerOrFail(organizationId)

  // Scoped through membership: an admin acting on a customer must not be able
  // to reach an arbitrary platform account by passing any user id.
  const membership = await Membership.exists({ organizationId, userId, status: 'active' })
  if (!membership) throw new HttpError(404, 'Not a member', 'That user is not an active member of this workspace')

  await User.updateOne({ _id: userId }, { $set: { failedLoginCount: 0 }, $unset: { lockUntil: '' } })
  await recordAudit({ req, organizationId, action: 'platform.user_unlocked', entityType: 'User', entityId: userId })
  res.json({ id: userId, unlocked: true })
}))

export default router
