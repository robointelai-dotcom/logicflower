import axios from 'axios'
import nodemailer from 'nodemailer'
import { env } from '../../env'
import { renderTemplate } from '../templating'
import { DispatchError, type ChannelDispatcher, type DispatchRequest, type DispatchResult } from './ports'
import {
  resolveIdentityForStep,
  type ResolvedIdentity,
  type SendgridCredentials,
  type SmtpCredentials,
  type TwilioCredentials,
} from './messagingIdentity'

/**
 * Channel dispatch.
 *
 * Provider verification status, stated plainly because it governs what an
 * operator may rely on:
 *
 *  - SMTP is implemented against nodemailer, a dependency already in this
 *    repository, and involves no guessed third-party contract.
 *
 *  - SendGrid and Twilio are implemented against their published HTTP
 *    contracts, written from working knowledge rather than from documentation
 *    open in front of the author. They are therefore treated as UNVERIFIED
 *    until a live probe against a real account succeeds, exactly as the
 *    capability model treats an unconfirmed scope. Confirm the request shape,
 *    the error codes and the current pricing model against the provider's
 *    current documentation before enabling either in production.
 *
 *  - WhatsApp is NOT implemented. The interface, the template model and the
 *    24-hour session-window state are here; the provider call deliberately
 *    refuses. See `whatsappDispatcher` for what is needed to complete it.
 */

/** Providers whose request contract has not been confirmed against a live account. */
export const UNVERIFIED_PROVIDERS: ReadonlySet<string> = new Set(['sendgrid', 'twilio'])

const HTTP_TIMEOUT_MS = 20_000

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] || character))
}

export interface RenderContext {
  contact: Record<string, unknown>
  unsubscribeUrl: string
}

/** Public, unauthenticated one-click unsubscribe target for a specific send. */
export function unsubscribeUrlFor(trackingToken: string): string {
  const url = new URL('/api/v1/messaging/unsubscribe', env.API_URL)
  url.searchParams.set('t', trackingToken)
  return url.toString()
}

export function buildRenderContext(request: DispatchRequest): RenderContext {
  return {
    contact: {
      firstName: request.contact.firstName || '',
      lastName: request.contact.lastName || '',
      name: request.contact.name || [request.contact.firstName, request.contact.lastName].filter(Boolean).join(' '),
      email: request.contact.email || '',
      phone: request.contact.phone || '',
      ...request.contact.fields,
    },
    unsubscribeUrl: unsubscribeUrlFor(request.trackingToken),
  }
}

function render(template: string | undefined, context: RenderContext): string {
  return renderTemplate(String(template ?? ''), context as unknown as Record<string, unknown>)
}

/**
 * Classify a transport failure.
 *
 * The distinction that matters is not "did it fail" but "can we prove nothing
 * was sent". A refused connection proves it; a timeout after the request was
 * written does not, and must never be retried automatically.
 */
function classifyHttpError(error: any, provider: string): DispatchError {
  const status = Number(error?.response?.status || 0)
  const code = String(error?.code || '')

  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new DispatchError({ code: `${provider.toUpperCase()}_CONNECT_FAILED`, message: 'The provider could not be reached', retryable: true })
  }
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || !status) {
    // The request may have been received and acted on. Unknown, not failed.
    return new DispatchError({ code: `${provider.toUpperCase()}_TIMEOUT`, message: 'The provider did not respond; the outcome of this send cannot be established', outcomeUnknown: true })
  }
  if (status === 429 || status >= 500) {
    return new DispatchError({ code: `${provider.toUpperCase()}_UNAVAILABLE`, message: `The provider returned ${status}`, retryable: true })
  }
  // A 4xx is the provider rejecting the request itself. Retrying an identical
  // rejected request just burns quota.
  return new DispatchError({ code: `${provider.toUpperCase()}_REJECTED`, message: `The provider rejected the request with ${status}`, retryable: false })
}

