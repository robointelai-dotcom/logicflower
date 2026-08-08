import { NextFunction, Request, Response, Router } from 'express'
import { Types } from 'mongoose'
import { z } from 'zod'
import Organization from '../models/Organization'
import Membership, { membershipRoles } from '../models/Membership'
import Subscription from '../models/Subscription'
import Invitation from '../models/Invitation'
import User from '../models/User'
import AuditEvent from '../models/AuditEvent'
import { asyncHandler, HttpError, parseBody } from '../http/problem'
import { decodeCursor, encodeCursor, pageLimit } from '../http/cursor'
import { requireIdempotency } from '../middleware/idempotency'
import { canView, requireRole } from '../middleware/rbac'
import { hashOpaqueToken, randomToken } from '../security/tokens'
import { sendInvitationEmail } from '../services/email'
import { recordAudit } from '../services/audit'
import { switchSessionOrganization } from '../auth/sessionService'
import { withMongoTransaction } from '../dbTransaction'
import SupportAccessRequest from '../models/SupportAccessRequest'
import { addOrganizationOwner, compensateOwnerRemoval, reserveOwnerRemoval } from '../services/organizationOwnership'
import PlatformConnection from '../models/PlatformConnection'
import ConnectionScan from '../models/ConnectionScan'
import Workflow from '../models/Workflow'
import WorkflowDryRunApproval from '../models/WorkflowDryRunApproval'
import NotificationChannel from '../models/NotificationChannel'
import { assertRetentionAllowed, resolvePlanPolicy } from '../services/planPolicy'
import DataLifecycleRequest from '../models/DataLifecycleRequest'
import { enqueueDataLifecycleRequest, serializeLifecycleRequest } from '../services/dataLifecycle'
import { requireAdminMfa, requireRecentAuthentication } from '../middleware/platformAdmin'

const router = Router()
const manage = requireRole('owner', 'admin')

function slugify(name: string): string {
  const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'organization'
  return `${base}-${randomToken(5).toLowerCase()}`
}

function currentOrganization(req: Request): string {
  if (!req.auth?.organizationId) throw new HttpError(403, 'Organization required', 'Select an organization first')
  return req.auth.organizationId
}

function requirePathOrganization(req: Request, _res: Response, next: NextFunction): void {
  if (req.params.organizationId !== req.auth?.organizationId) {
    next(new HttpError(403, 'Organization mismatch', 'The requested organization is not the active organization'))
    return
  }
  next()
}

const organizationSchema = z.object({
  name: z.string().trim().min(2).max(160).refine((value) => !/[\r\n]/.test(value)),
  timezone: z.string().trim().min(1).max(80).default('UTC'),
}).strict()
const invitationSchema = z.object({
  email: z.string().email().max(254).transform((email) => email.trim().toLowerCase()),
  role: z.enum(membershipRoles).default('viewer'),
}).strict()

router.get('/', asyncHandler(async (req, res) => {
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  const query: Record<string, unknown> = { userId: req.auth!.userId, status: 'active' }
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await Membership.find(query)
    .sort({ _id: -1 }).limit(limit + 1)
    .populate('organizationId', 'name slug status timezone onboardingCompletedAt createdAt')
    .lean()
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit).map((row) => ({
    membershipId: String(row._id),
    organization: row.organizationId,
    role: row.role,
  }))
  res.json({ items, nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null })
}))

router.post('/', requireIdempotency, asyncHandler(async (req, res) => {
  const body = parseBody(organizationSchema, req)
  let organization: any
  try {
    organization = await Organization.create({
      name: body.name,
      slug: slugify(body.name),
      timezone: body.timezone,
      createdBy: req.auth!.userId,
    })
    await Promise.all([
      Membership.create({ organizationId: organization._id, userId: req.auth!.userId, role: 'owner', status: 'active' }),
      Subscription.create({ organizationId: organization._id, plan: 'free', status: 'inactive' }),
    ])
  } catch (error) {
    if (organization?._id) {
      await Promise.all([
        Membership.deleteMany({ organizationId: organization._id }),
        Subscription.deleteMany({ organizationId: organization._id }),
        Organization.deleteOne({ _id: organization._id, createdBy: req.auth!.userId }),
      ]).catch(() => undefined)
    }
    throw error
  }
  await recordAudit({ action: 'organization.created', req, organizationId: String(organization._id), entityType: 'Organization', entityId: String(organization._id) })
  res.status(201).json({ organization })
}))

