import { Router } from 'express'
import { Types } from 'mongoose'
import Organization from '../models/Organization'
import SupportAccessRequest from '../models/SupportAccessRequest'
import Contact from '../models/Contact'
import ScheduledStep from '../models/ScheduledStep'
import Conversation from '../models/Conversation'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { requireOrganizationId } from '../types/authenticatedRequest'
import { recordAudit } from '../services/audit'
import { switchSessionOrganization } from '../auth/sessionService'
import { assertCorporate } from '../middleware/platformAdmin'
import { createAgency, provisionClient } from '../services/hierarchy/provisioning'
import { sendInvitationEmail } from '../services/email'
import {
  agencyContextFor,
  allAgencies,
  clientsOfAgency,
  MAX_SUPPORT_GRANT_HOURS,
  resolveAccess,
  unaffiliatedClients,
} from '../services/hierarchy/access'

/**
 * The hierarchy surface.
 *
 * Three tiers see three different things, and each endpoint here returns
 * organisation metadata and health counts only — never a contact, message or
 * deal. To work inside a client, a user switches into it and every subsequent
 * request is scoped to that single organisation like any other.
 */

const router = Router()

function objectId(value: unknown, label: string): string {
  const id = String(value || '')
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, `Invalid ${label}`, `${label} identifier is invalid`)
  return id
}

function platformRole(req: any): string {
  return String(req.auth?.platformRole || 'user')
}

/**
 * Corporate authority.
 *
 * Reads of the estate identify every tenant on the platform, and creating an
 * agency creates authority over other people's workspaces. Both now require the
 * same second factor `/admin` has always required — previously neither did, so
 * a stolen platform-owner password was refused at `/admin` and admitted here.
 */
function requireCorporate(req: any, options: { mfa?: boolean } = {}): void {
  assertCorporate(req, { mfa: options.mfa ?? true })
}

/**
 * Health figures for one organisation.
 *
 * Counts only. An agency needs to know a client has eleven unread replies; it
 * does not need to read them from a portfolio screen.
 */
async function healthFor(organizationId: string) {
  const [contacts, unread, overdue, unknown] = await Promise.all([
    Contact.countDocuments({ organizationId, archivedAt: null }),
    Conversation.countDocuments({ organizationId, unreadCount: { $gt: 0 } }),
    ScheduledStep.countDocuments({ organizationId, status: 'pending', dueAt: { $lt: new Date(Date.now() - 15 * 60_000) } }),
    ScheduledStep.countDocuments({ organizationId, status: 'outcome_unknown' }),
  ])
  return { contacts, unreadThreads: unread, overdueSteps: overdue, unknownOutcomes: unknown }
}

/* ------------------------------------------------------------------ context */

/**
 * What tier is this user, and what should their navigation show?
 *
 * Called on load. A client's own staff get `tier: 'client'` and no evidence
 * that an agency sits above them — a business owner should see their business,
 * not their position in somebody else's portfolio.
 */
router.get('/context', asyncHandler(async (req: any, res) => {
  const userId = String(req.auth?.userId || '')
  const corporate = ['owner', 'admin'].includes(platformRole(req))
  const agency = await agencyContextFor(userId)

  res.json({
    tier: corporate ? 'corporate' : agency ? 'agency' : 'client',
    corporate,
    isSupport: platformRole(req) === 'support',
    agencyOrganizationId: agency?.agencyOrganizationId ?? null,
    agencyRole: agency?.role ?? null,
  })
}))

/* ---------------------------------------------------------------- corporate */

/** Every agency, with the clients beneath each. */
router.get('/corporate/portfolio', asyncHandler(async (req, res) => {
  requireCorporate(req)
  const agencies = await allAgencies()
  const direct = await unaffiliatedClients()
  const portfolio = []
  let clientTotal = 0
  const estate = { overdueSteps: 0, unknownOutcomes: 0, unreadThreads: 0 }

  for (const agency of agencies) {
    const clients = await clientsOfAgency(agency.id)
    clientTotal += clients.length
    let needsAttention = 0
    for (const client of clients) {
      const health = await healthFor(client.id)
      estate.overdueSteps += health.overdueSteps
      estate.unknownOutcomes += health.unknownOutcomes
      estate.unreadThreads += health.unreadThreads
      if (health.overdueSteps || health.unknownOutcomes) needsAttention += 1
    }
    portfolio.push({
      agency,
      clientCount: clients.length,
      needsAttention,
      clients: clients.map((client) => ({ id: client.id, name: client.name, memberCount: client.memberCount })),
    })
  }
  for (const client of direct) {
    const health = await healthFor(client.id)
    estate.overdueSteps += health.overdueSteps
    estate.unknownOutcomes += health.unknownOutcomes
    estate.unreadThreads += health.unreadThreads
  }

  res.json({
    // The counts an operator actually asks for, rather than one total.
    totals: {
      agencies: agencies.length,
      clientsViaAgencies: clientTotal,
      directClients: direct.length,
      allWorkspaces: clientTotal + direct.length,
    },
    estate,
    agencies: portfolio,
    // Direct signups belong to nobody and would otherwise be invisible.
    unaffiliatedClients: direct,
  })
}))

