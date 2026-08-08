import { Router } from 'express'
import { Types } from 'mongoose'
import Package, { billingIntervals, packageTiers } from '../models/Package'
import Subscription from '../models/Subscription'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { pageLimit } from '../http/cursor'
import { recordAudit } from '../services/audit'
import { nextPackageVersion, normaliseQuotas } from '../services/packages'

/**
 * Package management.
 *
 * The plans were four object literals in source. An operator could not change a
 * price, adjust a quota, run a promotion or sell a bespoke package without a
 * code change and a deploy — which meant, in practice, that commercial terms
 * were set by whoever was free to write TypeScript that week.
 *
 * MOUNTED UNDER /admin, so every route here already requires a platform
 * admin/owner role AND multi-factor authentication. Nothing in this file
 * re-checks that; duplicating the guard invites the two copies to disagree.
 */

const router = Router()

function objectId(value: unknown, label: string): string {
  const id = String(value || '')
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, `Invalid ${label}`, `${label} identifier is invalid`)
  return id
}

function packageView(row: any) {
  return {
    id: String(row._id),
    code: row.code,
    version: row.version,
    name: row.name,
    description: row.description ?? null,
    status: row.status,
    tier: row.tier,
    priceMinorUnits: row.priceMinorUnits,
    currency: row.currency,
    interval: row.interval,
    trialDays: row.trialDays,
    stripePriceId: row.stripePriceId ?? null,
    quotas: row.quotas ?? [],
    features: row.features ?? [],
    includedSeats: row.includedSeats ?? null,
    publiclySelectable: Boolean(row.publiclySelectable),
    publishedAt: row.publishedAt ?? null,
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Read and validate the commercial fields common to create and revise. */
function readPackageBody(body: any) {
  const name = String(body?.name || '').trim().slice(0, 120)
  if (!name) throw new HttpError(400, 'Name required', 'A package name is required')

  const tier = String(body?.tier || '')
  if (!packageTiers.includes(tier as any)) {
    throw new HttpError(400, 'Invalid tier', `Tier must be one of: ${packageTiers.join(', ')}`)
  }

  const priceMinorUnits = Number(body?.priceMinorUnits)
  if (!Number.isInteger(priceMinorUnits) || priceMinorUnits < 0) {
    // Minor units and integers only. A price of 19.99 arriving as a float is
    // how an invoice ends up a penny out.
    throw new HttpError(400, 'Invalid price', 'Price must be a whole number of minor currency units (e.g. 1999 for 19.99)')
  }

  const currency = String(body?.currency || 'USD').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'Invalid currency', 'Currency must be a three-letter ISO code')

  const interval = String(body?.interval || 'month')
  if (!billingIntervals.includes(interval as any)) {
    throw new HttpError(400, 'Invalid interval', `Interval must be one of: ${billingIntervals.join(', ')}`)
  }

  const trialDays = Number(body?.trialDays ?? 0)
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) {
    throw new HttpError(400, 'Invalid trial', 'Trial length must be a whole number of days between 0 and 365')
  }

  let quotas
  try {
    quotas = normaliseQuotas(body?.quotas)
  } catch (error) {
    throw new HttpError(400, 'Invalid quotas', (error as Error).message, problemType('invalid-package-quotas'))
  }

  const includedSeats = body?.includedSeats === null || body?.includedSeats === undefined
    ? null
    : Number(body.includedSeats)
  if (includedSeats !== null && (!Number.isInteger(includedSeats) || includedSeats < 1)) {
    throw new HttpError(400, 'Invalid seats', 'Included seats must be a whole number of at least 1, or null')
  }

  // A paid package that nobody can be charged for is a support ticket waiting
  // to happen, so the Stripe link is checked at the point of publishing below.
  return {
    name,
    description: String(body?.description || '').slice(0, 1_000) || undefined,
    tier,
    priceMinorUnits,
    currency,
    interval,
    trialDays,
    quotas,
    features: Array.isArray(body?.features) ? body.features.map((feature: unknown) => String(feature).slice(0, 60)).slice(0, 50) : [],
    includedSeats,
    stripePriceId: body?.stripePriceId ? String(body.stripePriceId).slice(0, 200) : null,
    publiclySelectable: Boolean(body?.publiclySelectable),
  }
}

/* ------------------------------------------------------------------- list */