router.get('/current', asyncHandler(async (req, res) => {
  const organizationId = currentOrganization(req)
  const [organization, planPolicy] = await Promise.all([
    Organization.findOne({ _id: organizationId, status: 'active' }).lean(),
    resolvePlanPolicy(organizationId),
  ])
  if (!organization) throw new HttpError(404, 'Organization not found', 'Organization not found')
  res.json({ organization, role: req.auth!.role, planPolicy })
}))

router.patch('/current', requireRole('owner', 'admin'), asyncHandler(async (req, res) => {
  const body = parseBody(z.object({
    name: z.string().trim().min(2).max(160).refine((value) => !/[\r\n]/.test(value)).optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    retentionDays: z.number().int().min(7).max(2_555).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' }), req)
  if (body.timezone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }).format() }
    catch { throw new HttpError(400, 'Invalid timezone', 'timezone must be a valid IANA timezone') }
  }
  if (body.retentionDays !== undefined) await assertRetentionAllowed(currentOrganization(req), body.retentionDays)
  const organization = await Organization.findOneAndUpdate({ _id: currentOrganization(req), status: 'active' }, {
    $set: body,
  }, { new: true })
  if (!organization) throw new HttpError(404, 'Organization not found', 'Organization not found')
  await recordAudit({ action: 'organization.updated', req, entityType: 'Organization', entityId: String(organization._id), metadata: { fields: Object.keys(body) } })
  res.json({ organization })
}))

async function onboardingStatus(organizationId: string) {
  const organization: any = await Organization.findOne({ _id: organizationId, status: 'active' }).select('timezone retentionDays onboardingCompletedAt').lean()
  if (!organization) throw new HttpError(404, 'Organization not found', 'Organization not found')
  const connections: any[] = await PlatformConnection.find({ organizationId, status: { $in: ['active', 'degraded'] } }).select('_id provider').lean()
  const connectionIds = connections.map((item) => item._id)
  const [latestScan, members, workflows, dryRuns, channels] = await Promise.all([
    connectionIds.length ? ConnectionScan.findOne({ organizationId, connectionId: { $in: connectionIds } }).sort({ createdAt: -1 }).lean() : null,
    Membership.countDocuments({ organizationId, status: 'active' }),
    Workflow.countDocuments({ organizationId, status: { $in: ['draft', 'published', 'paused'] } }),
    WorkflowDryRunApproval.countDocuments({ organizationId }),
    NotificationChannel.countDocuments({ organizationId, enabled: true }),
  ])
  const steps = {
    workspace: Boolean(organization.timezone && organization.retentionDays),
    connection: connections.length > 0,
    scan: latestScan?.status === 'completed',
    team: members > 1,
    workflow: workflows > 0 && dryRuns > 0,
    alerts: channels > 0,
  }
  const requiredKeys = ['workspace', 'connection', 'scan', 'workflow', 'alerts'] as const
  const missing = requiredKeys.filter((key) => !steps[key])
  return { organization, steps, missing, canComplete: missing.length === 0, latestScan }
}

router.get('/onboarding', asyncHandler(async (req, res) => {
  const status = await onboardingStatus(currentOrganization(req))
  res.json({
    completed: Boolean(status.organization.onboardingCompletedAt),
    completedAt: status.organization.onboardingCompletedAt || null,
    canComplete: status.canComplete,
    missing: status.missing,
    steps: status.steps,
    scan: status.latestScan ? {
      id: String(status.latestScan._id), connectionId: String(status.latestScan.connectionId), provider: status.latestScan.provider,
      status: status.latestScan.status, scannedCount: status.latestScan.scannedCount, duplicateGroups: status.latestScan.duplicateGroups,
      duplicateRecords: status.latestScan.duplicateRecords, invalidEmails: status.latestScan.invalidEmails,
      invalidPhones: status.latestScan.invalidPhones, missingPrimaryIdentifier: status.latestScan.missingPrimaryIdentifier,
      truncated: status.latestScan.truncated, createdAt: status.latestScan.createdAt, completedAt: status.latestScan.completedAt,
      error: status.latestScan.error,
    } : null,
  })
}))

