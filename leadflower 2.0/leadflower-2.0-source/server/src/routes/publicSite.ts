import { Router } from 'express'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'
import AnswerCapsule from '../models/AnswerCapsule'
import BusinessProfile from '../models/BusinessProfile'
import ContactActivity from '../models/ContactActivity'
import SiteConnection from '../models/SiteConnection'
import { asyncHandler, HttpError, problemType } from '../http/problem'
import { buildBusinessGraph } from '../services/content/entityGraph'

/**
 * What the customer's website is allowed to do.
 *
 * THE SECURITY BOUNDARY, STATED ONCE
 *
 * A site token can WRITE nothing but events, and READ nothing but the business
 * profile and published questions — both of which are already public on that
 * customer's own website.
 *
 * It cannot read contacts, messages, deals or bookings. That is the whole
 * design: small business WordPress installs are compromised regularly, and when
 * this one is, nothing about THEIR customers leaks through it, because none of
 * it was ever reachable from here.
 *
 * Everything below is unauthenticated in the session sense — the plugin has no
 * user — so every route proves the token itself.
 */

const router = Router()

// Tighter than the general public limiter. These are machine callers with a
// predictable rhythm; a burst means something is wrong or hostile.
const pluginLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false })
const pairLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false })

function hash(value: string): string {
  return crypto.createHash('sha256').update(String(value).toUpperCase().trim()).digest('hex')
}

/**
 * Identify the calling site from its token.
 *
 * Compared by hash, so the database never holds a usable token and a backup
 * leaks nothing.
 */
async function siteFromToken(req: any): Promise<any> {
  const supplied = String(
    req.headers['x-logicflower-site-token'] || req.query.t || '',
  ).trim()
  if (!supplied) throw new HttpError(401, 'Not connected', 'This site is not connected to a workspace')

  // tenant-safe: the token itself identifies the workspace; every subsequent
  // query is constrained by the organizationId it resolves to
  const connection: any = await SiteConnection.findOne({
    siteTokenHash: hash(supplied),
    status: 'connected',
  }).lean()
  if (!connection) throw new HttpError(401, 'Not connected', 'This site token is not recognised or has been revoked')
  return connection
}

/**
 * Exchange a pairing code for a site token.
 *
 * Rate limited hard: a four-by-four code from a 32-character alphabet is around
 * a trillion combinations, but a code is only alive for fifteen minutes and
 * guessing should be pointless rather than merely difficult.
 */
router.post('/pair', pairLimiter, asyncHandler(async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase()
  const siteUrl = String(req.body?.siteUrl || '').trim().slice(0, 300)
  const version = String(req.body?.version || '').slice(0, 20)

  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    throw new HttpError(400, 'Invalid code', 'Pairing codes look like ABCD-2345', problemType('pairing-code-invalid'))
  }
  if (!/^https?:\/\//i.test(siteUrl)) {
    throw new HttpError(400, 'Invalid site address', 'The site address must be a full URL', problemType('site-url-invalid'))
  }

  // tenant-safe: the pairing code identifies the workspace it was issued for
  const connection: any = await SiteConnection.findOne({
    pairingCodeHash: hash(code),
    pairingExpiresAt: { $gt: new Date() },
  }).lean()

  if (!connection) {
    // One message for wrong and expired alike. Distinguishing them tells an
    // attacker which codes exist.
    throw new HttpError(400, 'Code not accepted', 'That pairing code is not valid. Codes expire after fifteen minutes — generate a new one.', problemType('pairing-code-rejected'))
  }

  const siteToken = crypto.randomBytes(32).toString('base64url')
  await SiteConnection.updateOne({ _id: connection._id }, {
    $set: {
      siteTokenHash: hash(siteToken),
      tokenIssuedAt: new Date(),
      siteUrl,
      pluginVersion: version,
      platform: 'wordpress',
      status: 'connected',
      lastSeenAt: new Date(),
      // Single use. The code dies the moment it is spent.
      pairingCodeHash: null,
      pairingExpiresAt: null,
    },
  })

  res.json({ siteToken, connected: true })
}))

/**
 * The business schema and published questions.
 *
 * Both are already public on that customer's own website — this is what the
 * plugin renders. Nothing here is a secret.
 */
router.get('/payload', pluginLimiter, asyncHandler(async (req, res) => {
  const connection = await siteFromToken(req)
  const organizationId = connection.organizationId

  const profile: any = await BusinessProfile.findOne({ organizationId }).lean()
  if (!profile) {
    return res.json({ schema: null, questions: [], note: 'No business details have been entered yet.' })
  }

  const capsules: any[] = await AnswerCapsule.find({ organizationId, status: 'published' })
    .select('question answer').limit(30).lean()

  await SiteConnection.updateOne({ _id: connection._id }, {
    $set: { lastSeenAt: new Date(), pluginVersion: String(req.query.v || connection.pluginVersion || '') },
  })

  res.setHeader('Cache-Control', 'public, max-age=900')
  res.json({
    schema: buildBusinessGraph({ ...profile, url: profile.website, capsules }),
    questions: capsules.map((capsule) => ({ question: capsule.question, answer: capsule.answer })),
  })
}))

/**
 * A visitor tapped a phone number, asked for directions, or submitted a form.
 *
 * These are the events every competing tool is blind to. They are what let the
 * attribution report say "six jobs, four of which arrived as missed calls"
 * rather than stopping at the click.
 *
 * NO PERSONAL DATA IS ACCEPTED HERE. The plugin sends what happened and on
 * which page — never who did it. A public endpoint that accepted identities
 * would be a way to write into somebody's CRM from outside.
 */
router.post('/event', pluginLimiter, asyncHandler(async (req, res) => {
  const connection = await siteFromToken(req)

  const kind = String(req.body?.kind || '')
  if (!['call', 'directions', 'form', 'page'].includes(kind)) {
    throw new HttpError(400, 'Unknown event', 'Event kind must be call, directions, form or page')
  }

  await ContactActivity.create({
    organizationId: connection.organizationId,
    // Deliberately not linked to a contact. This is an anonymous signal from a
    // public web page; associating it with a person would mean accepting an
    // identity from an unauthenticated caller.
    contactId: null,
    type: `website_${kind}`,
    summary: `Website ${kind}`,
    visibilitySource: 'website',
    visibilityLandingPage: String(req.body?.page || '').slice(0, 300),
    occurredAt: new Date(),
  })

  // 204: the plugin uses sendBeacon and never reads a body.
  res.status(204).end()
}))

export default router