router.get('/', asyncHandler(async (req, res) => {
  const limit = pageLimit(req.query.limit)
  const query: Record<string, unknown> = {}
  if (req.query.status) query.status = String(req.query.status)
  if (req.query.code) query.code = String(req.query.code).toLowerCase()
  // `latestOnly` answers the question the screen actually asks — "what do we
  // sell" — rather than listing every historical revision by default.
  const rows: any[] = await Package.find(query).sort({ code: 1, version: -1 }).limit(limit).lean()

  const latestOnly = String(req.query.latestOnly ?? 'true') !== 'false'
  const seen = new Set<string>()
  const items = (latestOnly ? rows.filter((row) => {
    if (seen.has(row.code)) return false
    seen.add(row.code)
    return true
  }) : rows).map(packageView)

  // Subscriber counts, so archiving something in use is a visible decision.
  // tenant-safe: platform-wide count of subscriptions PER PACKAGE, grouped and returned as counts only; no tenant record is read or returned
  const counts = await Subscription.aggregate([
    { $match: { packageId: { $ne: null } } },
    { $group: { _id: '$packageId', count: { $sum: 1 } } },
  ])
  const byPackage = new Map(counts.map((row: any) => [String(row._id), row.count]))

  res.json({ items: items.map((item) => ({ ...item, subscriberCount: byPackage.get(item.id) ?? 0 })) })
}))

router.get('/:packageId', asyncHandler(async (req, res) => {
  const packageId = objectId(req.params.packageId, 'package')
  const found: any = await Package.findOne({ _id: packageId }).lean()
  if (!found) throw new HttpError(404, 'Package not found', 'No package with that identifier exists')
  // tenant-safe: platform-wide count of how many subscriptions hold this package; a number, not a tenant record
  const subscriberCount = await Subscription.countDocuments({ packageId })
  const versions: any[] = await Package.find({ code: found.code }).sort({ version: -1 }).select('version status publishedAt archivedAt').lean()
  res.json({ package: { ...packageView(found), subscriberCount }, versions })
}))

/* ----------------------------------------------------------------- create */

router.post('/', asyncHandler(async (req: any, res) => {
  const code = String(req.body?.code || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(code)) {
    throw new HttpError(400, 'Invalid code', 'Package code must be lowercase letters, numbers and hyphens')
  }
  if (await Package.exists({ code })) {
    throw new HttpError(409, 'Package exists', 'A package with that code already exists; publish a new version of it instead')
  }
  const fields = readPackageBody(req.body)
  const created: any = await Package.create({
    ...fields, code, version: 1, status: 'draft', createdBy: req.auth?.userId,
  })
  await recordAudit({
    req, action: 'platform.package_created', entityType: 'Package', entityId: String(created._id),
    metadata: { code, tier: fields.tier, priceMinorUnits: fields.priceMinorUnits, currency: fields.currency },
  })
  res.status(201).json({ package: packageView(created) })
}))

/* ------------------------------------------------------------------- edit */

/**
 * Edit a DRAFT package.
 *
 * Only a draft. Editing a live package would silently reprice every customer
 * already on it, which is the single most damaging thing this surface could do
 * — and it would do it without anybody approving a price change. To change a
 * live package, publish a new version.
 */
router.patch('/:packageId', asyncHandler(async (req: any, res) => {
  const packageId = objectId(req.params.packageId, 'package')
  const existing: any = await Package.findOne({ _id: packageId }).lean()
  if (!existing) throw new HttpError(404, 'Package not found', 'No package with that identifier exists')
  if (existing.status !== 'draft') {
    throw new HttpError(409, 'Package is not a draft',
      'A published package cannot be edited, because that would reprice every customer already on it. Publish a new version instead.',
      problemType('package-not-draft'))
  }
  const fields = readPackageBody({ ...existing, ...req.body })
  await Package.updateOne({ _id: packageId, status: 'draft' }, { $set: fields })
  await recordAudit({ req, action: 'platform.package_updated', entityType: 'Package', entityId: packageId, metadata: { code: existing.code } })
  const updated: any = await Package.findOne({ _id: packageId }).lean()
  res.json({ package: packageView(updated) })
}))

/* --------------------------------------------------------------- publish */