async function sendViaSmtp(identity: ResolvedIdentity, request: DispatchRequest, context: RenderContext): Promise<DispatchResult> {
  const credentials = identity.credentials as unknown as SmtpCredentials
  const transporter = nodemailer.createTransport({
    host: credentials.host,
    port: credentials.port,
    secure: Boolean(credentials.secure),
    auth: credentials.user ? { user: credentials.user, pass: credentials.password || '' } : undefined,
    connectionTimeout: HTTP_TIMEOUT_MS,
    greetingTimeout: HTTP_TIMEOUT_MS,
    socketTimeout: HTTP_TIMEOUT_MS,
  })

  const body = render(request.step.bodyTemplate, context)
  const unsubscribeUrl = context.unsubscribeUrl
  try {
    const result = await transporter.sendMail({
      from: identity.fromName ? `${identity.fromName} <${identity.fromAddress}>` : identity.fromAddress,
      replyTo: identity.replyToAddress || undefined,
      to: request.recipient,
      subject: render(request.step.subjectTemplate, context),
      text: `${body}\n\n---\nUnsubscribe: ${unsubscribeUrl}`,
      html: `${escapeHtml(body).replace(/\n/g, '<br>')}<hr><p><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p>`,
      // RFC 8058 one-click unsubscribe. Gmail and Yahoo require this for bulk
      // senders, and its absence is a deliverability problem, not a nicety.
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    })
    return { provider: 'smtp', providerMessageId: String((result as any)?.messageId || '') || undefined }
  } catch (error: any) {
    const code = String(error?.code || '')
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ETIMEDOUT') {
      throw new DispatchError({ code: 'SMTP_CONNECT_FAILED', message: 'The SMTP server could not be reached', retryable: true })
    }
    if (Number(error?.responseCode) >= 500) {
      throw new DispatchError({ code: 'SMTP_REJECTED', message: 'The SMTP server permanently rejected the message', retryable: false })
    }
    if (Number(error?.responseCode) >= 400) {
      throw new DispatchError({ code: 'SMTP_DEFERRED', message: 'The SMTP server temporarily rejected the message', retryable: true })
    }
    throw new DispatchError({ code: 'SMTP_UNKNOWN', message: 'The SMTP send did not complete and its outcome cannot be established', outcomeUnknown: true })
  } finally {
    transporter.close()
  }
}