router.post('/corporate/agencies', asyncHandler(async (req, res) => {
  requireCorporate(req)
  const name = String(req.body?.name || '').trim().slice(0, 200)
  if (!name) throw new HttpError(400, 'Name required', 'An agency name is required')
  // `slug` and `createdBy` are both required by the schema and were both
  // absent here, so this endpoint could never once have succeeded. Built
  // through the provisioning service so the omission cannot recur.
  const created: any = await createAgency({ name, createdBy: String(req.auth?.userId || '') })
  await recordAudit({ req, organizationId: String(created._id), action: 'platform.agency_created', entityType: 'Organization', entityId: String(created._id), metadata: { name } })
  res.status(201).json({ id: String(created._id), name, slug: created.slug, kind: 'agency' })
}))

/* ------------------------------------------------------------------- agency */

/** The agency console: every client, with enough health to triage by. */
router.get('/agency/clients', asyncHandler(async (req: any, res) => {
  const context = await agencyContextFor(String(req.auth?.userId || ''))
  if (!context) throw new HttpError(403, 'Not an agency', 'This view is restricted to agency owners and admins')

  const clients = await clientsOfAgency(context.agencyOrganizationId)
  const withHealth = []
  for (const client of clients) {
    const organization: any = await Organization.findOne({ _id: client.id }).select('agencyAccessMode').lean()
    withHealth.push({
      ...client,
      health: await healthFor(client.id),
      // Decides whether the console offers "Open" or "Request access".
      accessMode: organization?.agencyAccessMode ?? 'standing',
    })
  }
  res.json({ agencyOrganizationId: context.agencyOrganizationId, clients: withHealth })
}))

/**
 * Create a client workspace under this agency.
 *
 * Provisioning rather than signup: the agency onboards the business, so there
 * is no card form and no email verification loop for the end customer.
 */
router.post('/agency/clients', asyncHandler(async (req: any, res) => {
  const context = await agencyContextFor(String(req.auth?.userId || ''))
  if (!context) throw new HttpError(403, 'Not an agency', 'This view is restricted to agency owners and admins')

  const name = String(req.body?.name || '').trim().slice(0, 200)
  if (!name) throw new HttpError(400, 'Name required', 'A client name is required')
  const ownerEmail = String(req.body?.ownerEmail || '').trim().toLowerCase()
  if (!ownerEmail) throw new HttpError(400, 'Owner email required', 'A client needs an owner who can sign in; provide their email address')

  /**
   * Provisioning is the whole set or none of it.
   *
   * This previously created an Organization alone — and did so without `slug`
   * or `createdBy`, so it failed validation anyway. Had it succeeded it would
   * have been worse: a workspace with no owner, no membership, no invitation
   * and no subscription, which appears on the agency console as a client and
   * cannot be signed into by anybody.
   */
  const result = await provisionClient({
    name,
    createdBy: String(req.auth?.userId || ''),
    parentOrganizationId: context.agencyOrganizationId,
    ownerEmail,
    ownerName: req.body?.ownerName ? String(req.body.ownerName).slice(0, 120) : undefined,
    // The agency built this workspace, so standing access is the honest
    // default. The client can change it the moment they sign in.
    agencyAccessMode: 'standing',
  })

  // Delivery failure must not leave a provisioned-but-unreachable customer, so
  // it is reported rather than swallowed; the invitation can be resent.
  let invitationDelivered = true
  try {
    await sendInvitationEmail(ownerEmail, name, result.invitationToken)
  } catch {
    invitationDelivered = false
  }

  await recordAudit({
    req, organizationId: String(result.organization._id), action: 'agency.client_provisioned',
    entityType: 'Organization', entityId: String(result.organization._id),
    metadata: {
      name, agencyOrganizationId: context.agencyOrganizationId,
      ownerEmail, ownerExisted: result.ownerExisted, invitationDelivered,
    },
  })
  res.status(201).json({
    id: String(result.organization._id),
    name,
    slug: result.organization.slug,
    kind: 'client',
    ownerUserId: result.ownerUserId,
    ownerExisted: result.ownerExisted,
    invitationDelivered,
    invitationExpiresAt: result.invitationExpiresAt,
  })
}))

/**
 * Switch into an organisation.
 *
 * Returns the resolved access rather than performing the switch, so the client
 * knows which organisation it is now acting in and by what authority. Every
 * subsequent request carries that single organisation exactly as a direct
 * member's would.
 */
