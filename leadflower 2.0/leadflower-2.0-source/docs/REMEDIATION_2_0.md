# Remediation 2.0 — Phase 1: sequence engine

Base commit: `e97f349` ("Final update of logicflower production").
Scope: **Phase 1 only.** Phases 2–5 were not started.

This document records what was built, what was not, and what remains
unverified. It does not carry a score. The repository already contains a
self-issued 100/100 completion audit that was wrong, and the point of this
document is to be the opposite of that.

---

## 1. Baseline correction

The build specification stated a green baseline. The repository at `e97f349`
did not match it:

| Gate | Specification | Measured at `e97f349` |
|---|---|---|
| Repository guardrails | 273 files, passing | 274 files, passing |
| Tenant-isolation guard | passing, 34 exceptions | passing, **33** exceptions |
| ESLint security | 0 findings | **4 errors** |
| Server tests | 28 files, 159 tests | 28 files, 159 tests — passing |
| Client tests | 2 files, 6 tests | 2 files, 6 tests — passing |
| TypeScript strict, both apps | 0 errors | 0 errors |
| Production builds | passing | passing |

The four lint errors were pre-existing in the base commit, not introduced by
this work:

- `client/src/pages/HomePage.tsx` — unused `ArrowRight` import.
- `server/src/index.ts`, `server/src/queue/processor.ts`,
  `server/src/types/authenticatedRequest.ts` — `@typescript-eslint/triple-slash-reference`.

All four were cleared. The `/// <reference>` directives were redundant:
`server/src/types/express.d.ts` sits under `src`, which `tsconfig.json` already
includes, so the global declaration merging is unaffected. Verified by
typecheck.

---

## 2. What was built

### 2.1 Durable waits (spec 1.2)

`ScheduledStep` in MongoDB is the source of truth for every pending step.
The scheduler is a polling loop over `dueAt`, registered as recurring
maintenance in the worker rather than as a BullMQ consumer.

This is the central design decision of Phase 1. The existing `control.delay`
node parks a job in Redis, which is safe for seconds and unsafe for days: a
Redis restart drops every pending job and nothing records that it happened.
Redis remains in use for provider rate limiting and circuit breaking through
the existing `PolicyConnectorTransport`. **Flushing Redis entirely loses no
scheduled step.**

The trade is latency: a step is picked up within one poll interval of becoming
due. For follow-up measured in hours and days that is not a meaningful cost.

Two-stage lease, following the pattern in `batchService.ts`:

- `before_send` — no provider call attempted. An expired lease returns the step
  to `pending`; running it again is safe.
- `send_started` — a provider call began. An expired lease resolves to
  `outcome_unknown` and the step is **never** retried automatically, because a
  message may already have reached a real person.

### 2.2 Duplicate-send prevention (spec 1.3)

Three independent gates, each tested separately:

1. **Atomic claim** — `findOneAndUpdate` on a `pending` predicate. Two workers
   polling concurrently cannot take the same step.
2. **Lease compare-and-swap** — `markSendStarted` matches on the lease the
   caller believes it holds. A worker that lost its lease to a recovery sweep
   cannot reach a provider.
3. **Unique send record** — unique index on
   `(organizationId, enrolmentId, stepIndex, channel)`. The record is written
   **before** the provider call and updated with the outcome after. A duplicate
   key is a correct refusal to double-send.

Gate 3 is the one that holds when the others have already failed: a test
deliberately winds the enrolment cursor back and re-pends a completed step —
the state a botched recovery would produce — and proves no second message goes
out.

### 2.3 Enrolment state and version pinning (spec 1.1)

`SequenceEnrolment` pins `sequenceVersionId` at enrolment, exactly as
`WorkflowVersion` is pinned at execution. `SequenceVersion` is immutable;
publishing a change creates a new version and cannot alter an in-flight
enrolment.

Exit conditions are evaluated **before every step**, not only at enrolment:
enrolment status, sequence status (a paused sequence exits its enrolments
rather than leaving a backlog to fire on resume), cursor staleness, and
suppression.