async function sendViaSendgrid(identity: ResolvedIdentity, request: DispatchRequest, context: RenderContext): Promise<DispatchResult> {
  const credentials = identity.credentials as unknown as SendgridCredentials
  const body = render(request.step.bodyTemplate, context)
  try {
    const response = await axios.post('https://api.sendgrid.com/v3/mail/send', {
      personalizations: [{ to: [{ email: request.recipient }] }],
      from: { email: identity.fromAddress, ...(identity.fromName ? { name: identity.fromName } : {}) },
      ...(identity.replyToAddress ? { reply_to: { email: identity.replyToAddress } } : {}),
      subject: render(request.step.subjectTemplate, context),
      content: [
        { type: 'text/plain', value: `${body}\n\n---\nUnsubscribe: ${context.unsubscribeUrl}` },
        { type: 'text/html', value: `${escapeHtml(body).replace(/\n/g, '<br>')}<hr><p><a href="${escapeHtml(context.unsubscribeUrl)}">Unsubscribe</a></p>` },
      ],
      headers: {
        'List-Unsubscribe': `<${context.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      custom_args: { sendRecordId: request.sendRecordId, organizationId: request.organizationId },
    }, {
      timeout: HTTP_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' },
      validateStatus: (status) => status >= 200 && status < 300,
    })
    return { provider: 'sendgrid', providerMessageId: String(response.headers?.['x-message-id'] || '') || undefined }
  } catch (error: any) {
    throw classifyHttpError(error, 'sendgrid')
  }
}

async function sendViaTwilio(identity: ResolvedIdentity, request: DispatchRequest, context: RenderContext): Promise<DispatchResult> {
  const credentials = identity.credentials as unknown as TwilioCredentials
  const parameters = new URLSearchParams()
  parameters.set('To', request.recipient)
  if (credentials.messagingServiceSid) parameters.set('MessagingServiceSid', credentials.messagingServiceSid)
  else parameters.set('From', String(identity.fromNumber || ''))
  parameters.set('Body', render(request.step.bodyTemplate, context))
  parameters.set('StatusCallback', new URL('/api/v1/messaging/callbacks/twilio', env.API_URL).toString())

  try {
    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/Messages.json`,
      parameters.toString(),
      {
        timeout: HTTP_TIMEOUT_MS,
        auth: { username: credentials.accountSid, password: credentials.authToken },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: (status) => status >= 200 && status < 300,
      },
    )
    return { provider: 'twilio', providerMessageId: String(response.data?.sid || '') || undefined }
  } catch (error: any) {
    throw classifyHttpError(error, 'twilio')
  }
}

/**
 * WhatsApp: interface only, provider call deliberately unimplemented.
 *
 * This follows the same discipline as `contact.merge` in
 * `services/dedupe/mergeExecutor.ts`: the surrounding machinery is real, and
 * the one operation whose contract has not been verified against a live account
 * refuses rather than guesses. For WhatsApp specifically, a wrong
 * implementation does not merely fail — sending outside the customer service
 * window, or with an unapproved template, risks the business account being
 * restricted or suspended.
 *
 * To complete this, the following are needed and none can be substituted by
 * inference:
 *
 *  1. Which BSP the client is onboarding through — Meta Cloud API direct,
 *     Twilio, 360dialog, Gupshup and others differ in endpoint, payload,
 *     webhook format and error taxonomy.
 *  2. The current Cloud API (or BSP) messages endpoint contract and version,
 *     including the exact template component structure for the templates the
 *     client has had approved.
 *  3. The current per-conversation pricing categories, since these determine
 *     what a sequence step actually costs and whether a step should be sent at
 *     all.
 *  4. Confirmation of the client's Meta Business verification and template
 *     approval status, without which every send is rejected regardless of code.
 */
export const WHATSAPP_UNIMPLEMENTED_REASON = 'WhatsApp sending is not implemented. The provider contract has not been verified against a live account, and guessing it risks account suspension rather than a failed send.'

/**
 * The 24-hour customer service window.
 *
 * Outside it, only an approved template may be sent; inside it, free-form
 * messages are permitted. The state is modelled here so the rest of the engine
 * can reason about it, and so the eventual provider implementation has one
 * place to consult rather than re-deriving the rule at each call site.
 */
export const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60 * 1_000

export type WhatsappSendMode = 'template_required' | 'free_form_permitted'

export function whatsappSessionMode(lastInboundAt: Date | null | undefined, now: Date): WhatsappSendMode {
  if (!lastInboundAt) return 'template_required'
  return now.getTime() - lastInboundAt.getTime() < WHATSAPP_SESSION_WINDOW_MS ? 'free_form_permitted' : 'template_required'
}

async function sendViaWhatsapp(): Promise<DispatchResult> {
  throw new DispatchError({
    code: 'WHATSAPP_NOT_IMPLEMENTED',
    message: WHATSAPP_UNIMPLEMENTED_REASON,
    retryable: false,
  })
}

export class ProviderChannelDispatcher implements ChannelDispatcher {
  async send(request: DispatchRequest): Promise<DispatchResult> {
    if (request.channel === 'whatsapp') return sendViaWhatsapp()

    const identity = await resolveIdentityForStep({
      organizationId: request.organizationId,
      channel: request.channel,
      messagingIdentityId: request.step.messagingIdentityId,
    })
    const context = buildRenderContext(request)

    if (request.channel === 'email') {
      if (identity.provider === 'smtp') return sendViaSmtp(identity, request, context)
      if (identity.provider === 'sendgrid') return sendViaSendgrid(identity, request, context)
    }
    if (request.channel === 'sms' && identity.provider === 'twilio') {
      return sendViaTwilio(identity, request, context)
    }

    throw new DispatchError({
      code: 'CHANNEL_PROVIDER_UNSUPPORTED',
      message: `Provider "${identity.provider}" is not a supported sender for the ${request.channel} channel`,
      retryable: false,
    })
  }
}

export const providerChannelDispatcher = new ProviderChannelDispatcher()
