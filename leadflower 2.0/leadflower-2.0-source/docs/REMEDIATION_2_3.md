# Remediation 2.3 — Phase 3: unified inbox and industry snapshots

Base: Phase 2.5 as recorded in `REMEDIATION_2_2.md`.
Scope: **Phase 3 only.** Phases 4 and 5 were not started.

Phases 1, 2 and 2.5 remain code-complete and green but **not signed off**: their
live acceptance gates need a running database and provider credentials that have
never been available in this environment. That caveat governs everything below
too, and §4 states what it means specifically.

---

## 1. What was built

### 1.1 The reply exit condition (spec 3.1)

The specification calls this *"the single most important interaction between
inbox and sequences"*, and it is the reason Phase 3 matters to work already
shipped. Until now an inbound reply could only stop a sequence through an
explicit API call from the operator's own systems. It is now automatic:
**an inbound message on any channel exits every active enrolment for that
contact.**

The failure this closes is not cosmetic. It is a person answering a question and
then being chased three more times by a machine that did not notice — the single
most damaging thing an automated follow-up system does to a relationship.

Ingestion is idempotent by provider message id, with a partial unique index.
Providers retry webhooks; without idempotence a redelivery both duplicates the
thread and re-fires the exit.

Order of operations, and why: the message is written **before** the exit fires.
A crash between them leaves a visible message with sequences still running —
recoverable, and obvious to anyone looking at the thread. The reverse order
exits sequences with no record of why.

### 1.2 Unified inbox (spec 3.1)

`Conversation` is **one thread per contact, not per channel.** A small business
owner does not think "the SMS thread with Priya" and "the email thread with
Priya"; they think about Priya. Splitting by channel also means a WhatsApp reply
does not visibly answer a question asked over email.

`Message` is distinct from `SendRecord` on purpose. `SendRecord` is the delivery
ledger whose unique index is the duplicate-send guard; `Message` is the
human-readable thread and covers inbound traffic that has no send record at all.
An outbound sequence send produces both, linked by `sendRecordId`.

**Message bodies are encrypted at rest** with a per-record, per-field AAD. §4.3
requires technical controls suitable for handling health information, and a
message log is where sensitive content actually accumulates — a clinic's inbox
will contain symptoms whatever the product intends. The AAD binds each
ciphertext to its own record and field, so a body cannot be relabelled as a
subject or swapped between messages.

The conversation **list decrypts nothing.** It renders from stored previews.
That is the most frequently loaded view in the product, and decrypting every
latest message to draw it would be both slow and a needless widening of where
plaintext appears.

Opening a thread is **audited**. In a clinic or a legal practice, "who read this
conversation" is a question that gets asked and cannot be answered
retrospectively.

Human replies from the inbox are **subject to suppression**. Someone who
unsubscribed has not consented to be messaged because an operator typed it by
hand rather than a scheduler sending it.

### 1.3 Inbound channels (spec 3.1)

- **Twilio inbound SMS** — implemented.
- **SendGrid inbound parse** for email — implemented, taking the plain-text
  part. Storing raw HTML would mean every surface rendering a thread has to
  sanitise it correctly, forever.
- **WhatsApp inbound** — not implemented, consistent with Phase 1: the provider
  contract is unverified.
- **Web chat widget** — not implemented. See §3.1.

The receiving number or address is the tenant key. It is the operator's own
provisioned number, recorded on a `MessagingIdentity`, and the organisation is
derived from it rather than accepted from the request body — which is what stops
an unauthenticated endpoint being a cross-tenant write. A number matching no
identity resolves to nothing and the message is dropped, never to a default.

**Contacts are matched, never created.** An inbound webhook is unauthenticated;
auto-creating records from one turns the endpoint into a way for anyone to write
into a customer's CRM. Unmatched messages are logged and dropped.

**Opt-out keywords** (STOP, UNSUBSCRIBE, CANCEL and the standard set) are
recognised on SMS and WhatsApp and feed suppression. Matched on the **whole
trimmed message only**: "stop by the shop tomorrow" is a conversation, and
treating it as an opt-out silently loses a customer.

### 1.4 Missed-call text back (spec 3.2)

A missed call is the highest-intent signal a small business gets and the one
most often lost. Implemented against the Twilio voice status callback, with
three constraints:

- **Suppression first.** Ringing does not make a suppressed number contactable
  again.
