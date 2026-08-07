import axios, { type AxiosInstance } from 'axios'
import { env } from '../../env'
import { HttpError, problemType } from '../../http/problem'
import pino from '../../logger'

/**
 * Client for a self-hosted trypost instance.
 *
 * ARCHITECTURE, AND WHAT "INTEGRATED" HONESTLY MEANS HERE
 *
 * trypost is a separate application: PHP/Laravel over a relational database,
 * running as its own service. This platform is Node over MongoDB. They are
 * integrated at the HTTP boundary and nowhere else.
 *
 * That has a consequence worth stating rather than discovering: **there is no
 * shared database and no cross-system query.** Nothing can join a Contact to a
 * social post. Where the two need to appear unified — a post showing on a
 * contact's timeline — that record is written into THIS database by THIS code,
 * referencing trypost's identifier as an opaque string. The unified experience
 * is assembled in the application layer, deliberately, and it is real for the
 * user even though the storage is not shared.
 *
 * ON LICENSING
 *
 * trypost is AGPL-3.0-only. Calling its public REST API across a process
 * boundary is ordinary integration and does not make this codebase derivative.
 * Modifying trypost — including rebranding it — produces changes that are
 * themselves AGPL and must be offered to anyone who uses them over a network.
 * Nothing in this file copies trypost code; it speaks to its documented API.
 */

export interface TrypostPost {
  id: string
  status: string
  scheduledFor?: string | null
  platforms?: Array<{ platform: string; status: string; url?: string | null; error?: string | null }>
}

export interface TrypostSocialAccount {
  id: string
  platform: string
  name: string
  status: string
}

export class TrypostUnavailableError extends Error {
  readonly retryable: boolean
  constructor(message: string, retryable = true) {
    super(message)
    this.name = 'TrypostUnavailableError'
    this.retryable = retryable
  }
}

export function trypostConfigured(): boolean {
  return Boolean(env.TRYPOST_BASE_URL && env.TRYPOST_ADMIN_API_KEY)
}

function assertConfigured(): void {
  if (!trypostConfigured()) {
    throw new HttpError(
      503,
      'Social publishing is not configured',
      'No trypost instance is configured. Set TRYPOST_BASE_URL and TRYPOST_ADMIN_API_KEY, or leave social publishing disabled.',
      problemType('social-backend-unconfigured'),
    )
  }
}

/**
 * One HTTP client per workspace token.
 *
 * trypost scopes API keys to a workspace, and a workspace maps one-to-one to an
 * organisation here. Passing the wrong key is therefore a cross-tenant write,
 * so the key is never defaulted and never cached globally — it is resolved per
 * call from the organisation's own stored credential.
 */
function clientFor(apiKey: string): AxiosInstance {
  assertConfigured()
  return axios.create({
    baseURL: `${String(env.TRYPOST_BASE_URL).replace(/\/$/, '')}/api`,
    timeout: env.TRYPOST_TIMEOUT_MS,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    // Status handling is explicit below so a 4xx is classified rather than
    // thrown as a generic axios error.
    validateStatus: () => true,
  })
}

interface CallResult<T> { status: number; data: T }

async function call<T>(apiKey: string, method: 'get' | 'post' | 'put' | 'delete', path: string, body?: unknown): Promise<CallResult<T>> {
  let response
  try {
    response = await clientFor(apiKey).request({ method, url: path, ...(body ? { data: body } : {}) })
  } catch (error: any) {
    const code = String(error?.code || '')
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      throw new TrypostUnavailableError('The social publishing service could not be reached.', true)
    }
    // A timeout after the request was written may have been acted on. For a
    // social post that means it may already be public, so this is never
    // reported as a clean failure.
    throw new TrypostUnavailableError('The social publishing service did not respond; the outcome of this request cannot be established.', false)
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(502, 'Social publishing rejected the request', 'The configured credential was refused by the publishing service.', problemType('social-backend-unauthorized'))
  }
  if (response.status === 429 || response.status >= 500) {
    throw new TrypostUnavailableError(`The social publishing service returned ${response.status}.`, true)
  }
  return { status: response.status, data: response.data as T }
}

/* ------------------------------------------------------------- operations */

