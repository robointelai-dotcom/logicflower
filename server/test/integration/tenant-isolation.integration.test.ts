import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Express } from 'express'
import request from 'supertest'
import mongoose, { Types } from 'mongoose'

/**
 * Cross-tenant isolation, asserted through the real mounted Express stack.
 *
 * The release previously claimed multi-tenant isolation on the strength of unit
 * tests of validation helpers. A helper that returns the right answer in
 * isolation proves nothing about whether every route actually calls it. These
 * tests drive real HTTP requests against real route handlers backed by a real
 * MongoDB, and assert that an authenticated member of organisation A cannot
 * read, mutate or enumerate anything belonging to organisation B.
 *
 * This suite requires MongoDB and Redis. It is excluded from the default unit
 * run and executed by `npm run test:integration`, which CI runs with service
 * containers. It fails rather than skips when INTEGRATION_REQUIRED=1, so a
 * missing dependency in CI cannot be mistaken for a pass.
 */

const REQUIRED = process.env.INTEGRATION_REQUIRED === '1'

let app: Express
let available = false
let unavailableReason = ''
let memoryServer: { stop: () => Promise<unknown> } | undefined

interface Tenant {
  organizationId: string
  userId: string
  cookies: string[]
  csrf: string
  connectionId: string
  workflowId: string
  batchJobId: string
  artifactId: string
  snapshotId: string
}

const tenants: Record<'alpha' | 'beta', Tenant> = {} as Record<'alpha' | 'beta', Tenant>

async function resolveMongoUri(): Promise<string> {
  if (process.env.MONGO_TEST_URI) return process.env.MONGO_TEST_URI
  const { MongoMemoryReplSet } = await import('mongodb-memory-server')
  // A replica set, not a standalone: the usage ledger requires transactions and
  // fails closed without them, so a standalone would exercise a different path
  // from production.
  const server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  memoryServer = server
  return server.getUri('logicflower-integration')
}

/** Seed one organisation with an owner and one record in each isolated collection. */
async function seedTenant(name: string): Promise<Tenant> {
  const Organization = (await import('../../src/models/Organization')).default
  const User = (await import('../../src/models/User')).default
  const Membership = (await import('../../src/models/Membership')).default
  const PlatformConnection = (await import('../../src/models/PlatformConnection')).default
  const Workflow = (await import('../../src/models/Workflow')).default
  const WorkflowVersion = (await import('../../src/models/WorkflowVersion')).default
  const BatchJob = (await import('../../src/models/BatchJob')).default
  const Artifact = (await import('../../src/models/Artifact')).default
  const WorkflowSnapshot = (await import('../../src/models/WorkflowSnapshot')).default
  const { hashPassword } = await import('../../src/security/password')
  const { encryptJson } = await import('../../src/security/encryption')

  const password = 'Integration-Test-Passw0rd!'
  const organization: any = await Organization.create({ name: `${name} org`, slug: `${name}-org-${Date.now()}` })
  const user: any = await User.create({
    email: `${name}-${Date.now()}@example.com`,
    passwordHash: await hashPassword(password),
    name: `${name} owner`,
    emailVerifiedAt: new Date(),
  })
  await Membership.create({ organizationId: organization._id, userId: user._id, role: 'owner', status: 'active' })

  const connectionId = new Types.ObjectId()
  await PlatformConnection.create({
    _id: connectionId,
    organizationId: organization._id,
    provider: 'ghl',
    name: `${name} connection`,
    status: 'active',
    encryptedCredentials: encryptJson({ accessToken: 'token' }, `connection:${organization._id}:${connectionId}`),
    grantedScopes: [],
    scopeSource: 'requested_not_confirmed',
    createdBy: user._id,
  })

  const workflow: any = await Workflow.create({ organizationId: organization._id, name: `${name} workflow`, status: 'draft', createdBy: user._id })
  await WorkflowVersion.create({ organizationId: organization._id, workflowId: workflow._id, version: 1, snapshot: { nodes: [], edges: [] } })

  const batch: any = await BatchJob.create({
    organizationId: organization._id, name: `${name} batch`, provider: 'generic',
    operation: 'local.deduplicate', status: 'draft', stats: { total: 0 }, correlationId: `${name}-corr`,
  })

  const artifact: any = await Artifact.create({
    organizationId: organization._id, kind: 'batch_failed_export', fileName: `${name}.csv`,
    contentType: 'text/csv', status: 'ready', storageKey: `${name}-key`, plaintextSize: 10,
    sha256: 'a'.repeat(64), encryptionIv: 'b'.repeat(24), encryptionTag: 'c'.repeat(24),
  })

  const snapshotId = new Types.ObjectId()
  await WorkflowSnapshot.create({
    _id: snapshotId, organizationId: organization._id, provider: 'ghl', connectionId,
    externalWorkflowId: `${name}-ext`, name: `${name} snapshot`, hash: 'd'.repeat(64),
    canonicalCiphertext: encryptJson({ nodes: [] }, `workflow-snapshot:${organization._id}:${snapshotId}`),
    capturedAt: new Date(),
  })

  const login = await request(app).post('/api/v1/auth/login').send({ email: user.email, password })
  expect(login.status).toBe(200)
  const cookies = ([] as string[]).concat((login.headers['set-cookie'] as unknown as string[]) || [])
  const csrf = (cookies.find((cookie) => cookie.startsWith('lf_csrf=')) || '').split(';')[0]!.split('=')[1] || ''

  const select = await request(app)
    .post(`/api/v1/organizations/${organization._id}/select`)
    .set('Cookie', cookies).set('X-CSRF-Token', decodeURIComponent(csrf))
    .set('Idempotency-Key', `select-${name}-${Date.now()}`)
    .send({})
  const merged = select.headers['set-cookie']
    ? cookies.concat(([] as string[]).concat(select.headers['set-cookie'] as unknown as string[]))
    : cookies

  return {
    organizationId: String(organization._id),
    userId: String(user._id),
    cookies: merged,
    csrf: decodeURIComponent(csrf),
    connectionId: String(connectionId),
    workflowId: String(workflow._id),
    batchJobId: String(batch._id),
    artifactId: String(artifact._id),
    snapshotId: String(snapshotId),
  }
}

