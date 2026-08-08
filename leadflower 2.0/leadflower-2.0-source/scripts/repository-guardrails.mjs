import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'

const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules'])
function repositoryFiles(directory = '.') {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name).replace(/^\.\//, '')
    if (entry.isDirectory()) files.push(...repositoryFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

let tracked
let trackedByGit = false
try {
  tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\0')
    .filter((file) => Boolean(file) && existsSync(file))
  trackedByGit = true
} catch {
  tracked = repositoryFiles()
}

const failures = []
const textExtensions = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.ps1', '.sh', '.ts', '.tsx', '.yaml', '.yml',
])

for (const file of tracked) {
  const basename = file.split('/').at(-1)
  if (trackedByGit && (basename === '.env' || (basename?.startsWith('.env.') && basename !== '.env.example'))) {
    failures.push(`${file}: environment file must not be tracked`)
  }

  if (!textExtensions.has(extname(file)) && basename !== '.env.example') continue
  const source = readFileSync(file, 'utf8')
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source)) {
    failures.push(`${file}: private key material detected`)
  }

  if (file.startsWith('server/src/')) {
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    // A bare JavaScript eval is forbidden. Property calls such as Redis.eval
    // execute a server-side Lua command and are not JavaScript evaluation.
    if (/(?<![.\w])eval\s*\(/.test(executable) || /\bnew\s+Function\s*\(/.test(executable)) {
      failures.push(`${file}: arbitrary JavaScript evaluation is forbidden`)
    }
  }
  if (file.startsWith('client/src/') && /localStorage\.(?:setItem|getItem)\(\s*['"](?:token|session|accessToken|refreshToken)['"]/.test(source)) {
    failures.push(`${file}: authentication tokens/sessions must not be stored in localStorage`)
  }

  // Problem type URIs are part of the public API contract. Hardcoding a brand
  // domain into them commits an uncleared name ([V43], [V44]) into a value
  // clients switch on, making a later rename a breaking change. Compose them
  // through problemType(), which reads PROBLEM_TYPE_BASE_URI.
  if ((file.startsWith('server/src/') || file.startsWith('client/src/'))
    && !file.endsWith('server/src/http/problem.ts')
    // RFC 2606 reserved TLDs (.example, .test, .invalid, .localhost) are the
    // correct thing for fixtures to use and are not a brand commitment.
    && /https?:\/\/[a-z0-9.-]*logicflower\.(?!example\b|test\b|invalid\b|localhost\b)[a-z]{2,}/i.test(source)) {
    failures.push(`${file}: hardcoded brand URL is forbidden; use problemType() or a configured base URI`)
  }

  // A scope list the provider did not return is not a grant. Reintroducing a
  // fallback from requested scopes to granted scopes is the [V3] defect.
  if (file.startsWith('server/src/') && /scopes?\s*:\s*String\([^)]*\|\|[^)]*item\.scopes/.test(source)) {
    failures.push(`${file}: requested scopes must never be recorded as granted scopes`)
  }
}

const serverPackage = JSON.parse(readFileSync('server/package.json', 'utf8'))
if (serverPackage.dependencies?.['isolated-vm']) {
  failures.push('server/package.json: isolated-vm is forbidden; use the bounded structured expression engine')
}

const tenantModels = [
  'AiConnectionConsent', 'Alert', 'Artifact', 'AuditEvent', 'BatchJob', 'BatchRecord', 'ConnectionDeletionTask', 'ConnectionScan', 'DataLifecycleRequest',
  'Contact', 'Destination', 'Execution', 'ExecutionNodeRun', 'FailedJob', 'GeneratedReport', 'Incident', 'Invitation',
  'Membership', 'MonitoringRun', 'NotificationChannel', 'OAuthState', 'PlatformConnection', 'PollCursor', 'Schedule',
  'Subscription', 'SupportAccessRequest', 'Tag', 'UltraSplit', 'UsageCounter', 'UsageRecord', 'WebhookDelivery',
  'WebhookEvent', 'WebhookKey', 'Workflow', 'WorkflowDryRunApproval', 'WorkflowSnapshot', 'WorkflowVersion',
  'CapabilityProbe', 'DataPurgeLedgerEntry', 'UsageAlert',
  'MessagingIdentity', 'ScheduledStep', 'SendRecord', 'Sequence', 'SequenceEnrolment',
  'SequenceVersion', 'SuppressionEntry',
  'ContactActivity', 'ContactNote', 'CustomFieldDefinition', 'Deal', 'FormSubmission', 'HostedForm', 'PaymentLink', 'Pipeline', 'SavedSegment', 'Task', 'Appointment', 'Conversation', 'Message',
  'SocialAccount', 'SocialPost', 'ScheduledPost', 'Review', 'ReviewRequest', 'ReviewWidget',
  'VoiceAgent', 'VoiceAgentVersion', 'VoiceCall', 'DialerJob',
  'Company', 'TagRule', 'BookingPage',
  // Platform-owned marketing content: one public website, no tenant.
  // Writes are gated on the platform role, not a workspace membership.
]
for (const name of tenantModels) {
  const path = `server/src/models/${name}.ts`
  if (!tracked.includes(path)) continue
  if (!/\borganizationId\b/.test(readFileSync(path, 'utf8'))) {
    failures.push(`${path}: tenant-owned model requires organizationId`)
  }
}

for (const file of tracked.filter((value) => value.startsWith('server/src/'))) {
  if (/\benv\.GHL_TOKEN\b|\benv\.GHL_LOCATION_ID\b/.test(readFileSync(file, 'utf8'))) {
    failures.push(`${file}: global provider credentials are forbidden; resolve an organization connection`)
  }
}

/**
 * Suppression entries must survive every retention purge.
 *
 * Deleting the record that says "this person asked us to stop" does not just
 * lose data — it silently re-permits contact, and the operator finds out when a
 * regulator does. Organisation-wide erasure is the one exception and lives in
 * dataLifecycle.ts, where the sender itself ceases to exist. Anywhere else,
 * touching this collection is a defect.
 */
for (const file of ['server/src/services/retention.ts', 'server/src/services/retention/purgeLedger.ts']) {
  if (!tracked.includes(file)) continue
  // Comments are stripped first: the rule is about executable references, and a
  // file explaining why it must not purge suppression is evidence of the
  // invariant holding, not of it being broken.
  const executable = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  if (/\bSuppressionEntry\b/.test(executable)) {
    failures.push(`${file}: suppression entries must never be purged by retention; only organisation erasure may remove them`)
  }
}

/**
 * A TTL index on suppression would expire entries silently, with no code change
 * to review and no audit trail.
 */
if (tracked.includes('server/src/models/SuppressionEntry.ts')) {
  const suppressionModel = readFileSync('server/src/models/SuppressionEntry.ts', 'utf8')
  if (/expireAfterSeconds|expires\s*:/.test(suppressionModel)) {
    failures.push('server/src/models/SuppressionEntry.ts: a TTL index on suppression entries is forbidden')
  }
}

const workflowLibrary = readFileSync('server/src/services/nodeLibrary.ts', 'utf8')
if (/['"]action\.http\.(?:request|mapper|ultra)['"]\s*:/.test(workflowLibrary)) {
  failures.push('server/src/services/nodeLibrary.ts: raw HTTP workflow executors are forbidden; use a verified Destination')
}

if (failures.length > 0) {
  process.stderr.write(`Repository guardrails failed:\n- ${failures.join('\n- ')}\n`)
  process.exit(1)
}

process.stdout.write(`Repository guardrails passed for ${tracked.length} repository files.\n`)