router.post('/onboarding/complete', requireRole('owner', 'admin'), requireIdempotency, asyncHandler(async (req, res) => {
  const status = await onboardingStatus(currentOrganization(req))
  if (!status.canComplete) throw new HttpError(409, 'Onboarding requirements incomplete', `Complete the required setup steps: ${status.missing.join(', ')}`)
  const organization = await Organization.findOneAndUpdate({ _id: currentOrganization(req), status: 'active' }, {
    $set: { onboardingCompletedAt: new Date() },
  }, { new: true })
  if (!organization) throw new HttpError(404, 'Organization not found', 'Organization not found')
  await recordAudit({ action: 'organization.onboarding_completed', req, entityType: 'Organization', entityId: String(organization._id) })
  res.json({ completed: true, completedAt: organization.onboardingCompletedAt })
}))

router.get('/current/data-requests', requireRole('owner', 'admin'), asyncHandler(async (req, res) => {
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  const query: Record<string, unknown> = { organizationId: currentOrganization(req) }
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await DataLifecycleRequest.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({ items: rows.slice(0, limit).map(serializeLifecycleRequest), nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null })
}))

router.post('/current/export', requireRole('owner', 'admin'), requireIdempotency, asyncHandler(async (req, res) => {
  const organizationId = currentOrganization(req)
  const existing: any = await DataLifecycleRequest.findOne({ organizationId, type: 'export', status: { $in: ['queued', 'processing'] } }).sort({ createdAt: -1 }).lean()
  if (existing) { res.status(202).json({ request: serializeLifecycleRequest(existing) }); return }
  const request: any = await DataLifecycleRequest.create({ organizationId, requestedBy: req.auth!.userId, type: 'export', status: 'queued', nextAttemptAt: new Date() })
  await recordAudit({ action: 'organization.export_requested', req, entityType: 'DataLifecycleRequest', entityId: String(request._id) })
  await enqueueDataLifecycleRequest(String(request._id))
  res.status(202).json({ request: serializeLifecycleRequest(request) })
}))

router.post('/current/closure', requireRole('owner'), requireAdminMfa, requireRecentAuthentication, requireIdempotency, asyncHandler(async (req, res) => {
  const { confirmation } = parseBody(z.object({ confirmation: z.literal('DELETE WORKSPACE') }).strict(), req)
  void confirmation
  const organizationId = currentOrganization(req)
  const existing: any = await DataLifecycleRequest.findOne({ organizationId, type: 'closure', status: { $in: ['queued', 'processing', 'completed'] } }).sort({ createdAt: -1 }).lean()
  if (existing) { res.status(existing.status === 'completed' ? 200 : 202).json({ request: serializeLifecycleRequest(existing) }); return }
  const request: any = await DataLifecycleRequest.create({ organizationId, requestedBy: req.auth!.userId, type: 'closure', status: 'queued', nextAttemptAt: new Date() })
  await recordAudit({ action: 'organization.closure_requested', req, entityType: 'DataLifecycleRequest', entityId: String(request._id) })
  await enqueueDataLifecycleRequest(String(request._id))
  res.status(202).json({ request: serializeLifecycleRequest(request), message: 'The workspace is queued for credential revocation and verified deletion.' })
}))

router.post('/:organizationId/switch', asyncHandler(async (req, res) => {
  const organizationId = String(req.params.organizationId || '')
  if (!Types.ObjectId.isValid(organizationId)) throw new HttpError(400, 'Invalid organization', 'Organization identifier is invalid')
  const membership = await Membership.findOne({ organizationId, userId: req.auth!.userId, status: 'active' }).lean()
  if (!membership) throw new HttpError(403, 'Access denied', 'No active membership for this organization')
  await switchSessionOrganization({
    sessionId: req.auth!.sessionId,
    userId: req.auth!.userId,
    organizationId,
    res,
  })
  await recordAudit({ action: 'organization.switched', req, organizationId, entityType: 'Organization', entityId: organizationId })
  res.json({ currentOrganizationId: organizationId, role: membership.role })
}))