A partial unique index on `(organizationId, sequenceId, contactId)` over
`status: 'active'` makes enrolment idempotent — a webhook that fires twice and
an operator clicking twice converge on one enrolment.

### 2.4 Suppression and unsubscribe (spec 1.7)

Checked before **every** send on **every** channel, through a single function
that throws rather than returning a boolean a caller can forget to read.

Fails closed in both directions that matter: a lookup error propagates rather
than resolving to "not suppressed", and an address that cannot be normalised is
refused rather than digested into a value that matches nothing.

Addresses are stored as an organisation-scoped HMAC plus a redacted preview, so
the list is queryable without being a harvestable contact database. The digest
key is derived from `ENCRYPTION_KEY` via HKDF rather than from a versioned data
key — a rotated digest would no longer match stored entries, silently making
every suppressed recipient contactable again.

**Suppression survives retention purges.** `services/retention.ts` does not
import the model, and a repository guardrail fails the build if it ever does.
A TTL index on the collection is also forbidden by guardrail. Both were
verified by injecting a real violation and confirming the build fails.

Organisation-wide erasure is the single exception, in `dataLifecycle.ts`: the
sender ceases to exist, so no future send is possible, and retaining keyed
digests of people's addresses after the controller is gone would itself be
personal data kept without a purpose.

Public unsubscribe endpoint: rate limited, unauthenticated, identified only by
a 24-byte per-send token. `GET` renders a confirmation and does not act,
because mail clients and security scanners prefetch links; `POST` performs it
and is also the RFC 8058 one-click target. Responses are identical whether or
not the token matched, so the endpoint is not an enumeration oracle.

### 2.5 Quiet hours (spec 1.8)

Timezone-aware through the IANA database via `Intl`, snapshot per enrolment so
a mid-sequence contact edit cannot retime pending steps.

Steps due inside a quiet window **defer, and are not skipped**. Deferral also
returns the attempt consumed at claim time, so a step held out of a nightly
window for a week does not exhaust its retry budget without ever having been
offered to a provider.

DST is handled: a 09:00 local send stays at 09:00 across a transition, with the
elapsed gap becoming 23 or 25 hours. Tested.

### 2.6 Direct email and SMS (spec 1.5, 1.6)

Per-organisation `MessagingIdentity` with credentials encrypted using
`encryptString` and a per-record AAD, never selected by default, never read
from the environment. Platform SMTP remains for password resets and invitations
and is not reachable from the sequence engine.

SMTP host validation reuses the existing `isPrivateOrReservedIp` classifier —
an operator-supplied hostname reaching a socket is an SSRF sink, and an SMTP
connection probes an internal network as well as an HTTP request does.

`action.ghl.send.email` and `action.ghl.send.sms` keep working and are now
labelled in `PLATFORM_CHARGED_NODE_TYPES`, surfacing as a workflow validation
**warning** with the cost stated and the alternative named. A warning rather
than an error: there are legitimate uses, and breaking published workflows
would be worse than the charge.

SPF/DKIM/DMARC are returned as requirements and recorded observations, never as
a verdict. The system cannot know whether a receiving provider will accept
mail.

### 2.7 WhatsApp (spec 1.10)

Interface, template model, 24-hour session-window state and capability gate are
built. **The provider call deliberately refuses**, following the
`contact.merge` precedent in `services/dedupe/mergeExecutor.ts`. See §4.

### 2.8 Delivery tracking (spec 1.9)

Full status track per send. Delivery and bounce state is always recorded
because the engine cannot function without it. Open and click tracking is
separated and **defaults to off** per organisation
(`Organization.engagementTrackingEnabled`), because it records a person's
behaviour and needs a lawful basis the operator may not have. The check fails
closed.

`outcome_unknown` is reported as its own figure everywhere and never folded
into `failed`. They call for opposite responses: a failure can be retried, an
unknown outcome must not be.

### 2.9 Polling triggers (spec 1.4) — partial