beforeAll(async () => {
  try {
    process.env.NODE_ENV = 'test'
    process.env.JWT_ACCESS_SECRET ||= 'a'.repeat(48)
    process.env.JWT_REFRESH_SECRET ||= 'b'.repeat(48)
    process.env.ENCRYPTION_KEY ||= '0'.repeat(64)
    process.env.MONGO_URI = await resolveMongoUri()
    process.env.REDIS_URL ||= 'redis://127.0.0.1:6379'
    await mongoose.connect(process.env.MONGO_URI)
    const { createApp } = await import('../../src/app')
    app = createApp()
    tenants.alpha = await seedTenant('alpha')
    tenants.beta = await seedTenant('beta')
    available = true
  } catch (error: any) {
    unavailableReason = String(error?.message || error).slice(0, 300)
    if (REQUIRED) throw error
  }
}, 180_000)

afterAll(async () => {
  await mongoose.connection?.close().catch(() => undefined)
  await memoryServer?.stop().catch(() => undefined)
})

function guard() {
  if (!available) {
    if (REQUIRED) throw new Error(`Integration dependencies unavailable: ${unavailableReason}`)
    // Not silently green: the reason is printed on every run.
    console.warn(`[tenant-isolation] SKIPPED — MongoDB/Redis unavailable: ${unavailableReason}`)
  }
  return available
}

/** Every read path that accepts a tenant-owned identifier in the URL. */
function crossTenantReads(victim: Tenant): Array<{ label: string; path: string }> {
  return [
    { label: 'connection detail', path: `/api/v1/connections/${victim.connectionId}` },
    { label: 'connection capabilities', path: `/api/v1/connections/${victim.connectionId}/capabilities` },
    { label: 'workflow detail', path: `/api/v1/workflows/${victim.workflowId}` },
    { label: 'workflow versions', path: `/api/v1/workflows/${victim.workflowId}/versions` },
    { label: 'batch detail', path: `/api/v1/batches/${victim.batchJobId}` },
    { label: 'artifact download', path: `/api/v1/artifacts/${victim.artifactId}/download` },
    { label: 'vault snapshot export', path: `/api/v1/vault/snapshots/${victim.snapshotId}/export` },
    { label: 'organization detail', path: `/api/v1/organizations/${victim.organizationId}` },
    { label: 'organization members', path: `/api/v1/organizations/${victim.organizationId}/members` },
  ]
}

