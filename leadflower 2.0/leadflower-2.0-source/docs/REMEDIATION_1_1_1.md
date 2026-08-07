# Remediation record — 1.1.1

Supersedes the completion claims in `COMPLETION_AUDIT.md` for the areas below.

## Governing principle

Four of the audit items — [V3], [V11], [V14], [V29] — cannot be resolved by code. No implementation can make HighLevel grant a scope, tell you what ActiveCampaign's licence permits, or reveal whether a competitor exists. Code that *asserts* those answers reproduces the exact failure being remediated: a green indicator with nothing behind it.

The engineering objective for those four is therefore inverted. The code does not resolve them; it makes them **structurally impossible to fake**, and fails closed until a named person records the real answer.

---

## [V3] — Provider capability is now evidence-backed

### Root cause

`services/oauthProviders.ts` contained:

```ts
scopes: String(response.data?.scope || item.scopes.join(' ')).split(/\s+/)
```

When a provider did not echo a `scope` field, the connection recorded **the scopes we requested as though they had been granted**. `workflowInventoryCapability()` read that list and returned `{ enabled: true }`, so Functions 4, 5, 6 and 8 reported themselves working on the strength of a request nobody had answered. `routes/connections.ts` compounded it by accepting a client-supplied `scopes` array on manually created connections.

### Fix

| Component | Behaviour |
|---|---|
| `services/capability/capabilityModel.ts` | Pure resolver. Classifies scope lists by provenance: `provider_token_response`, `live_probe`, `operator_claimed`, `requested_not_confirmed`. Only the first two are evidence. |
| `models/CapabilityProbe.ts` | Append-only record of live read-only observations, each with a SHA-256 evidence hash. |
| `services/capability/capabilityService.ts` | Resolves capability from persisted evidence. A probe outranks a scope grant, because a provider can return a scope string and still refuse the call. |
| `POST /connections/:id/capabilities/:capability/probe` | Operator-run read-only probe. Only probeable capabilities are accepted; nothing destructive is ever probed. |
| `GET /connections/:id/capabilities` | Full matrix with the evidence behind each answer. |

Design rules enforced by tests:

- Absence of evidence resolves to `unverified`, **never** `available`.
- An inconclusive probe (timeout, 5xx) records `unverified`, not confirmation.
- `contact.merge` and `contact.delete` can never reach `available` from scopes alone for any provider.
- The legacy synchronous helper survives as a shim with **no code path to `enabled: true`**.

Monitoring now opens a visible `capability_unverified` incident instead of silently returning `[]` — the behaviour that let a monitoring run report success while observing nothing. The client renders `unverified` as a distinct third state, because an empty workflow list is otherwise indistinguishable from an account that genuinely has no workflows.

**Still open:** whether HighLevel grants `workflows.readonly` to a marketplace app. The code now reports that honestly instead of assuming it.

---

## [V11] — Purge ledger

### Root cause

`purgeConnectionCaches` deleted `Contact`, `Tag` and `PollCursor` — but **not `WorkflowSnapshot`**. Disconnection wiped contacts and left the workflow history, which is precisely the class of cached provider data a deletion clause is written about.

### Fix

- `services/retention/providerDataPolicy.ts` — per-provider policy with a recorded `legalBasis`. Every provider defaults to `unreviewed`, which purges immediately. A non-zero retention window is ignored unless the basis is `counsel_confirmed_retention_permitted`, so a day count set by mistake cannot cause retention.
- `models/DataPurgeLedgerEntry.ts` — append-only evidence, hash-chained per connection.
- `services/retention/purgeLedger.ts` — deletes a declared `PROVIDER_DERIVED` set (now including `WorkflowSnapshot`, `ConnectionScan`, `CapabilityProbe`, `WebhookEvent`) as one unit, plus `verifyPurgeLedger()` which recomputes the chain and reports the first broken index. A hash nobody verifies is decoration.

The customer-held Vault export remains the durable artefact, which satisfies the product need without vendor-side retention.

**Still open:** the actual reading of each provider's terms.

---

## [V14] — ActiveCampaign quarantine

`services/connectors/releaseState.ts` gives each connector `general` / `quarantined` / `disabled`.

- ActiveCampaign defaults to `quarantined`. Unknown providers also default to `quarantined` — it fails closed.
- Quarantine is not deletion: existing connections stay readable so a customer can export and disconnect cleanly. Writes return HTTP 451.
- Enforcement is a Proxy applied at the `createConnector` factory, so a workflow node or batch operation added later inherits the gate automatically rather than depending on an engineer remembering.
- Sign-off is configuration (`CONNECTOR_RELEASE_STATES=activecampaign:general`), not a code change. A malformed override is ignored rather than failing open.

---

## [V29] — Not addressable in code

Whether a HighLevel workflow backup or monitoring competitor exists is answered by an hour in the marketplace. Nothing in this release touches it, and no code change depends on it. The go-to-market wedge does.

---

## [V43] / [V44] — Brand decoupled from the API contract