/**
 * The member list, at two different resolutions.
 *
 * This endpoint had NO role gate, and returned each member's email address,
 * whether they had MFA enabled and when they last signed in — to anyone with a
 * membership, including `viewer`, `billing` and `customer`. "Which of these
 * accounts has no second factor" is precisely the question an attacker who has
 * obtained one low-privilege login wants answered, and the API answered it.
 *
 * Administrators still see everything they need to administer. Everyone else
 * sees who their colleagues are and what they do — a display name and a role,
 * which is what a member list is FOR — and nothing about how those accounts are
 * secured.
 */
function memberProjection(row: any, privileged: boolean) {
  const user = row.userId || {}
  const base = {
    id: String(row._id),
    user: { id: String(user._id || ''), displayName: user.displayName || null },
    role: row.role,
    joinedAt: row.joinedAt,
  }
  if (!privileged) return base
  return {
    ...base,
    user: {
      ...base.user,
      email: user.email,
      status: user.status,
      mfaEnabled: Boolean(user.mfaEnabled),
      lastLoginAt: user.lastLoginAt ?? null,
    },
  }
}

async function listMembers(req: Request, res: Response) {
  const privileged = ['owner', 'admin'].includes(String(req.auth?.role || ''))
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  const query: Record<string, unknown> = { organizationId: currentOrganization(req), status: 'active' }
  if (cursor) query._id = { $lt: cursor }
  // The security-relevant columns are not selected at all unless they will be
  // returned, so they cannot leak through a later change to the projection.
  const fields = privileged ? 'email displayName status mfaEnabled lastLoginAt' : 'displayName'
  const rows: any[] = await Membership.find(query).sort({ _id: -1 }).limit(limit + 1)
    .populate('userId', fields).lean()
  const hasMore = rows.length > limit
  res.json({
    items: rows.slice(0, limit).map((row) => memberProjection(row, privileged)),
    nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null,
  })
}
router.get('/current/members', canView, asyncHandler(listMembers))
router.get('/:organizationId/members', requirePathOrganization, canView, asyncHandler(listMembers))

async function createInvitation(req: Request, res: Response) {
  const body = parseBody(invitationSchema, req)
  if (req.auth!.role === 'admin' && body.role === 'owner') throw new HttpError(403, 'Owner role required', 'Only an owner may invite another owner')
  const existingUser = await User.findOne({ email: body.email }).select('_id').lean()
  if (existingUser && await Membership.exists({ organizationId: currentOrganization(req), userId: existingUser._id, status: 'active' })) {
    throw new HttpError(409, 'Already a member', 'This user is already an active member')
  }
  await Invitation.updateMany({
    organizationId: currentOrganization(req), email: body.email, acceptedAt: null, revokedAt: null,
  }, { $set: { revokedAt: new Date() } })
  const token = randomToken(48)
  const invitation = await Invitation.create({
    organizationId: currentOrganization(req), email: body.email, role: body.role,
    tokenHash: hashOpaqueToken(token), invitedBy: req.auth!.userId,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  })
  const organization = await Organization.findById(currentOrganization(req)).select('name').lean()
  try {
    await sendInvitationEmail(body.email, organization?.name || 'your organization', token)
  } catch {
    await Invitation.deleteOne({ _id: invitation._id, organizationId: currentOrganization(req) })
    throw new HttpError(503, 'Invitation delivery failed', 'The invitation email could not be delivered; try again later', 'about:blank', true)
  }
  await recordAudit({ action: 'organization.invitation_created', req, entityType: 'Invitation', entityId: String(invitation._id), metadata: { email: body.email, role: body.role } })
  res.status(201).json({ invitation: { id: String(invitation._id), email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt } })
}
router.post('/current/invitations', manage, requireIdempotency, asyncHandler(createInvitation))
router.post('/:organizationId/invitations', requirePathOrganization, manage, requireIdempotency, asyncHandler(createInvitation))

async function listInvitations(req: Request, res: Response) {
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  const query: Record<string, unknown> = { organizationId: currentOrganization(req) }
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await Invitation.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({ items: rows.slice(0, limit), nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null })
}
router.get('/current/invitations', manage, asyncHandler(listInvitations))
router.get('/:organizationId/invitations', requirePathOrganization, manage, asyncHandler(listInvitations))