/** Every mutation path that accepts a tenant-owned identifier in the URL. */
function crossTenantMutations(victim: Tenant): Array<{ label: string; method: 'post' | 'patch' | 'delete'; path: string; body?: unknown }> {
  return [
    { label: 'delete connection', method: 'delete', path: `/api/v1/connections/${victim.connectionId}` },
    { label: 'probe capability', method: 'post', path: `/api/v1/connections/${victim.connectionId}/capabilities/workflow.inventory/probe`, body: {} },
    { label: 'publish workflow', method: 'post', path: `/api/v1/workflows/${victim.workflowId}/publish`, body: {} },
    { label: 'approve batch', method: 'post', path: `/api/v1/batches/${victim.batchJobId}/approve`, body: { previewHash: 'x'.repeat(64) } },
    { label: 'snapshot connection', method: 'post', path: '/api/v1/vault/snapshots', body: { connectionId: victim.connectionId } },
  ]
}

describe('cross-tenant isolation', () => {
  it('refuses every cross-tenant read', async () => {
    if (!guard()) return
    const attacker = tenants.alpha
    const victim = tenants.beta
    for (const target of crossTenantReads(victim)) {
      const response = await request(app).get(target.path).set('Cookie', attacker.cookies)
      expect(
        [403, 404].includes(response.status),
        `${target.label} returned ${response.status}; a cross-tenant read must be 403 or 404`,
      ).toBe(true)
      // A 404 that still leaks the record in the body is not isolation.
      const body = JSON.stringify(response.body || {})
      expect(body).not.toContain(victim.organizationId)
      expect(body).not.toContain('beta')
    }
  })

  it('refuses every cross-tenant mutation', async () => {
    if (!guard()) return
    const attacker = tenants.alpha
    const victim = tenants.beta
    for (const target of crossTenantMutations(victim)) {
      const response = await (request(app) as any)[target.method](target.path)
        .set('Cookie', attacker.cookies)
        .set('X-CSRF-Token', attacker.csrf)
        .set('Idempotency-Key', `attack-${target.label.replace(/\s+/g, '-')}-${Date.now()}`)
        .send(target.body || {})
      expect(
        [400, 403, 404, 409, 422].includes(response.status),
        `${target.label} returned ${response.status}; a cross-tenant mutation must never succeed`,
      ).toBe(true)
      expect([200, 201, 202, 204]).not.toContain(response.status)
    }
  })

  it('leaves the victim tenant unmodified after an attack sequence', async () => {
    if (!guard()) return
    const PlatformConnection = (await import('../../src/models/PlatformConnection')).default
    const Workflow = (await import('../../src/models/Workflow')).default
    const connection: any = await PlatformConnection.findById(tenants.beta.connectionId).lean()
    const workflow: any = await Workflow.findById(tenants.beta.workflowId).lean()
    expect(connection?.status).toBe('active')
    expect(workflow?.status).toBe('draft')
  })

  it('scopes every list endpoint to the caller organisation', async () => {
    if (!guard()) return
    const lists = ['/api/v1/connections', '/api/v1/workflows', '/api/v1/batches', '/api/v1/vault/snapshots']
    for (const path of lists) {
      const response = await request(app).get(path).set('Cookie', tenants.alpha.cookies)
      expect(response.status).toBe(200)
      const body = JSON.stringify(response.body || {})
      expect(body, `${path} leaked a record belonging to another organisation`).not.toContain(tenants.beta.connectionId)
      expect(body).not.toContain(tenants.beta.workflowId)
      expect(body).not.toContain(tenants.beta.batchJobId)
      expect(body).not.toContain(tenants.beta.snapshotId)
    }
  })

  it('rejects a forged organisation header on an authenticated session', async () => {
    if (!guard()) return
    const response = await request(app)
      .get('/api/v1/connections')
      .set('Cookie', tenants.alpha.cookies)
      .set('X-Organization-Id', tenants.beta.organizationId)
    if (response.status === 200) {
      const body = JSON.stringify(response.body || {})
      expect(body).not.toContain(tenants.beta.connectionId)
    } else {
      expect([400, 403]).toContain(response.status)
    }
  })

  it('rejects an unauthenticated request to every tenant-scoped path', async () => {
    if (!guard()) return
    for (const target of crossTenantReads(tenants.beta)) {
      const response = await request(app).get(target.path)
      expect(response.status, `${target.label} was reachable without a session`).toBe(401)
    }
  })
})