Built: a durable, resumable page walk with external-id de-duplication. The
cursor is persisted **after** a page is fully processed, never before, so a
crash mid-page re-processes rather than steps over leads.

Not built: the incremental "modified since" query. See §4.

---

## 3. Defects found and fixed during this work

Both were mine, caught by testing rather than by review:

1. **Over-broad ledger reconciliation.** The first lease-recovery
   implementation marked *any* `queued` send record older than `now` as
   `outcome_unknown`, across all organisations — including records a live
   worker legitimately owned and had not yet marked sent. It would have
   converted healthy in-flight sends into permanent unresolvable rows. Now the
   abandoned steps are read first and only their matching records are touched.

2. **Incomplete concurrency test.** The first duplicate-send test bypassed the
   real claim path and failed. It was testing one gate while the code had
   three. Rewritten as three separate tests, which is what surfaced that the
   send-record gate holds even when the scheduler-level checks have been
   defeated.

---

## 4. What was NOT implemented, and what is needed

### 4.1 WhatsApp provider call

Needed, none substitutable by inference:

1. **Which BSP.** Meta Cloud API direct, Twilio, 360dialog and Gupshup differ
   in endpoint, payload, webhook format and error taxonomy.
2. **Current messages endpoint contract and version**, including the exact
   template component structure for the templates already approved.
3. **Current per-conversation pricing categories** — these determine what a
   step costs and whether it should be sent at all.
4. **Confirmation of Meta Business verification and template approval status**,
   without which every send is rejected regardless of code.

A wrong implementation here does not merely fail: sending outside the customer
service window or with an unapproved template risks the business account being
restricted.

### 4.2 Incremental CRM polling window

The specification asks for a time window with a slight overlap. That is the
right design — it is the difference between reading the pages that changed and
re-walking an entire contact list. It was not built because no connector in
this repository exposes a date-filtered contact query, and the endpoints that
would provide one are not the endpoints currently in use.

Needed:

1. Current HighLevel contact-search documentation: endpoint, date filter field,
   and whether it filters on created or modified time.
2. Current HubSpot CRM search documentation for the `lastmodifieddate` filter,
   including its pagination limits, which differ from the list API.
3. Confirmation of each provider's timestamp semantics — whether the value is
   modification time or indexing time. The two diverge under load, and an
   overlap window sized for the wrong one drops records.

Until then the poll runs correctly but reads more than it needs to.
`MAX_PAGES_PER_RUN` bounds the cost.

### 4.3 Provider callback signature verification

Twilio signs with `X-Twilio-Signature` over the URL and POST parameters using
the account auth token; SendGrid signs with an ECDSA header against a
per-account public key. **Neither is implemented.** Both keys are
per-organisation and encrypted, and the organisation is not known until after
the lookup that the signature is meant to authenticate.

Interim control: callbacks only act on identifiers already present in the
ledger and only move a send along its own status track. An attacker who guesses
a message SID can mark a message delivered or failed; they cannot cause a send,
read an address, or reach another tenant.

This must close before callbacks are relied on for billing or compliance
evidence. Resolving it needs a design decision — most likely a per-organisation
callback path segment so the tenant is known before verification.

### 4.4 Reply detection

Phase 1 has no inbound message handling, so replies and conversions are **not**
detected automatically. `POST /sequences/enrolments/:id/exit` is the only
honest mechanism, driven by the operator's own systems. Automatic reply
detection depends on the Phase 3 unified inbox, where inbound arrival becomes
an enrolment exit condition.

### 4.5 Client UI

No client-side interface was built for sequences. The API is complete; the
React app has no pages for it.

---

## 5. What is unverified, and why it matters

**No database was available in the build environment.** `mongodb-memory-server`
downloads its binary from `fastdl.mongodb.org`, which is not in the network
allowlist. Consequences:

- **The acceptance test named in spec 1.2 — kill the process mid-wait, restart,
  the step still fires — has not been executed against MongoDB.** It is proved
  against an in-memory implementation of the same ports.