async function revokeInvitation(req: Request, res: Response) {
  const invitation = await Invitation.findOneAndUpdate({
    _id: req.params.invitationId, organizationId: currentOrganization(req), acceptedAt: null, revokedAt: null,
  }, { $set: { revokedAt: new Date() } }, { new: true })
  if (!invitation) throw new HttpError(404, 'Invitation not found', 'Active invitation not found')
  await recordAudit({ action: 'organization.invitation_revoked', req, entityType: 'Invitation', entityId: String(invitation._id) })
  res.status(204).end()
}
router.delete('/current/invitations/:invitationId', manage, asyncHandler(revokeInvitation))

router.post('/current/invitations/:invitationId/resend', manage, requireIdempotency, asyncHandler(async (req, res) => {
  const invitation: any = await Invitation.findOne({
    _id: req.params.invitationId, organizationId: currentOrganization(req), acceptedAt: null, revokedAt: null,
  })
  if (!invitation) throw new HttpError(404, 'Invitation not found', 'Active invitation not found')
  const token = randomToken(48)
  invitation.tokenHash = hashOpaqueToken(token)
  invitation.expiresAt = new Date(Date.now() + 7 * 86_400_000)
  await invitation.save()
  const organization = await Organization.findById(currentOrganization(req)).select('name').lean()
  await sendInvitationEmail(invitation.email, organization?.name || 'your organization', token)
  await recordAudit({ action: 'organization.invitation_resent', req, entityType: 'Invitation', entityId: String(invitation._id) })
  res.json({ invitation: { id: String(invitation._id), email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt } })
}))

router.post('/invitations/accept', requireIdempotency, asyncHandler(async (req, res) => {
  const { token } = parseBody(z.object({ token: z.string().min(32).max(300) }).strict(), req)
  const user = await User.findById(req.auth!.userId).select('email status').lean()
  if (!user || user.status !== 'active') throw new HttpError(401, 'Account unavailable', 'Account is not active')
  const invitation: any = await withMongoTransaction(async (session) => {
    // tenant-safe: single-use invitation token plus the authenticated email is the identifier; the organisation is carried on the claimed record
    const query = Invitation.findOneAndUpdate({
      tokenHash: hashOpaqueToken(token), email: user.email, acceptedAt: null, revokedAt: null, expiresAt: { $gt: new Date() },
    }, { $set: { acceptedAt: new Date() } }, { new: true })
    if (session) query.session(session)
    const claimed: any = await query
    if (!claimed) throw new HttpError(400, 'Invalid invitation', 'Invitation is invalid, expired, used, or belongs to another email')
    const existingQuery = Membership.findOne({ organizationId: claimed.organizationId, userId: user._id })
    if (session) existingQuery.session(session)
    const existing: any = await existingQuery
    const updateQuery = Membership.findOneAndUpdate({ organizationId: claimed.organizationId, userId: user._id }, {
      $set: { role: claimed.role, status: 'active', invitedBy: claimed.invitedBy, joinedAt: new Date() },
    }, { upsert: true, new: true, setDefaultsOnInsert: true })
    if (session) updateQuery.session(session)
    await updateQuery
    if (claimed.role === 'owner' && existing?.role !== 'owner') {
      const ownerQuery = Organization.updateOne({ _id: claimed.organizationId }, { $inc: { ownerCount: 1 } })
      if (session) ownerQuery.session(session)
      await ownerQuery
    }
    return claimed
  })
  await switchSessionOrganization({ sessionId: req.auth!.sessionId, userId: req.auth!.userId, organizationId: String(invitation.organizationId), res })
  await recordAudit({ action: 'organization.invitation_accepted', req, organizationId: String(invitation.organizationId), entityType: 'Invitation', entityId: String(invitation._id) })
  res.json({ currentOrganizationId: String(invitation.organizationId), role: invitation.role })
}))