`problemType()` composes type URIs from `PROBLEM_TYPE_BASE_URI`, defaulting to the URN `urn:logicflower:problem` — a permanent identifier that resolves to nothing and asserts ownership of no domain. Twelve files carrying hardcoded `https://logicflower.com/problems/...` were rewritten.

Problem type URIs are part of the public API contract: once a client switches on `type`, changing it is a breaking change. A guardrail now rejects any new brand URL in `server/src/` or `client/src/`, exempting RFC 2606 reserved TLDs so fixtures can still use `.example`.

---

## Deduplication — detection to guarded resolution

`services/dedupe/mergePlanner.ts` is pure. It cannot lose data because it cannot write.

- Union-find grouping, transitive: A~B by email and B~C by phone is one identity, not two overlapping pairs that would produce merges fighting each other.
- Deterministic survivor selection with an explicit ID tiebreak, so the same input always yields the same `planHash`. A hash that is not reproducible cannot be meaningfully approved.
- Four conflict policies. `require_manual` blocks the group rather than guessing.
- Filling a blank on the survivor is not a conflict; overwriting a populated field is, and every discarded value is reported.
- Caps: 25 records per group, 5,000 groups per plan.

`services/dedupe/mergeExecutor.ts` requires four preconditions before any write: verified capability, a plan hash matching the approved one, complete before-state for every record in scope, and deletion opted into separately from merging. Enabling deletion changes the plan hash, so a merge-only approval cannot authorise deletions.

**Deliberately not implemented:** provider merge/delete API calls. No connector declares `contact.merge` or `contact.delete` as available, so `assertMergeCapability` refuses in this build. There is no verified knowledge of those endpoints, and guessing at one is how a merge becomes an unrecoverable delete. This is the difference between *not implemented* and *implemented against an endpoint we assumed exists*.

---

## Usage alerting and overage

`services/usageAlerts.ts`, hooked into `reserveMeteredUsage` after the ledger insert.

- Thresholds computed from before/after counter values, so a 50,000-record batch on a 20,000 allowance raises **both** the 80% and 100% notices rather than only the last.
- Idempotency is a unique index, not read-then-write: concurrent chunk workers do not each fire a notice.
- Overage priced per report §24.4 ($6/$5/$4 per 10,000), partial blocks billing whole, unpriced plans accruing zero.
- Alert failure never propagates into the billable path — a courtesy warning must not fail a customer's job.

Overage is **measured and reported, not charged**. Metered billing must reconcile in Stripe test mode before an invoice depends on it.

---

## Cross-tenant isolation

`test/integration/tenant-isolation.integration.test.ts` drives real HTTP against the mounted Express app: nine cross-tenant read paths, five mutation paths, list scoping, forged organisation headers, unauthenticated access, and a post-attack assertion that the victim tenant is byte-for-byte unmodified. A 404 that still leaks the record in the body is asserted as a failure.

It uses `MongoMemoryReplSet` — a replica set, not a standalone — because the usage ledger requires transactions and fails closed without them; a standalone would exercise a different path from production.

- Excluded from the unit run so a developer without dependencies cannot see a green unit result that silently skipped it.
- CI runs it with `INTEGRATION_REQUIRED=1`, which turns a missing dependency into a **failure** rather than a skip.

**Status: mitigated, not closed.** The suite has been written and typechecked but not executed, because this environment's egress proxy blocks the MongoDB binary download. It must go green in CI before multi-tenancy is claimed.

---

## Live acceptance

`scripts/acceptance/runAcceptance.ts` replaces six declarative checkboxes with executable checks producing a hashed evidence bundle: DNS (rejecting private addresses), TLS (validity, hostname match, expiry threshold), readiness, security headers, SMTP session, and Stripe test-mode price resolution.

Three outcomes: `pass`, `fail`, `unconfigured`. **`unconfigured` is never `pass`** — a check that could not run has not run — and the command exits non-zero on either, so it cannot be wired into a pipeline that reports green because nothing was configured.

DNS and TLS were executed against a live host during development and both returned `pass`.

---

## Verification

| Gate | Before | After |
|---|---|---|
| Repository guardrails | 231 files | 250 files, plus two new regression rules |
| Server TypeScript | clean | clean |
| Client TypeScript | clean | clean |
| Server unit tests | 21 files / 83 tests | 25 files / 120 tests |
| Client tests | 2 files / 6 tests | 2 files / 6 tests |
| Production builds | pass | pass |
| Integration suite | did not exist | written, CI-gated, **not yet executed** |

Both new guardrails were verified to fire on a deliberately introduced regression and to pass once reverted.

## What this release still may not claim

1. That workflow inventory, monitoring, break detection or the health dashboard work for any provider. They are gated on evidence nobody has yet collected.
2. That multi-tenant isolation is proven. The suite exists; it has not run.
3. That duplicates can be resolved. They can be planned, not executed.
4. That overage can be billed. It can be measured.
5. That any provider's legal terms permit what the connectors do.