- **Quiet hours respected — and the step is SKIPPED, not deferred.** This
  differs deliberately from sequence steps. A sequence step deferred overnight
  still makes sense in the morning; an automated "sorry we missed your call"
  arriving nine hours later is confusing, and by then a human should handle it.
  The skip is recorded on the timeline so the operator can see it happened.
- **Only genuine no-answers.** `completed` is not a missed call, and texting
  someone you just spoke to reads as automation nobody is minding.

Disabled by default per organisation: enabling it sends automated SMS under the
operator's own number and at their cost.

### 1.5 Industry snapshots (spec 3.3)

A snapshot is **configuration data, not code** — validated JSON in
`services/snapshots/definitions/`, loaded at runtime. Adding a vertical is
dropping a file in that directory. There is no code path per industry, because
that is how "supports 12 industries" becomes twelve half-maintained special
cases.

Three shipped: **Trades**, **Healthcare and wellness**, **Professional
services**, each with custom fields, a pipeline with stage task templates,
sequence templates and a form template.

Applying is **additive and idempotent by name.** Anything that already exists is
left exactly as the operator has it and reported as skipped. `source:
'snapshot:<id>'` is provenance, not ownership — a snapshot seeds, it does not
manage, and nothing here would let a later update overwrite an operator's edits.

Sequences and forms are created as **drafts**. A snapshot must not start
messaging real people, or expose a public endpoint, the moment an onboarding
wizard finishes.

**Compliance-claim guard.** A snapshot is data, which makes it the easiest place
for a marketing claim to reach a customer without passing code review — and the
Healthcare snapshot is precisely where someone will eventually write
"HIPAA-compliant intake form". `assertNoComplianceClaims` runs at load and fails
the build. Every shipped snapshot is checked by test, and the acceptable-phrasing
case is tested too, so the guard cannot be satisfied by removing all discussion
of the subject.

The Healthcare snapshot's operator notes state plainly that the software
provides *technical privacy controls suitable for handling health information*
and does **not** make a practice compliant with any health privacy regime. Its
templates carry no clinical detail — asserted by test — because SMS and email
are not confidential channels and a reminder naming a procedure discloses it to
anyone who sees the phone screen.

---

## 2. Defects found and fixed during this work

1. **A ReDoS-prone regex in the compliance guard.** The first version used an
   alternation with adjacent `\s*` and `[\s-]*` quantifiers, flagged by
   `security/detect-unsafe-regex`. It ran against an entire serialised
   snapshot — exactly the input size that makes such a pattern dangerous. It was
   **removed rather than suppressed**: the check now normalises the text and
   uses substring matching, which has no backtracking behaviour and reads
   better.

2. **Snapshot JSON would have been absent from production builds.** `tsc` emits
   only what it compiles, so `dist` would have contained no snapshot
   definitions and `loadSnapshots()` would have found an empty directory. The
   failure is silent — an operator sees an onboarding wizard offering zero
   verticals with no reason to suspect a build step. A `copy-assets` step now
   copies them and **exits non-zero if it finds none**.

---

## 3. What was NOT implemented

### 3.1 Web chat widget

**Not built.** The `webchat` channel exists in the data model and the inbox will
display such messages, but there is no widget and no transport.

A web chat widget is a public, unauthenticated, stateful, cross-origin
JavaScript artefact embedded on customer sites. It needs a session model that is
not a contact (the visitor is anonymous until they identify themselves), a
real-time transport, and its own abuse controls. That is a piece of work
comparable to the hosted form system, not an afternoon, and it did not fit in
this phase honestly.

### 3.2 WhatsApp inbound

**Not built**, consistent with Phase 1. The same four inputs are still needed
(see `REMEDIATION_2_0.md` §4.1): BSP choice, current endpoint contract, current
per-conversation pricing, and Meta Business verification status.

Note that WhatsApp inbound also gates the **24-hour session window**, which is
already modelled in `services/sequences/channels.ts` but has nothing to feed it:
`whatsappSessionMode` needs a `lastInboundAt` that only inbound ingestion can
supply.

### 3.3 Inbound webhook signature verification

**Still not implemented**, and now more consequential than it was in Phase 1.
The status callbacks covered in `REMEDIATION_2_0.md` §4.3 only *update* existing
records. These new endpoints **write**: a forged request could insert a message
into a thread and exit that contact's sequences.

What it cannot do: create a contact (matching only), reach a tenant whose
provisioned number it does not know, or cause an outbound send — except through
missed-call text back, which is disabled by default and gated on suppression and
quiet hours.