router.post('/switch', asyncHandler(async (req: any, res) => {
  const organizationId = objectId(req.body?.organizationId, 'organization')
  const access = await resolveAccess({ userId: String(req.auth?.userId || ''), organizationId })
  if (!access.granted) {
    throw new HttpError(403, 'No access to that workspace', access.reason === 'agency_access_not_granted'
      ? 'This client requires approval before their workspace can be opened. Request access and wait for them to approve it.'
      : access.reason === 'support_access_not_granted'
        ? 'Support access to this workspace has not been approved, or has expired.'
        : 'You do not have access to that workspace.', problemType('workspace-access-denied'))
  }

  const organization: any = await Organization.findOne({ _id: organizationId }).select('name kind').lean()

  /**
   * Actually switch.
   *
   * This endpoint previously resolved access, wrote an audit record, returned
   * a cheerful 200 — and changed nothing. The session still pointed at the
   * original organisation, so "Open workspace" reloaded the workspace the user
   * was already in. Rebinding the session is what makes the switch real: the
   * access token is reissued with the new `org` claim and the session's
   * current organisation is updated, so every subsequent request is scoped to
   * the workspace the user asked for.
   */
  await switchSessionOrganization({
    sessionId: String(req.auth?.sessionId || ''),
    userId: String(req.auth?.userId || ''),
    organizationId,
    res,
  })
  // Audited every time. "Which agency staff member opened which client, when"
  // needs an answer, and so does the same question about support.
  await recordAudit({
    req, organizationId, action: 'workspace.switched',
    entityType: 'Organization', entityId: organizationId,
    metadata: { via: access.via, role: access.role, expiresAt: access.expiresAt ?? null },
  })
  res.json({
    organizationId,
    name: organization?.name,
    kind: organization?.kind,
    via: access.via,
    role: access.role,
    expiresAt: access.expiresAt ?? null,
  })
}))

/**
 * Ask a client for permission to enter their workspace.
 *
 * The console's "Request access" button used to call `/switch`, which under
 * `on_request` simply returned 403 — the agency was told no, and the client was
 * never told anybody had asked. This creates the request the client can then
 * approve or refuse, on the same record and with the same expiry as a support
 * grant, so there is one approval mechanism rather than two.
 */
router.post('/agency/clients/:clientId/request-access', asyncHandler(async (req: any, res) => {
  const context = await agencyContextFor(String(req.auth?.userId || ''))
  if (!context) throw new HttpError(403, 'Not an agency', 'This action is restricted to agency owners and admins')

  const organizationId = objectId(req.params.clientId, 'organization')
  const organization: any = await Organization.findOne({ _id: organizationId, kind: 'client' })
    .select('name parentOrganizationId agencyAccessMode').lean()
  if (!organization) throw new HttpError(404, 'Client not found', 'No client workspace with that identifier exists')
  // An agency may only ask about its OWN clients. Without this an agency could
  // request access to any workspace on the platform by identifier.
  if (String(organization.parentOrganizationId || '') !== String(context.agencyOrganizationId)) {
    throw new HttpError(403, 'Not your client', 'That workspace does not belong to your agency')
  }
  if (organization.agencyAccessMode !== 'on_request') {
    throw new HttpError(409, 'Access already standing', 'This client has granted standing access; open the workspace directly')
  }

  const reason = String(req.body?.reason || '').trim().slice(0, 1_000)
  if (!reason) throw new HttpError(400, 'Reason required', 'Say why you need to enter this workspace; the client sees this')

  // One live request per agency user per workspace: repeated clicks should not
  // bury the client under identical approvals.
  const existing = await SupportAccessRequest.findOne({
    organizationId, requestedBy: req.auth?.userId, status: 'pending',
  }).select('_id createdAt').lean()
  if (existing) {
    return res.status(200).json({ id: String((existing as any)._id), status: 'pending', duplicate: true })
  }

  const created: any = await SupportAccessRequest.create({
    organizationId,
    requestedBy: req.auth?.userId,
    reason,
    status: 'pending',
    dataAccessEnabled: false,
    // Set on approval; a pending request grants nothing, and the real expiry
    // is decided by the client when they approve.
    expiresAt: new Date(Date.now() + MAX_SUPPORT_GRANT_HOURS * 3_600_000),
  })
  await recordAudit({
    req, organizationId, action: 'agency.access_requested',
    entityType: 'SupportAccessRequest', entityId: String(created._id),
    metadata: { agencyOrganizationId: context.agencyOrganizationId, reason },
  })
  res.status(201).json({ id: String(created._id), status: 'pending', duplicate: false })
}))

/**
 * The client's own control over agency access.
 *
 * Deliberately on the client's workspace, not the agency's console. Whether
 * somebody outside the business may walk in is the business's decision to make
 * and to reverse.
 */