export async function fetchWorkspace(apiKey: string): Promise<{ id: string; name: string } | null> {
  const result = await call<any>(apiKey, 'get', '/workspace')
  if (result.status >= 400) return null
  const workspace = result.data?.data ?? result.data
  return workspace ? { id: String(workspace.id ?? workspace.uuid ?? ''), name: String(workspace.name ?? '') } : null
}

export async function listSocialAccounts(apiKey: string): Promise<TrypostSocialAccount[]> {
  const result = await call<any>(apiKey, 'get', '/social-accounts')
  if (result.status >= 400) return []
  const rows = Array.isArray(result.data?.data) ? result.data.data : Array.isArray(result.data) ? result.data : []
  return rows.map((row: any) => ({
    id: String(row.id ?? row.uuid ?? ''),
    platform: String(row.platform ?? ''),
    name: String(row.name ?? row.display_name ?? row.username ?? ''),
    status: String(row.status ?? 'unknown'),
  })).filter((account: TrypostSocialAccount) => account.id && account.platform)
}

export async function createPost(apiKey: string, input: {
  content: string
  socialAccountIds: string[]
  scheduledFor?: Date | null
  mediaUrls?: string[]
}): Promise<TrypostPost> {
  const result = await call<any>(apiKey, 'post', '/posts', {
    content: input.content,
    social_accounts: input.socialAccountIds,
    ...(input.scheduledFor ? { scheduled_at: input.scheduledFor.toISOString() } : {}),
  })
  if (result.status >= 400) {
    throw new HttpError(
      422,
      'Social post rejected',
      typeof result.data?.message === 'string' ? result.data.message : 'The publishing service rejected the post.',
      problemType('social-post-rejected'),
    )
  }
  const post = result.data?.data ?? result.data
  const postId = String(post?.id ?? post?.uuid ?? '')
  if (!postId) throw new TrypostUnavailableError('The publishing service accepted the post but returned no identifier.', false)

  // Media is attached after creation, by URL, so bytes are never proxied
  // through this process. A failure here leaves a post with no image rather
  // than losing the post.
  for (const url of (input.mediaUrls || []).slice(0, 10)) {
    try {
      await call(apiKey, 'post', `/posts/${encodeURIComponent(postId)}/media/from-url`, { url })
    } catch (error) {
      pino.warn({ err: error, postId }, 'social media attachment failed; the post was created without it')
    }
  }
  return normalisePost(post, postId)
}

export async function fetchPost(apiKey: string, postId: string): Promise<TrypostPost | null> {
  const result = await call<any>(apiKey, 'get', `/posts/${encodeURIComponent(postId)}`)
  if (result.status === 404) return null
  if (result.status >= 400) throw new TrypostUnavailableError(`The publishing service returned ${result.status} for a post lookup.`, true)
  const post = result.data?.data ?? result.data
  return post ? normalisePost(post, String(post.id ?? postId)) : null
}

export async function deletePost(apiKey: string, postId: string): Promise<boolean> {
  const result = await call(apiKey, 'delete', `/posts/${encodeURIComponent(postId)}`)
  return result.status < 400
}

function normalisePost(post: any, fallbackId: string): TrypostPost {
  const platforms = Array.isArray(post?.platforms) ? post.platforms : Array.isArray(post?.post_platforms) ? post.post_platforms : []
  return {
    id: String(post?.id ?? fallbackId),
    status: String(post?.status ?? 'unknown'),
    scheduledFor: post?.scheduled_at ?? post?.scheduled_for ?? null,
    platforms: platforms.map((entry: any) => ({
      platform: String(entry?.platform ?? ''),
      status: String(entry?.status ?? 'unknown'),
      url: entry?.url ?? entry?.permalink ?? null,
      error: entry?.error ?? entry?.error_message ?? null,
    })),
  }
}

/**
 * Map a trypost per-platform status onto this system's target status.
 *
 * Kept as an explicit, total mapping rather than a passthrough. An unrecognised
 * status resolves to `publishing` — not to `published` — because treating an
 * unknown state as success is how a failed post is reported as live.
 */
export function mapPlatformStatus(status: string): 'pending' | 'publishing' | 'published' | 'failed' {
  switch (String(status || '').toLowerCase()) {
    case 'published':
    case 'posted':
    case 'success':
      return 'published'
    case 'failed':
    case 'error':
      return 'failed'
    case 'draft':
    case 'scheduled':
    case 'pending':
    case 'queued':
      return 'pending'
    default:
      return 'publishing'
  }
}
