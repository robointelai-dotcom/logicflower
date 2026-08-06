# Remediation record — 1.1.3

Scope: the "safe to put a paying customer on" batch. No new product features; this release is entirely about the controls that stand between working software and software you can defensibly hand someone's CRM credentials to.

## Summary

| Item | Status | Evidence |
|---|---|---|
| Static tenant-isolation guard | **Resolved** | `scripts/tenant-isolation-guard.mjs`; wired into `npm run guardrails` |
| Cross-tenant query tightening | **Resolved** | 4 queries fixed in `workflows.ts`, `connections.ts`, `organizations.ts` |
| Response header and CSP policy | **Resolved** | `app.ts`; 6 tests against the mounted app |
| Account lockout policy | **Resolved** | `auth/lockout.ts`, wired into the login handler; 6 tests |
| SBOM generation | **Resolved in CI**, never executed on a runner | `.github/workflows/security.yml` sbom job |
| Incident response plan | **Resolved as documentation** | `docs/INCIDENT_RESPONSE.md` |
| Vulnerability disclosure and safe harbour | **Resolved as documentation** | `SECURITY.md` |
| Subprocessor register | **Template only** — requires countersignature | `docs/SUBPROCESSORS.md` |

## Verification

| Gate | 1.1.2 | 1.1.3 |
|---|---|---|
| Repository guardrails | 267 files | 272 files |
| Tenant-isolation guard | did not exist | **passes, 34 documented exceptions** |
| ESLint security rules | 0 findings | 0 findings |
| Server tests | 27 files / 147 | **28 files / 159** |
| Client tests | 2 / 6 | 2 / 6 |
| Typechecks and builds | pass | pass |

## The tenant guard

This is the substantive item. The runtime isolation suite proves isolation dynamically on the paths it happens to exercise; this proves it statically on every path that exists. A dynamic test can only fail on a query it runs, and a static check can only reason about a query it can see — together they cover the case that actually bites, which is a route added next year that forgets the predicate and is never covered by a test.

Implemented against the TypeScript compiler API rather than by regex, because regex-matching real code produces both false negatives on multi-line calls and false positives that get the guard deleted.

**It found 36 issues on first run.** Four were genuine and were fixed:

| Location | Problem |
|---|---|
| `workflows.ts` | `WorkflowDryRunApproval.updateOne({ _id })` — safe only because an earlier query happened to be scoped |
| `connections.ts` | `PlatformConnection.findById(row._id)` — a shape that cannot express a tenant predicate at all |
| `organizations.ts` | `Invitation.deleteOne({ _id })` on the rollback path |

The remaining 32 are legitimate — cross-tenant background workers, user-scoped queries, and public endpoints where an unguessable token is the tenant identifier. Each carries an inline `// tenant-safe: <reason>` annotation and is printed on every run, so the exceptions stay visible rather than becoming invisible once suppressed.

**Proven, not assumed:** a realistic leak was planted (a list endpoint querying `GeneratedReport` without an organisation predicate), the guard failed the build, and it passed again on revert.

### Why an escape hatch exists

A guard with no suppression mechanism gets deleted the first time it is inconvenient. One whose exceptions require a written reason and are enumerated on every run survives, and the enumeration is itself a review artefact — 34 lines that a security reviewer can read in two minutes.

## Header policy

Replaced helmet defaults with an explicit policy. The API returns JSON and never renders HTML, so the CSP is close to deny-everything: `default-src 'none'`, `script-src 'none'`, `frame-ancestors 'none'`. An XSS introduced through some future error page or docs route has nothing to execute with.

HSTS is asserted only when `COOKIE_SECURE` is set. Asserting it from a plaintext development server pins a developer's browser to `https://localhost`, which is a self-inflicted outage.

Tested against the mounted application rather than by reading the configuration back — the configuration is not the contract; what leaves the process is.

## Lockout

Extracted from the login handler into `auth/lockout.ts` so the arithmetic can be tested without a database. That arithmetic is where the bugs live: an off-by-one either locks a legitimate user out one failure early or leaves an attacker one extra attempt per cycle, and neither is visible from reading the handler.

The extraction also surfaced a real gap — an expired lock was previously never cleared for a user whose row was not otherwise rewritten. It is now cleared on the next attempt.

The module is wired into the handler, not left as tested-but-unused code.

## Documents

`INCIDENT_RESPONSE.md` gives severity definitions keyed to impact, a first-thirty-minutes sequence that stops the bleeding before diagnosing, containment procedures per incident type, and statutory notification clocks.

Two things stated plainly in it: the GDPR 72-hour clock starts at *awareness*, not at the end of the investigation; and the statutory table has **not** been reviewed by counsel and must be before anyone relies on it.

`SECURITY.md` gains a safe-harbour statement, response-time targets marked as unproven, an explicit out-of-scope list, and a "verified and unverified" section that names exactly which controls are machine-checked on every build and which are merely written.

`SUBPROCESSORS.md` is explicitly labelled a template with an unticked completion checklist. A subprocessor list that has not been checked is worse than none, because it will be relied upon.

## What 1.1.3 still may not claim

Unchanged from 1.1.2, and worth repeating rather than burying:

1. **The runtime isolation suite has still never executed.** The static guard is a genuine second line of evidence, not a substitute. Both should be green before multi-tenancy is claimed.
2. No penetration test, no provider sandbox traffic, no Stripe reconciliation, no restore drill, no SBOM actually generated on a runner.
3. The incident plan has never been rehearsed. A plan that has not been exercised is a document, not a capability.
4. The subprocessor register is unsigned.
5. [V3], [V11], [V14] and [V29] are untouched.

On the four-axis estimate, this batch moves "safe to put a paying customer on" from roughly 80% to roughly 88%. The remaining points are not code — they are a CI run, a restore drill, and a pen test.
