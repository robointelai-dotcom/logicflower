import { z } from 'zod'
import MessagingIdentity from '../../models/MessagingIdentity'
import { decryptString, encryptString } from '../../security/encryption'
import { HttpError, problemType } from '../../http/problem'
import { isPrivateOrReservedIp } from '../ssrfGuard'
import { promises as dns } from 'dns'
import type { Channel } from './ports'

/**
 * Sending identities: whose credentials a message goes out under.
 *
 * The commercial premise of the product is that the operator sends, not the
 * customer's CRM — routing a send back through GoHighLevel reintroduces the
 * per-action fee this system exists to remove. So credentials are per
 * organisation, encrypted at rest with a per-record AAD, and never read from
 * the environment. The environment SMTP settings remain in use for platform
 * mail (password resets, invitations) and are deliberately not reachable from
 * here: a tenant must not be able to send campaign mail as the platform.
 */

const smtpCredentialsSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  secure: z.boolean().default(false),
  user: z.string().max(320).optional(),
  password: z.string().max(1_024).optional(),
})

const sendgridCredentialsSchema = z.object({
  apiKey: z.string().trim().min(10).max(512),
})

const twilioCredentialsSchema = z.object({
  accountSid: z.string().trim().min(10).max(128),
  authToken: z.string().trim().min(10).max(512),
  /** Optional Messaging Service SID, used in place of a single From number. */
  messagingServiceSid: z.string().trim().max(128).optional(),
})

const whatsappCredentialsSchema = z.object({
  phoneNumberId: z.string().trim().min(1).max(128),
  accessToken: z.string().trim().min(10).max(2_048),
  businessAccountId: z.string().trim().max(128).optional(),
})

export const credentialSchemas = {
  smtp: smtpCredentialsSchema,
  sendgrid: sendgridCredentialsSchema,
  twilio: twilioCredentialsSchema,
  whatsapp_cloud: whatsappCredentialsSchema,
} as const

export type MessagingProvider = keyof typeof credentialSchemas

export type SmtpCredentials = z.infer<typeof smtpCredentialsSchema>
export type SendgridCredentials = z.infer<typeof sendgridCredentialsSchema>
export type TwilioCredentials = z.infer<typeof twilioCredentialsSchema>
export type WhatsappCredentials = z.infer<typeof whatsappCredentialsSchema>

export interface ResolvedIdentity {
  id: string
  organizationId: string
  channel: Channel
  provider: MessagingProvider
  fromAddress?: string
  fromName?: string
  replyToAddress?: string
  fromNumber?: string
  credentials: Record<string, unknown>
}

/** AAD binds a ciphertext to the exact record it belongs to. */
export function identityAad(organizationId: string, identityId: string): string {
  return `messaging-identity:${organizationId}:${identityId}:credentials`
}

export function validateCredentials(provider: MessagingProvider, input: unknown): Record<string, unknown> {
  const schema = credentialSchemas[provider]
  if (!schema) throw new HttpError(400, 'Unsupported provider', `No credential schema is defined for provider "${provider}"`, problemType('messaging-provider-unsupported'))
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new HttpError(400, 'Invalid credentials', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), problemType('messaging-credentials-invalid'))
  }
  return parsed.data as Record<string, unknown>
}

/**
 * Reject an SMTP host that resolves into private or reserved address space.
 *
 * An operator-supplied hostname reaching a socket is an SSRF sink, and an SMTP
 * connection is as good a probe of an internal network as an HTTP request. The
 * existing outbound allowlist guards HTTP destinations; this is the equivalent
 * check for the mail path, reusing the same address classifier so the two
 * cannot drift apart.
 */
export async function assertPublicSmtpHost(host: string): Promise<void> {
  const hostname = String(host || '').trim().toLowerCase()
  if (!hostname) throw new HttpError(400, 'Invalid SMTP host', 'An SMTP host is required', problemType('smtp-host-invalid'))
  let addresses: string[]
  try {
    const resolved = await dns.lookup(hostname, { all: true })
    addresses = resolved.map((entry) => entry.address)
  } catch {
    throw new HttpError(400, 'Invalid SMTP host', 'The SMTP host could not be resolved', problemType('smtp-host-invalid'))
  }
  if (!addresses.length || addresses.some((address) => isPrivateOrReservedIp(address))) {
    throw new HttpError(400, 'Invalid SMTP host', 'The SMTP host resolves to a private or reserved address and cannot be used', problemType('smtp-host-invalid'))
  }
}

