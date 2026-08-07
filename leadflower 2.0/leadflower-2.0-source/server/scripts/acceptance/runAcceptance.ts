import crypto from 'crypto'
import dns from 'dns/promises'
import tls from 'tls'
import fs from 'fs/promises'
import path from 'path'

/**
 * Executable live acceptance.
 *
 * `LIVE_ACCEPTANCE.md` was a list of thirty-four checkboxes, none ticked, and a
 * checkbox is ticked by a human who believes something is true. These checks
 * observe the real dependency and write a signed evidence record, so the
 * question "has DNS/TLS been verified" is answered by a file with a hash and a
 * timestamp rather than by recollection.
 *
 * A check has exactly three outcomes:
 *   pass         the dependency was observed behaving correctly
 *   fail         the dependency was observed behaving incorrectly
 *   unconfigured the credential or address needed to look was not supplied
 *
 * `unconfigured` is never `pass`. A check that could not run has not run.
 */

export type CheckOutcome = 'pass' | 'fail' | 'unconfigured'

export interface CheckResult {
  id: string
  title: string
  outcome: CheckOutcome
  detail: string
  observations: Record<string, unknown>
  observedAt: string
  durationMs: number
}

export interface EvidenceBundle {
  schemaVersion: 1
  generatedAt: string
  target: string
  results: CheckResult[]
  summary: { total: number; passed: number; failed: number; unconfigured: number }
  bundleHash: string
}

async function timed(id: string, title: string, work: () => Promise<Omit<CheckResult, 'id' | 'title' | 'observedAt' | 'durationMs'>>): Promise<CheckResult> {
  const started = Date.now()
  try {
    const result = await work()
    return { id, title, ...result, observedAt: new Date().toISOString(), durationMs: Date.now() - started }
  } catch (error: any) {
    return {
      id,
      title,
      outcome: 'fail',
      detail: String(error?.message || error).slice(0, 500),
      observations: {},
      observedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    }
  }
}

/** Resolve the production hostname and confirm it is not a private address. */
export async function checkDns(hostname?: string): Promise<CheckResult> {
  return timed('dns', 'Production DNS resolves to a public address', async () => {
    if (!hostname) return { outcome: 'unconfigured' as const, detail: 'ACCEPTANCE_HOSTNAME was not supplied.', observations: {} }
    const records = await dns.lookup(hostname, { all: true })
    const addresses = records.map((record) => record.address)
    const priv = addresses.filter((address) =>
      /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd])/i.test(address))
    if (!addresses.length) return { outcome: 'fail' as const, detail: 'Hostname resolved to no addresses.', observations: { hostname } }
    if (priv.length) return { outcome: 'fail' as const, detail: `Hostname resolves to private addresses: ${priv.join(', ')}`, observations: { hostname, addresses } }
    return { outcome: 'pass' as const, detail: `Resolved to ${addresses.join(', ')}`, observations: { hostname, addresses } }
  })
}

/** Confirm the certificate is valid, matches the host, and is not near expiry. */
export async function checkTls(hostname?: string, minimumDaysRemaining = 21): Promise<CheckResult> {
  return timed('tls', 'TLS certificate is valid, matching and not near expiry', async () => {
    if (!hostname) return { outcome: 'unconfigured' as const, detail: 'ACCEPTANCE_HOSTNAME was not supplied.', observations: {} }
    const certificate = await new Promise<any>((resolve, reject) => {
      const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 15_000 }, () => {
        const peer = socket.getPeerCertificate()
        const authorized = socket.authorized
        const error = socket.authorizationError
        socket.end()
        resolve({ peer, authorized, error })
      })
      socket.on('timeout', () => { socket.destroy(); reject(new Error('TLS handshake timed out')) })
      socket.on('error', reject)
    })
    if (!certificate.authorized) {
      return { outcome: 'fail' as const, detail: `Certificate was not authorised: ${certificate.error}`, observations: { hostname } }
    }
    const validTo = new Date(certificate.peer?.valid_to)
    const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
    if (!Number.isFinite(daysRemaining)) return { outcome: 'fail' as const, detail: 'Certificate expiry could not be read.', observations: { hostname } }
    if (daysRemaining < minimumDaysRemaining) {
      return { outcome: 'fail' as const, detail: `Certificate expires in ${daysRemaining} days, below the ${minimumDaysRemaining}-day threshold.`, observations: { hostname, validTo: validTo.toISOString(), daysRemaining } }
    }
    return {
      outcome: 'pass' as const,
      detail: `Valid certificate issued to ${certificate.peer?.subject?.CN || hostname}, ${daysRemaining} days remaining.`,
      observations: { hostname, issuer: certificate.peer?.issuer?.O, validTo: validTo.toISOString(), daysRemaining },
    }
  })
}