router.patch('/current/members/:membershipId', manage, asyncHandler(async (req, res) => {
  const { role } = parseBody(z.object({ role: z.enum(membershipRoles) }).strict(), req)
  const target: any = await Membership.findOne({ _id: req.params.membershipId, organizationId: currentOrganization(req), status: 'active' })
  if (!target) throw new HttpError(404, 'Member not found', 'Active member not found')
  if (req.auth!.role === 'admin' && (target.role === 'owner' || role === 'owner')) throw new HttpError(403, 'Owner role required', 'Administrators cannot change owner membership')
  if (target.role === 'owner' && role !== 'owner') {
    if (!await reserveOwnerRemoval(currentOrganization(req))) throw new HttpError(409, 'Last owner required', 'Assign another owner before changing this membership')
  } else if (target.role !== 'owner' && role === 'owner') {
    await addOrganizationOwner(currentOrganization(req))
  }
  const previousRole = target.role
  try { target.role = role; await target.save() }
  catch (error) {
    if (previousRole === 'owner' && role !== 'owner') await compensateOwnerRemoval(currentOrganization(req))
    if (previousRole !== 'owner' && role === 'owner') await Organization.updateOne({ _id: currentOrganization(req), ownerCount: { $gt: 1 } }, { $inc: { ownerCount: -1 } })
    throw error
  }
  await recordAudit({ action: 'organization.member_role_changed', req, entityType: 'Membership', entityId: String(target._id), metadata: { role } })
  res.json({ member: { id: String(target._id), role: target.role } })
}))

router.delete('/current/members/:membershipId', manage, asyncHandler(async (req, res) => {
  const target: any = await Membership.findOne({ _id: req.params.membershipId, organizationId: currentOrganization(req), status: 'active' })
  if (!target) throw new HttpError(404, 'Member not found', 'Active member not found')
  if (req.auth!.role === 'admin' && target.role === 'owner') throw new HttpError(403, 'Owner role required', 'Administrators cannot remove an owner')
  if (target.role === 'owner') {
    if (!await reserveOwnerRemoval(currentOrganization(req))) throw new HttpError(409, 'Last owner required', 'Assign another owner before removing this membership')
  }
  try { target.status = 'suspended'; await target.save() }
  catch (error) {
    if (target.role === 'owner') await compensateOwnerRemoval(currentOrganization(req))
    throw error
  }
  await recordAudit({ action: 'organization.member_removed', req, entityType: 'Membership', entityId: String(target._id) })
  res.status(204).end()
}))

router.get('/current/audit', requireRole('owner', 'admin', 'operator', 'viewer', 'customer'), asyncHandler(async (req, res) => {
  const limit = pageLimit(req.query.limit)
  const cursor = decodeCursor(req.query.cursor)
  const query: Record<string, unknown> = { organizationId: currentOrganization(req) }
  if (cursor) query._id = { $lt: cursor }
  const rows: any[] = await AuditEvent.find(query).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  res.json({ items: rows.slice(0, limit), nextCursor: hasMore ? encodeCursor(rows[limit - 1]._id) : null })
}))

router.get('/current/support-access', requireRole('owner'), asyncHandler(async (req, res) => {
  const items = await SupportAccessRequest.find({ organizationId: currentOrganization(req) })
    .sort({ createdAt: -1 }).limit(100).select('-reason').lean()
  res.json({ items })
}))

router.post('/current/support-access/:requestId/decision', requireRole('owner'), requireIdempotency, asyncHandler(async (req, res) => {
  const body = parseBody(z.object({
    decision: z.enum(['approved', 'rejected']),
    note: z.string().trim().max(1_000).optional(),
  }).strict(), req)
  const request = await SupportAccessRequest.findOneAndUpdate({
    _id: req.params.requestId,
    organizationId: currentOrganization(req),
    status: 'pending',
    expiresAt: { $gt: new Date() },
  }, {
    $set: { status: body.decision, decidedBy: req.auth!.userId, decidedAt: new Date(), decisionNote: body.note, dataAccessEnabled: false },
  }, { new: true })
  if (!request) throw new HttpError(404, 'Access request unavailable', 'Pending, unexpired support access request not found')
  await recordAudit({ action: `platform.support_access_${body.decision}`, req, entityType: 'SupportAccessRequest', entityId: String(request._id) })
  res.json({ request: { id: String(request._id), status: request.status, dataAccessEnabled: false } })
}))

router.get('/:organizationId', requirePathOrganization, asyncHandler(async (req, res) => {
  const organization = await Organization.findOne({ _id: currentOrganization(req), status: 'active' }).lean()
  if (!organization) throw new HttpError(404, 'Organization not found', 'Organization not found')
  res.json({ organization, role: req.auth!.role })
}))

export default router