export async function storeIdentityCredentials(input: {
  organizationId: string
  identityId: string
  provider: MessagingProvider
  credentials: unknown
}): Promise<void> {
  const validated = validateCredentials(input.provider, input.credentials)
  if (input.provider === 'smtp') await assertPublicSmtpHost(String((validated as SmtpCredentials).host))
  const ciphertext = encryptString(JSON.stringify(validated), identityAad(input.organizationId, input.identityId))
  await MessagingIdentity.updateOne(
    { _id: input.identityId, organizationId: input.organizationId },
    { $set: { credentialsCiphertext: ciphertext } },
  )
}

/**
 * Load the identity a step should send under.
 *
 * A step may pin an identity; otherwise the organisation's default for that
 * channel is used. Refusing when neither exists is deliberate — silently
 * falling back to platform SMTP would send a customer's marketing mail from the
 * platform's domain and burn its sending reputation.
 */
export async function resolveIdentityForStep(input: {
  organizationId: string
  channel: Channel
  messagingIdentityId?: string | null
}): Promise<ResolvedIdentity> {
  // The organisation predicate is set unconditionally rather than duplicated
  // into both branches of a ternary: it is then impossible to add a third
  // branch that forgets it, and the static tenant guard can see it.
  const query: Record<string, unknown> = { channel: input.channel, status: 'active' }
  query.organizationId = input.organizationId
  if (input.messagingIdentityId) query._id = input.messagingIdentityId
  else query.isDefault = true

  const identity: any = await MessagingIdentity.findOne(query).select('+credentialsCiphertext').lean()
  if (!identity) {
    throw new HttpError(
      409,
      'No sending identity',
      input.messagingIdentityId
        ? 'The sending identity pinned to this step is missing or disabled'
        : `No default ${input.channel} sending identity is configured for this organisation`,
      problemType('messaging-identity-missing'),
    )
  }
  if (!identity.credentialsCiphertext) {
    throw new HttpError(409, 'Sending identity incomplete', 'This sending identity has no stored credentials', problemType('messaging-identity-missing'))
  }

  let credentials: Record<string, unknown>
  try {
    credentials = JSON.parse(decryptString(identity.credentialsCiphertext, identityAad(input.organizationId, String(identity._id))))
  } catch {
    // A ciphertext that will not open under its own AAD is either corrupt or
    // belongs to another record. Both are refusals, never a fallback.
    throw new HttpError(409, 'Sending identity unreadable', 'Stored credentials for this sending identity could not be decrypted', problemType('messaging-identity-unreadable'))
  }

  return {
    id: String(identity._id),
    organizationId: input.organizationId,
    channel: identity.channel,
    provider: identity.provider,
    fromAddress: identity.fromAddress || undefined,
    fromName: identity.fromName || undefined,
    replyToAddress: identity.replyToAddress || undefined,
    fromNumber: identity.fromNumber || undefined,
    credentials,
  }
}

/**
 * SPF, DKIM and DMARC guidance for an operator's sending domain.
 *
 * Returned as instructions and observations, never as a compliance verdict. The
 * product cannot know whether a receiving provider will accept mail, and saying
 * "your domain is configured correctly" when a DNS record has propagated but a
 * DKIM key does not match is worse than saying nothing.
 */
export function domainAuthGuidance(fromAddress: string): { domain: string; requirements: string[]; note: string } {
  const domain = String(fromAddress || '').split('@')[1] || ''
  return {
    domain,
    requirements: [
      `SPF: publish a TXT record on ${domain || 'your sending domain'} authorising your provider's sending hosts, and keep the record within the 10 DNS-lookup limit.`,
      'DKIM: publish the selector and public key your provider issues, and confirm the provider signs with the matching private key.',
      `DMARC: publish _dmarc.${domain || 'yourdomain'} with a policy and an aggregate report address. Start at p=none and tighten once reports are clean.`,
      'Alignment: the visible From domain must align with the SPF or DKIM domain, or DMARC fails even when both records exist.',
    ],
    note: 'These records are checked and recorded, not certified. Deliverability depends on receiving providers and on sending reputation, neither of which this platform controls.',
  }
}