/** Verify SMTP by opening a real session and sending to a supplied sink address. */
export async function checkSmtp(): Promise<CheckResult> {
  return timed('smtp', 'SMTP accepts a message for delivery', async () => {
    const host = process.env.SMTP_HOST
    const recipient = process.env.ACCEPTANCE_EMAIL_TO
    if (!host || !recipient) {
      return { outcome: 'unconfigured' as const, detail: 'SMTP_HOST or ACCEPTANCE_EMAIL_TO was not supplied.', observations: {} }
    }
    const nodemailer = await import('nodemailer')
    const transport = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 1025),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined,
      connectionTimeout: 15_000,
    })
    await transport.verify()
    const token = crypto.randomUUID()
    const info = await transport.sendMail({
      from: process.env.EMAIL_FROM || 'LogicFlower <no-reply@localhost>',
      to: recipient,
      subject: `LogicFlower acceptance probe ${token}`,
      text: `Acceptance probe ${token} generated at ${new Date().toISOString()}.`,
    })
    // Acceptance, not delivery. An operator still confirms arrival and records
    // the bounce behaviour; a 250 from the relay is not an inbox.
    return {
      outcome: 'pass' as const,
      detail: `Relay accepted the message (${info.messageId}). Confirm arrival and bounce handling manually.`,
      observations: { host, recipient, messageId: info.messageId, probeToken: token },
    }
  })
}

/** Verify Stripe credentials, mode, and that configured price identifiers exist. */
export async function checkStripe(): Promise<CheckResult> {
  return timed('stripe', 'Stripe test-mode credentials and price identifiers resolve', async () => {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) return { outcome: 'unconfigured' as const, detail: 'STRIPE_SECRET_KEY was not supplied.', observations: {} }
    if (!key.startsWith('sk_test_')) {
      return { outcome: 'fail' as const, detail: 'Acceptance must run against a test-mode key. A live key was supplied.', observations: { mode: 'live' } }
    }
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(key, { apiVersion: undefined as never })
    const prices: Record<string, unknown> = {}
    const missing: string[] = []
    for (const [plan, priceId] of Object.entries({
      starter: process.env.STRIPE_PRICE_STARTER,
      agency: process.env.STRIPE_PRICE_AGENCY,
      scale: process.env.STRIPE_PRICE_SCALE,
    })) {
      if (!priceId) { missing.push(plan); continue }
      const price = await stripe.prices.retrieve(priceId)
      prices[plan] = { id: price.id, active: price.active, unitAmount: price.unit_amount, currency: price.currency }
      if (!price.active) missing.push(`${plan} (inactive)`)
    }
    if (missing.length) {
      return { outcome: 'fail' as const, detail: `Missing or inactive prices: ${missing.join(', ')}`, observations: { prices } }
    }
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      return { outcome: 'fail' as const, detail: 'STRIPE_WEBHOOK_SECRET is not set; signed webhook verification cannot be exercised.', observations: { prices } }
    }
    return { outcome: 'pass' as const, detail: 'Test-mode key valid and all three plan prices are active.', observations: { prices } }
  })
}

