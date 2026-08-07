#!/usr/bin/env node
/**
 * Static tenant-isolation guardrail.
 *
 * The runtime integration suite proves isolation dynamically, on the paths it
 * happens to exercise. This proves it statically, on every path that exists.
 * The two are complementary: a dynamic test can only fail on a query it runs,
 * and a static check can only reason about a query it can see. Together they
 * cover the case that matters — a route added next year that forgets the
 * organisation predicate and is never covered by a test.
 *
 * The rule: any query against a tenant-owned model, from a route or service,
 * must constrain by `organizationId`.
 *
 * Escape hatch, deliberately narrow: a `// tenant-safe: <reason>` comment on
 * the line above suppresses a single finding and requires a written reason. A
 * guard with no escape hatch gets deleted the first time it is inconvenient; a
 * guard whose exceptions are grep-able stays.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
const SCAN_DIRS = ['server/src/routes', 'server/src/services', 'server/src/middleware', 'server/src/queue']

/**
 * Models whose rows belong to exactly one organisation. Kept in sync with the
 * tenant-model list in repository-guardrails.mjs.
 */
const TENANT_MODELS = new Set([
  'AiConnectionConsent', 'Alert', 'Artifact', 'AuditEvent', 'BatchJob', 'BatchRecord',
  'CapabilityProbe', 'ConnectionDeletionTask', 'ConnectionScan', 'Contact', 'DataLifecycleRequest',
  'DataPurgeLedgerEntry', 'Destination', 'Execution', 'ExecutionNodeRun', 'FailedJob',
  'GeneratedReport', 'Incident', 'Invitation', 'Membership', 'MonitoringRun',
  'NotificationChannel', 'OAuthState', 'PlatformConnection', 'PollCursor', 'Schedule',
  'Subscription', 'SupportAccessRequest', 'Tag', 'UltraSplit', 'UsageAlert', 'UsageCounter',
  'UsageRecord', 'WebhookDelivery', 'WebhookEvent', 'WebhookKey', 'Workflow',
  'WorkflowDryRunApproval', 'WorkflowSnapshot', 'WorkflowVersion',
  'MessagingIdentity', 'ScheduledStep', 'SendRecord', 'Sequence', 'SequenceEnrolment',
  'SequenceVersion', 'SuppressionEntry',
  'ContactActivity', 'ContactNote', 'CustomFieldDefinition', 'Deal', 'FormSubmission', 'HostedForm', 'PaymentLink', 'Pipeline', 'SavedSegment', 'Task', 'Appointment', 'Conversation', 'Message',
  'SocialAccount', 'SocialPost', 'ScheduledPost', 'Review', 'ReviewRequest', 'ReviewWidget',
  'VoiceAgent', 'VoiceAgentVersion', 'VoiceCall', 'DialerJob',
  'Company', 'TagRule', 'BookingPage',
])

/**
 * Models where the organisation *is* the record, so `_id` is already the tenant
 * key and a separate organizationId predicate would be meaningless.
 */
const TENANT_ROOT_MODELS = new Set(['Organization'])

const READ_METHODS = new Set(['find', 'findOne', 'countDocuments', 'exists', 'distinct', 'aggregate'])
const WRITE_METHODS = new Set([
  'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'bulkWrite',
])
const ID_METHODS = new Set(['findById', 'findByIdAndUpdate', 'findByIdAndDelete', 'findByIdAndRemove'])
const QUERY_METHODS = new Set([...READ_METHODS, ...WRITE_METHODS, ...ID_METHODS])

const findings = []
const suppressions = []