- The integration suite (`npm run test:integration`) did not run.
- No index in this work has been created or exercised. The unique indexes on
  `SendRecord` and `ScheduledStep` are the mechanism of duplicate-send
  prevention; **if either fails to build, the guarantee is silently absent.**
  Confirm with `db.sendrecords.getIndexes()` before enabling the engine.

Mitigation: every decision lives in `stepRunner.ts`, written against injectable
ports and exercised by an in-memory store, so the *algorithm* is proved
deterministically. `mongoPorts.ts` is a thin translation with no branching logic
of its own. But a translation error — a wrong predicate in `claimDueStep`, a
missing filter in the reservation upsert — would not have been caught here.
**This is the highest-risk gap in the work.**

**SendGrid and Twilio dispatch was written from working knowledge, not from
documentation.** Both are marked `unverified` in the identities API, following
the capability model's rule that absence of evidence resolves to `unverified`
and never to `available`. Verify request shape, error taxonomy and current
pricing against live documentation before enabling.

**No message has been sent.** No SMTP server, no provider credentials, no
telephony number and no CRM account were available. Every send path in this
work is unexercised against a real provider.

---

## 6. External approvals to request now

These cannot be shortened by writing code, and Phase 1 will finish and sit idle
without them:

| Item | Gate | Blocks |
|---|---|---|
| Meta Business verification + BSP onboarding + template approval | Weeks | WhatsApp (1.10) |
| India DLT registration, TRAI/DND compliance | Weeks | All SMS to Indian numbers |
| Telephony number provisioning | Weeks | SMS, and Phase 5 voice |
| Sending domain warm-up, SPF/DKIM/DMARC | Days to weeks | Email deliverability |

Start all four in parallel with Phase 2.

---

## 7. Gate status

| Gate | Result |
|---|---|
| `npm run guardrails` | passing — see §8 |
| `npm run lint:security` | 0 findings |
| `npm run typecheck` | 0 errors, both apps |
| `npm run test` | passing — see §8 |
| `npm run build` | passing, both apps |
| `npm run test:integration` | **not run** — no MongoDB available |

## 8. Baseline movement

| Metric | Before | After |
|---|---|---|
| Repository guardrail files | 274 | 300 |
| Tenant-isolation exceptions | 33 | 39 |
| Server test files / tests | 28 / 159 | 31 / 208 |
| Client test files / tests | 2 / 6 | 2 / 6 |
| ESLint security findings | 4 | 0 |

The six new tenant-isolation exceptions are, with a written reason each as the
guard requires:

- Four in `services/sequences/mongoPorts.ts` — the cross-tenant scheduler
  sweeps: lease recovery (three) and the due-step claim (one). A scheduler that
  constrained by organisation could only ever serve one tenant.
- Two in `routes/messaging.ts` — the public unsubscribe lookup and the Twilio
  status callback. Both are unauthenticated by necessity: a recipient clicking
  an unsubscribe link and a provider posting a delivery event have no session.
  In each case the organisation is *derived from* the matched record rather
  than accepted from the caller, which is the same pattern the existing public
  webhook ingress uses.

All seven new tenant-owned models — `Sequence`, `SequenceVersion`,
`SequenceEnrolment`, `ScheduledStep`, `SendRecord`, `SuppressionEntry`,
`MessagingIdentity` — are registered in **both** `scripts/repository-guardrails.mjs`
and `scripts/tenant-isolation-guard.mjs`, and in the `dataLifecycle` export and
erasure registry.

---

## 9. Before enabling in production

`SEQUENCE_ENGINE_ENABLED` defaults to `false`. Turning it on starts sending
messages to real people under the operator's own domain. Do not turn it on
until the gates in `docs/LIVE_ACCEPTANCE.md` for the sequence engine have been
executed against live infrastructure.

Every line of this work was written without a running database and without live
provider credentials. For this subsystem that matters more than for most: if
the durable wait has a bug, ten thousand leads sit silently and the customer
finds out a week later.
