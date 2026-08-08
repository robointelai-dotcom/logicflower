import crypto from 'crypto'
import Invitation from '../../models/Invitation'
import Membership from '../../models/Membership'
import Organization from '../../models/Organization'
import Subscription from '../../models/Subscription'
import User from '../../models/User'
import { HttpError } from '../../http/problem'
import { hashOpaqueToken, randomToken } from '../../security/tokens'
import { hashPassword } from '../../security/password'

/**
 * Creating an organisation, done once and correctly.
 *
 * Before this module every call site built an Organization literal by hand.
 * Two of them omitted `slug` and `createdBy`, both of which the schema marks
 * required, so "New agency" and "New client" failed validation at the database
 * and no agency or client could ever be provisioned. The fix is not to paste
 * the two missing fields into those two call sites — it is to stop hand-rolling
 * the literal, so the next call site cannot make the same omission.
 *
 * Provisioning a CLIENT is more than an Organization row. A workspace with no
 * owner, no membership and no way to sign in is not a customer; it is an
 * orphaned document that looks like one on an admin screen. `provisionClient`
 * therefore creates the whole set or none of it.
 */

/**
 * A URL-safe slug with a random suffix, so two "Acme Ltd" never collide.
 *
 * The suffix is drawn from an explicit [0-9a-z] alphabet rather than from
 * `randomToken`. `randomToken` returns base64url, whose alphabet includes `-`
 * and `_`; the original slug builder in the registration path lowercased it and
 * appended it directly, so roughly one organisation in eight has received a
 * slug containing an underscore or a doubled hyphen since launch. Harmless
 * today because nothing parses the slug, which is exactly why it would not have
 * been noticed until something did.
 */
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function slugSuffix(length = 6): string {
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let index = 0; index < length; index += 1) {
    // Modulo bias over a 36-character alphabet is a fraction of a percent and
    // irrelevant here: this is a collision breaker, not a secret.
    out += SLUG_ALPHABET.charAt(bytes[index]! % SLUG_ALPHABET.length)
  }
  return out
}

export function slugify(name: string): string {
  const base = name.normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 45).replace(/-+$/, '') || 'organization'
  return `${base}-${slugSuffix()}`
}

/**
 * Reserve a slug, retrying on the unique index rather than pre-checking.
 *
 * A read-then-write check loses to a concurrent create; the index is the only
 * authority on uniqueness, so we let it decide and retry on its error.
 */
async function createOrganizationWithSlug(fields: Record<string, unknown>, name: string): Promise<any> {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await Organization.create({ ...fields, slug: slugify(name) })
    } catch (error: any) {
      // 11000 is a duplicate key. Anything else is a real failure and is thrown.
      if (error?.code !== 11000) throw error
      lastError = error
    }
  }
  throw lastError
}

export interface CreateAgencyInput {
  name: string
  createdBy: string
}

/** An agency organisation. Owns clients; is never owned. */
export async function createAgency(input: CreateAgencyInput): Promise<any> {
  return createOrganizationWithSlug({
    name: input.name,
    kind: 'agency',
    parentOrganizationId: null,
    createdBy: input.createdBy,
  }, input.name)
}

export interface ProvisionClientInput {
  name: string
  /** The platform or agency user performing the provisioning. */
  createdBy: string
  /** The agency this client belongs to, or null for a corporate-provisioned direct client. */
  parentOrganizationId: string | null
  /** The end customer who will own the workspace. Required — see below. */
  ownerEmail: string
  ownerName?: string
  /**
   * Whether the parent agency may enter at will. Defaults to `standing` for an
   * agency-provisioned workspace, because the agency built it.
   */
  agencyAccessMode?: 'standing' | 'on_request'
  plan?: string
}

export interface ProvisionClientResult {
  organization: any
  ownerUserId: string
  membershipId: string
  invitationToken: string
  invitationExpiresAt: Date
  /** True when the owner already had a platform account and was attached. */
  ownerExisted: boolean
}

/**
 * Provision a complete client workspace.
 *
 * Creates, in order: the organisation, the owner user (if new), their owner
 * membership, a free subscription record, and an invitation the owner uses to
 * set a password and sign in. If any step fails, everything this call created
 * is removed — a half-provisioned customer is worse than a failed one, because
 * it is invisible until the customer complains they cannot log in.
 *
 * Mongo transactions are not assumed: the deployment target may be a standalone
 * server, and the existing registration path compensates by hand for the same
 * reason. This does the same.
 */
export async function provisionClient(input: ProvisionClientInput): Promise<ProvisionClientResult> {
  const email = String(input.ownerEmail || '').trim().toLowerCase()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, 'Owner email required', 'A valid email address for the workspace owner is required')
  }

  let organization: any
  let createdUserId: string | null = null
  let membership: any
  let invitation: any

  try {
    organization = await createOrganizationWithSlug({
      name: input.name,
      kind: 'client',
      parentOrganizationId: input.parentOrganizationId,
      createdBy: input.createdBy,
      agencyAccessMode: input.agencyAccessMode ?? 'standing',
      ownerCount: 1,
    }, input.name)

    // An existing platform user is attached rather than duplicated: email is
    // unique across the platform, so creating a second one would fail anyway.
    let owner: any = await User.findOne({ email }).select('_id status').lean()
    const ownerExisted = Boolean(owner)
    if (!owner) {
      // A password nobody knows. The owner sets a real one through the
      // invitation; until then the account cannot be signed into, and the
      // schema's `required` on passwordHash is still satisfied honestly.
      const unusable = await hashPassword(randomToken(32))
      owner = await User.create({
        email,
        displayName: String(input.ownerName || email.split('@')[0] || 'Owner').slice(0, 120),
        passwordHash: unusable,
        status: 'active',
      })
      createdUserId = String(owner._id)
    }

    membership = await Membership.create({
      organizationId: organization._id,
      userId: owner._id,
      role: 'owner',
      status: 'active',
      invitedBy: input.createdBy,
    })

    await Subscription.create({
      organizationId: organization._id,
      plan: input.plan || 'free',
      status: 'inactive',
      seats: 1,
    })

    const token = randomToken(48)
    invitation = await Invitation.create({
      organizationId: organization._id,
      email,
      role: 'owner',
      tokenHash: hashOpaqueToken(token),
      invitedBy: input.createdBy,
      expiresAt: new Date(Date.now() + 14 * 86_400_000),
    })

    return {
      organization,
      ownerUserId: String(owner._id),
      membershipId: String(membership._id),
      invitationToken: token,
      invitationExpiresAt: invitation.expiresAt,
      ownerExisted,
    }
  } catch (error) {
    // Unwind in reverse. Each delete is scoped so a failure here can never
    // remove something this call did not create.
    if (invitation?._id && organization?._id) {
      await Invitation.deleteOne({ _id: invitation._id, organizationId: organization._id }).catch(() => undefined)
    }
    if (organization?._id) {
      await Subscription.deleteOne({ organizationId: organization._id }).catch(() => undefined)
      await Membership.deleteMany({ organizationId: organization._id }).catch(() => undefined)
      await Organization.deleteOne({ _id: organization._id }).catch(() => undefined)
    }
    // Only a user this call created is removed. An attached pre-existing
    // account belongs to the platform, not to this provisioning attempt.
    if (createdUserId) await User.deleteOne({ _id: createdUserId }).catch(() => undefined)
    throw error
  }
}