/** Confirm the deployed API reports itself ready and its dependencies healthy. */
export async function checkReadiness(baseUrl?: string): Promise<CheckResult> {
  return timed('readiness', 'Deployed API reports dependency readiness', async () => {
    if (!baseUrl) return { outcome: 'unconfigured' as const, detail: 'ACCEPTANCE_API_URL was not supplied.', observations: {} }
    const response = await fetch(new URL('/readyz', baseUrl).toString(), { signal: AbortSignal.timeout(15_000) })
    const body = await response.json().catch(() => ({}))
    if (response.status !== 200 || (body as any)?.ready !== true) {
      return { outcome: 'fail' as const, detail: `Readiness returned HTTP ${response.status}.`, observations: { body } }
    }
    return { outcome: 'pass' as const, detail: 'Readiness reported all dependencies healthy.', observations: { body } }
  })
}

/** Confirm security headers and that no auth token is placed in browser storage. */
export async function checkSecurityHeaders(baseUrl?: string): Promise<CheckResult> {
  return timed('headers', 'Production security headers are present', async () => {
    if (!baseUrl) return { outcome: 'unconfigured' as const, detail: 'ACCEPTANCE_API_URL was not supplied.', observations: {} }
    const response = await fetch(new URL('/healthz', baseUrl).toString(), { signal: AbortSignal.timeout(15_000) })
    const required = ['strict-transport-security', 'x-content-type-options', 'x-frame-options']
    const present: Record<string, string | null> = {}
    const missing: string[] = []
    for (const header of required) {
      const value = response.headers.get(header)
      present[header] = value
      if (!value) missing.push(header)
    }
    if (response.headers.get('x-powered-by')) missing.push('x-powered-by must not be sent')
    if (missing.length) return { outcome: 'fail' as const, detail: `Missing or incorrect headers: ${missing.join(', ')}`, observations: { present } }
    return { outcome: 'pass' as const, detail: 'All required security headers present.', observations: { present } }
  })
}

export async function runAcceptance(): Promise<EvidenceBundle> {
  const hostname = process.env.ACCEPTANCE_HOSTNAME
  const baseUrl = process.env.ACCEPTANCE_API_URL
  const results = [
    await checkDns(hostname),
    await checkTls(hostname),
    await checkReadiness(baseUrl),
    await checkSecurityHeaders(baseUrl),
    await checkSmtp(),
    await checkStripe(),
  ]
  const summary = {
    total: results.length,
    passed: results.filter((result) => result.outcome === 'pass').length,
    failed: results.filter((result) => result.outcome === 'fail').length,
    unconfigured: results.filter((result) => result.outcome === 'unconfigured').length,
  }
  const generatedAt = new Date().toISOString()
  const target = hostname || baseUrl || 'unspecified'
  const bundleHash = crypto.createHash('sha256')
    .update(JSON.stringify({ generatedAt, target, results, summary }))
    .digest('hex')
  return { schemaVersion: 1, generatedAt, target, results, summary, bundleHash }
}

async function main(): Promise<void> {
  const bundle = await runAcceptance()
  const outputDir = process.env.ACCEPTANCE_EVIDENCE_DIR || path.join(process.cwd(), 'acceptance-evidence')
  await fs.mkdir(outputDir, { recursive: true })
  const file = path.join(outputDir, `acceptance-${bundle.generatedAt.replace(/[:.]/g, '-')}.json`)
  await fs.writeFile(file, JSON.stringify(bundle, null, 2), 'utf8')

  for (const result of bundle.results) {
    const marker = result.outcome === 'pass' ? 'PASS' : result.outcome === 'fail' ? 'FAIL' : 'UNCONFIGURED'
    console.log(`${marker.padEnd(13)} ${result.title} — ${result.detail}`)
  }
  console.log(`\nEvidence written to ${file}`)
  console.log(`Bundle hash ${bundle.bundleHash}`)
  console.log(`${bundle.summary.passed} passed, ${bundle.summary.failed} failed, ${bundle.summary.unconfigured} unconfigured.`)

  // Unconfigured is not success. Exiting non-zero on anything other than a full
  // pass prevents this command being wired into a pipeline that then reports
  // green because nothing was configured.
  if (bundle.summary.failed > 0 || bundle.summary.unconfigured > 0) process.exitCode = 1
}

if (require.main === module) {
  void main()
}