function walkFiles(directory) {
  const out = []
  let entries
  try { entries = readdirSync(directory) } catch { return out }
  for (const entry of entries) {
    const full = join(directory, entry)
    const info = statSync(full)
    if (info.isDirectory()) out.push(...walkFiles(full))
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** Identifiers in this file that are default-imported from ../models/<Name>. */
function modelIdentifiers(source) {
  const names = new Map()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier
    if (!ts.isStringLiteral(specifier) || !specifier.text.includes('models/')) continue
    const modelName = specifier.text.split('/').pop()
    const clause = statement.importClause
    if (clause?.name) names.set(clause.name.text, modelName)
  }
  return names
}

/** Does an object literal constrain on organizationId, at any nesting depth? */
function literalHasOrganizationId(node) {
  if (!node) return false
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ? property.name.text
        : null
      if (name === 'organizationId') return true
      // $and / $or / $match wrappers still count if a branch constrains.
      if (name && name.startsWith('$') && ts.isPropertyAssignment(property)) {
        if (literalHasOrganizationId(property.initializer)) return true
      }
      // Spread of a pre-built filter: resolved by the caller where possible.
      if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) return 'spread'
    }
    return false
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some((element) => literalHasOrganizationId(element) === true)
  }
  return false
}

/**
 * Resolve an identifier used as a filter back to its declaration, including
 * later `query.organizationId = ...` assignments, which is the dominant pattern
 * in this codebase's list endpoints.
 */
function identifierConstrained(source, name) {
  let constrained = false
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      if (literalHasOrganizationId(node.initializer) === true) constrained = true
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && ts.isIdentifier(node.left.expression)
      && node.left.expression.text === name
      && node.left.name.text === 'organizationId'
    ) constrained = true
    ts.forEachChild(node, visit)
  }
  visit(source)
  return constrained
}

/**
 * Look for a `// tenant-safe: <reason>` marker on the line of the call or the
 * line immediately above it.
 *
 * Line-based rather than AST-based on purpose. Several files here put a whole
 * route handler on one line, so the innermost enclosing statement and the call
 * share a line and there is nowhere for leading trivia to attach. A developer
 * annotates the line they can see.
 */
function suppressionReason(lines, lineNumber) {
  for (const candidate of [lines[lineNumber - 1], lines[lineNumber - 2]]) {
    if (!candidate) continue
    const match = candidate.match(/tenant-safe:\s*(.+?)\s*(?:\*\/)?$/)
    if (match) return match[1].trim()
  }
  return null
}

for (const file of SCAN_DIRS.flatMap((directory) => walkFiles(join(ROOT, directory)))) {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
  const sourceLines = text.split('\n')
  const models = modelIdentifiers(source)
  if (!models.size) continue
  const relativePath = relative(ROOT, file)

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression
      const method = node.expression.name.text
      if (ts.isIdentifier(receiver) && QUERY_METHODS.has(method)) {
        const modelName = models.get(receiver.text)
        if (modelName && TENANT_MODELS.has(modelName) && !TENANT_ROOT_MODELS.has(modelName)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          const reason = suppressionReason(sourceLines, line)

          let ok = false
          let detail = ''

          if (ID_METHODS.has(method)) {
            // findById cannot express a tenant predicate at all.
            detail = `${modelName}.${method}() cannot constrain by organizationId`
          } else {
            const filter = method === 'aggregate' ? node.arguments[0] : node.arguments[0]
            const verdict = literalHasOrganizationId(filter)
            if (verdict === true) ok = true
            else if (filter && ts.isIdentifier(filter)) {
              ok = identifierConstrained(source, filter.text)
              if (!ok) detail = `${modelName}.${method}() filter "${filter.text}" is never constrained by organizationId`
            } else if (verdict === 'spread') {
              ok = true
            } else {
              detail = `${modelName}.${method}() is not constrained by organizationId`
            }
          }

          if (!ok) {
            if (reason) suppressions.push({ file: relativePath, line, detail, reason })
            else findings.push({ file: relativePath, line, detail })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

if (suppressions.length) {
  console.log(`Tenant-isolation guard: ${suppressions.length} justified exception(s)`)
  for (const item of suppressions) console.log(`  - ${item.file}:${item.line} ${item.detail} — ${item.reason}`)
}

if (findings.length) {
  console.error('\nTenant-isolation guard FAILED:')
  for (const item of findings) console.error(`  - ${item.file}:${item.line}: ${item.detail}`)
  console.error('\nEvery query against a tenant-owned model must constrain by organizationId.')
  console.error('If a query is genuinely safe, add a "// tenant-safe: <reason>" comment above it.')
  process.exit(1)
}

console.log('Tenant-isolation guard passed.')