router.post('/agency-access-mode', asyncHandler(async (req: any, res) => {
  if (!['owner', 'admin'].includes(String(req.auth?.role || ''))) {
    throw new HttpError(403, 'Insufficient role', 'Only an owner or admin can change who may enter this workspace')
  }
  const organizationId = requireOrganizationId(req)
  const mode = String(req.body?.mode || '')
  if (!['standing', 'on_request'].includes(mode)) {
    throw new HttpError(400, 'Invalid mode', 'Mode must be standing or on_request')
  }
  await Organization.updateOne({ _id: organizationId }, { $set: { agencyAccessMode: mode } })
  await recordAudit({ req, organizationId, action: 'hierarchy.agency_access_mode_changed', entityType: 'Organization', entityId: organizationId, metadata: { mode } })
  res.json({ mode })
}))

/* ---------------------------------------------------------- support access */

/**
 * The customer's view of support access.
 *
 * Deliberately readable by any member, not just an administrator. Everyone in a
 * business is entitled to see who from outside can currently reach their data,
 * for how long, and how often they have used it.
 */
router.get('/support-access', asyncHandler(async (req, res) => {
  const organizationId = requireOrganizationId(req)
  const rows: any[] = await SupportAccessRequest.find({ organizationId }).sort({ _id: -1 }).limit(50)
    .populate('requestedBy', 'name email').lean()

  const now = new Date()
  res.json({
    requests: rows.map((row) => ({
      id: String(row._id),
      requestedBy: (row.requestedBy as any)?.name || 'Support',
      reason: row.reason,
      status: row.revokedAt ? 'revoked' : row.expiresAt < now && row.status === 'approved' ? 'expired' : row.status,
      dataAccessEnabled: Boolean(row.dataAccessEnabled),
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      useCount: Number(row.useCount || 0),
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    })),
    // Stated on the endpoint rather than left to documentation.
    note: 'Support cannot see your data unless you approve a request, and every approval expires automatically. You can withdraw access at any time.',
  })
}))

router.post('/support-access/:requestId/decision', asyncHandler(async (req: any, res) => {
  if (!['owner', 'admin'].includes(String(req.auth?.role || ''))) {
    throw new HttpError(403, 'Insufficient role', 'Only an owner or admin can decide a support access request')
  }
  const organizationId = requireOrganizationId(req)
  const requestId = objectId(req.params.requestId, 'request')
  const decision = String(req.body?.decision || '')
  if (!['approved', 'rejected'].includes(decision)) throw new HttpError(400, 'Invalid decision', 'Decision must be approved or rejected')

  const hours = Math.max(1, Math.min(Number(req.body?.hours ?? 4), MAX_SUPPORT_GRANT_HOURS))
  const request: any = await SupportAccessRequest.findOneAndUpdate(
    { _id: requestId, organizationId, status: 'pending' },
    {
      $set: {
        status: decision,
        decidedBy: req.auth?.userId,
        decidedAt: new Date(),
        decisionNote: String(req.body?.note || '').slice(0, 1_000),
        // Approval is what turns the record from consent evidence into access,
        // and the expiry is set here rather than trusted from the request.
        dataAccessEnabled: decision === 'approved',
        expiresAt: new Date(Date.now() + hours * 3_600_000),
      },
    },
    { new: true },
  ).lean()
  if (!request) throw new HttpError(404, 'Request not found', 'No pending support access request with that identifier exists')

  await recordAudit({
    req, organizationId, action: `support_access.${decision}`,
    entityType: 'SupportAccessRequest', entityId: requestId,
    metadata: { hours, expiresAt: (request as any).expiresAt },
  })
  res.json({ id: requestId, status: decision, expiresAt: (request as any).expiresAt })
}))

/** Withdraw access immediately, mid-session. */
router.post('/support-access/:requestId/revoke', asyncHandler(async (req: any, res) => {
  if (!['owner', 'admin'].includes(String(req.auth?.role || ''))) {
    throw new HttpError(403, 'Insufficient role', 'Only an owner or admin can withdraw support access')
  }
  const organizationId = requireOrganizationId(req)
  const requestId = objectId(req.params.requestId, 'request')
  const result = await SupportAccessRequest.updateOne(
    { _id: requestId, organizationId, status: 'approved', revokedAt: null },
    { $set: { revokedAt: new Date(), revokedBy: req.auth?.userId, dataAccessEnabled: false } },
  )
  if (!Number((result as any).modifiedCount || 0)) throw new HttpError(404, 'Nothing to withdraw', 'No live support access grant with that identifier exists')
  await recordAudit({ req, organizationId, action: 'support_access.revoked', entityType: 'SupportAccessRequest', entityId: requestId })
  res.json({ id: requestId, revoked: true })
}))

export default router