This should now be the **first thing closed** before any customer relies on
inbound. The likely design remains a per-organisation path segment so the tenant
is known before verification.

### 3.4 Snooze expiry

A conversation can be snoozed with a `snoozedUntil`, but nothing wakes it. There
is no worker returning snoozed threads to `open` when their time passes. It is a
small addition to the existing recurring-maintenance pattern and was left out
rather than half-wired.

### 3.5 Onboarding wizard

Spec 3.3 says snapshots are *"applied at onboarding by a wizard"*. The
**apply endpoint** exists and is complete. The wizard is UI, and there is still
no client for any of Phases 1–3.

---

## 4. What is unverified

**No database, as in every prior phase.** Specific to this one:

- The partial unique index on `(organizationId, channel, providerMessageId)` is
  what makes ingestion idempotent. If it fails to build, **a provider redelivery
  duplicates the thread entry and re-fires the reply exit** — and the failure
  mode is a duplicated message, which reads as a provider quirk rather than a
  missing index. Confirm with `db.messages.getIndexes()`.
- The unique index on `(organizationId, contactId)` for conversations backs the
  upsert that creates a thread. Without it, concurrent inbound messages create
  two threads for one contact.
- **No message has ever been encrypted and decrypted through this path against a
  real record.** The AAD construction is unit-tested for distinctness; the
  round-trip through Mongo is not.
- No inbound webhook has been received. The Twilio and SendGrid payload field
  names (`From`, `To`, `Body`, `MessageSid`; `from`, `to`, `text`, `subject`)
  are written from working knowledge, not from documentation open in front of
  the author — the same caveat that applies to the outbound calls in Phase 1.
  **A wrong field name here means inbound silently never matches**, which looks
  identical to "no one has replied yet".
- No snapshot has been applied to a real organisation.

13 new tests cover opt-out keyword boundaries, missed-call status
classification, AAD distinctness, snapshot loading and validation, the
compliance guard in both directions, and that every shipped snapshot's data
satisfies the same validators the API applies.

---

## 5. Gate status

| Gate | Result |
|---|---|
| `npm run guardrails` | passing, 337 files |
| `npm run lint:security` | 0 findings |
| `npm run typecheck` | 0 errors, both apps |
| `npm run test` | 35 files / 281 tests server, 2 / 6 client — passing |
| `npm run build` | passing, both apps, snapshot assets copied |
| `npm run test:integration` | **not run** — no MongoDB available |

### Baseline movement

| Metric | After Phase 2.5 | After Phase 3 |
|---|---|---|
| Repository guardrail files | 325 | 337 |
| Tenant-isolation exceptions | 41 | 43 |
| Server test files / tests | 34 / 268 | 35 / 281 |

The two new tenant-isolation exceptions are both in `routes/messaging.ts`: the
inbound number lookup and the inbound address lookup. Both are the same pattern
as the existing public webhook ingress — the operator's own provisioned number
or address is the tenant key, and the organisation is derived from the matched
identity rather than accepted from the caller.

`Conversation` and `Message` are registered in both guardrail scripts and in the
`dataLifecycle` erasure registry.

One ESLint configuration change: `server/scripts/**/*.mjs` was added to the
existing files glob so build-time Node scripts get the same ruleset as the rest
of the repository. This does not loosen any rule that was previously applied to
existing code.

---

## 6. Live acceptance additions

- [ ] `db.messages.getIndexes()` shows the partial unique index on
      `(organizationId, channel, providerMessageId)`. Redeliver a webhook and
      confirm exactly one thread entry and one exit.
- [ ] `db.conversations.getIndexes()` shows the unique index on
      `(organizationId, contactId)`.
- [ ] An inbound SMS from a known contact exits every active enrolment for that
      contact, and the thread shows the message.
- [ ] An inbound message from an **unknown** number creates nothing.
- [ ] A message body written and then read back through the inbox decrypts
      correctly, and a body cannot be read with another message's AAD.
- [ ] "STOP" creates a suppression entry; "stop by tomorrow" does not.
- [ ] A missed call during quiet hours sends nothing and records the skip.
- [ ] A missed call from a suppressed number sends nothing.
- [ ] Applying a snapshot twice creates nothing the second time and reports
      everything as skipped.
- [ ] Applying a snapshot over an existing pipeline of the same name leaves the
      operator's version untouched.
- [ ] **Inbound signature verification is closed** before any customer relies on
      inbound messages for anything contractual. This is now the highest-priority
      open security item, because these endpoints write.