router.post('/:packageId/publish', asyncHandler(async (req: any, res) => {
  const packageId = objectId(req.params.packageId, 'package')
  const existing: any = await Package.findOne({ _id: packageId }).lean()
  if (!existing) throw new HttpError(404, 'Package not found', 'No package with that identifier exists')
  if (existing.status !== 'draft') throw new HttpError(409, 'Already published', 'Only a draft package can be published')

  // A paid package with no Stripe price cannot be sold; publishing it would put
  // a Buy button on the pricing page that 503s.
  if (existing.priceMinorUnits > 0 && existing.publiclySelectable && !existing.stripePriceId) {
    throw new HttpError(409, 'Stripe price required',
      'A publicly selectable paid package needs a Stripe price identifier before it can be published.',
      problemType('package-missing-stripe-price'))
  }

  await Package.updateOne({ _id: packageId, status: 'draft' }, { $set: { status: 'active', publishedAt: new Date() } })
  await recordAudit({ req, action: 'platform.package_published', entityType: 'Package', entityId: packageId, metadata: { code: existing.code, version: existing.version } })
  const updated: any = await Package.findOne({ _id: packageId }).lean()
  res.json({ package: packageView(updated) })
}))

/* --------------------------------------------------------- new version */

/**
 * Draft the next version of a product line.
 *
 * Existing subscribers stay pinned to the version they bought. This is what
 * makes a price change safe: the new terms apply to new customers and to
 * customers deliberately migrated, never retroactively.
 */
router.post('/:packageId/versions', asyncHandler(async (req: any, res) => {
  const packageId = objectId(req.params.packageId, 'package')
  const source: any = await Package.findOne({ _id: packageId }).lean()
  if (!source) throw new HttpError(404, 'Package not found', 'No package with that identifier exists')

  const fields = readPackageBody({ ...source, ...req.body })
  const version = await nextPackageVersion(source.code)
  let created: any
  try {
    created = await Package.create({
      ...fields, code: source.code, version, status: 'draft',
      supersedesVersion: source.version, createdBy: req.auth?.userId,
    })
  } catch (error: any) {
    // The unique index on (code, version) is the authority; two administrators
    // drafting at once means one retries rather than both claiming a version.
    if (error?.code === 11000) {
      throw new HttpError(409, 'Version conflict', 'Another version was created at the same time; try again.')
    }
    throw error
  }
  await recordAudit({ req, action: 'platform.package_version_drafted', entityType: 'Package', entityId: String(created._id), metadata: { code: source.code, version, supersedes: source.version } })
  res.status(201).json({ package: packageView(created) })
}))

/* --------------------------------------------------------------- archive */

router.post('/:packageId/archive', asyncHandler(async (req: any, res) => {
  const packageId = objectId(req.params.packageId, 'package')
  const existing: any = await Package.findOne({ _id: packageId }).lean()
  if (!existing) throw new HttpError(404, 'Package not found', 'No package with that identifier exists')

  /**
   * Archiving withdraws a package from SALE. It does not cancel anybody.
   *
   * Subscribers keep the terms they bought — pulling entitlements out from
   * under paying customers because a product line was retired would be a
   * billing incident, not a housekeeping action.
   */
  // tenant-safe: platform-wide count used to warn that archiving affects live subscribers; a number, not a tenant record
  const subscriberCount = await Subscription.countDocuments({ packageId })
  await Package.updateOne({ _id: packageId }, { $set: { status: 'archived', archivedAt: new Date(), publiclySelectable: false } })
  await recordAudit({ req, action: 'platform.package_archived', entityType: 'Package', entityId: packageId, metadata: { code: existing.code, version: existing.version, subscriberCount } })
  res.json({
    id: packageId, status: 'archived', subscriberCount,
    note: subscriberCount
      ? `${subscriberCount} subscription(s) remain on this package and are unaffected. Migrate them deliberately if you want them moved.`
      : 'No subscriptions were on this package.',
  })
}))

router.post('/:packageId/duplicate', asyncHandler(async (req: any, res) => {
  const packageId = objectId(req.params.packageId, 'package')
  const source: any = await Package.findOne({ _id: packageId }).lean()
  if (!source) throw new HttpError(404, 'Package not found', 'No package with that identifier exists')

  const code = String(req.body?.code || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(code)) throw new HttpError(400, 'Invalid code', 'A new package code is required')
  if (await Package.exists({ code })) throw new HttpError(409, 'Package exists', 'A package with that code already exists')

  const created: any = await Package.create({
    ...readPackageBody({ ...source, ...req.body }),
    code, version: 1, status: 'draft',
    // Never carry a Stripe price across: two packages selling the same price
    // makes revenue attribution impossible to unpick afterwards.
    stripePriceId: null,
    publiclySelectable: false,
    createdBy: req.auth?.userId,
  })
  await recordAudit({ req, action: 'platform.package_duplicated', entityType: 'Package', entityId: String(created._id), metadata: { from: source.code, to: code } })
  res.status(201).json({ package: packageView(created) })
}))

export default router
