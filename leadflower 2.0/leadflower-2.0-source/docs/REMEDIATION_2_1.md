# Remediation 2.1 — Phase 2: contact store and micro-CRM core

Base: Phase 1 as recorded in `REMEDIATION_2_0.md`.
Scope: **Phase 2 only.** Phases 3–5 were not started.

Phase 1 is code-complete and green, but **not signed off**: its live acceptance
gates require a running database and provider credentials that were not
available. Phase 2 was started because the remaining Phase 1 gaps are gated on
external inputs — a BSP choice, provider documentation, a design decision on
callback paths — and none of them unblock by writing more Phase 1 code. The
same caveat therefore applies to everything below.

---

## 1. What was built

### 1.1 Custom field definitions (spec 2.1)

The rule the specification calls out — *do not allow arbitrary keys without a
definition* — is enforced in `services/crm/customFields.ts`.

Keys are normalised to snake_case, so "Preferred Contact Time",
`preferredContactTime` and `preferred_contact_time` converge on one field
instead of becoming three. Keys that would collide with a built-in Contact
field are refused: a custom field named `email` that is not the contact's email
address makes every segment and merge tag ambiguous.

Eleven declared types, each with coercion tuned to what an import and a
hand-typed form actually produce — `" 1,234 "` parses as a number, `Yes`/`y`/`1`
as a boolean. `url` accepts http and https only, because a stored
`javascript:` URL becomes XSS the moment any surface renders it as a link.

Two enforcement modes, and the difference matters:

- **Operator writes** (API, forms) are strict. An undefined key is an error,
  because silently dropping data someone typed is worse than refusing it.
- **Inbound CRM sync** is not. The external system's field set is not the
  operator's to control, and refusing a whole lead over a field nobody asked
  for is the wrong trade. Undefined keys are reported and not stored.

Field **type** and **key** are immutable after creation. Reinterpreting stored
values under a new type corrupts data that still looks fine — `"12/03"` reads
differently as a date and as a string — and renaming a key orphans every stored
value and every segment referencing it.

### 1.2 Search, filtering and saved segments (spec 2.1)

A weighted text index over name, company and email, plus filter indexes on
lifecycle status, owner and last activity.

`services/crm/segments.ts` compiles a **structured condition tree** into a Mongo
query. A client never supplies a query fragment. Passing one to the driver hands
the caller `$where` and `$function` (server-side JavaScript), `$expr`, an
unbounded `$regex`, and `$lookup` into other tenants' collections. No sanitiser
reliably closes all of those; not opening them is the only durable answer.

So: field names resolve against an allow-list, operators against a fixed set
constrained by field type, and every value is coerced. `organizationId` is
absent from the filterable field list, so no condition can name it, widen it, or
wrap it in an `$or` that makes it optional — tested.

User text is escaped into a literal before reaching `RegExp`, so a segment
filtering on `.*` matches the literal string, not every record.

### 1.3 Single contact view (spec 2.2)

Assembled from the collections that own each part rather than denormalised, so
nothing can drift from the record it describes: message history across every
channel, notes, tags, sequence enrolments, deals, and a timeline.

`ContactActivity` is written alongside the operation it describes. Deriving a
timeline by querying six collections and merge-sorting them is a query that gets
slower every month and cannot be paginated coherently.

The timeline carries **no message bodies and no addresses** — only scalars, with
a forbidden-key filter. It is the surface most likely to be rendered somewhere
unescaped, and duplicating content onto it doubles the redaction and retention
surface for no gain. It also never throws into its caller: a timeline write
failing must not roll back the send or stage change it describes.

### 1.4 Pipelines and deals (spec 2.3)

Stages are embedded, ordered, and each carries a **stable `stageId` generated
once and preserved across every edit**. Deriving it from the name would mean
renaming "Quoted" to "Proposal Sent" orphans every deal in it and silently
breaks any sequence trigger bound to it.

**Stage changes are triggers for the enrolment engine** — the join between the
CRM and Phase 1. A stage may name a sequence to enrol into and one to exit.
Exits are applied before enrolments, so a stage that stops nurturing and starts
chasing does not briefly have the contact in both.

`moveDeal` writes the stage change first, with a compare-and-swap on the current
stage, and only then touches sequences. If enrolment fails after the write the
deal is in the right stage and can be retried; the inverse order leaves a
contact being chased about a stage the deal is not in. Two operators dragging
the same card produce one move and an explicit 409, not a silent overwrite.

Removing a stage that still holds deals is refused rather than allowed, because
deals pointing at a stage that no longer exists vanish from every board.

Values are held in **minor units with an explicit currency**. Floating-point
currency arithmetic loses fractions, and a pipeline total a few cents out is one
nobody trusts. Board totals are scoped to the returned page and flagged
`truncated` — a total that silently covers the first 50 of 400 deals is worse
than none.

### 1.5 Hosted forms (spec 2.4)

This is what makes a Type B customer independent of any external CRM: the lead
originates here rather than being pulled from elsewhere.

The submission endpoint is public and unauthenticated by necessity, which makes
it the widest attack surface in Phase 2. Controls:

- Addressed by an 18-byte random slug, not the document id, so the estate cannot
  be enumerated.
- The organisation is derived from the matched form. Nothing in the request body
  selects a tenant.
- **Only declared fields are read.** Extra keys are ignored, not stored, so the
  endpoint cannot write contact data the form never asked for or custom fields
  the operator never defined.
- Optional origin allow-list, per-IP rate limiting.
- The response is identical whether a contact was created or updated. Telling a
  submitter "you already exist here" is an account-enumeration oracle.

Consent wording is **copied onto each submission, not referenced**. A later edit
to the form must not rewrite what past submitters agreed to; the wording at the
time is the evidence a consent challenge actually asks for.

---

## 2. Defects found during this work

All three surfaced from tests, and one was a real code defect:

1. **Substring operators wrongly type-coerced.** `starts_with "jane"` on an
   email field was rejected, because the fragment was validated as a whole email
   address. This would have made the most obviously useful filter on the field
   impossible. Substring operators are now exempt from type coercion and instead
   length-bounded and escaped.

2. **A test that asserted the wrong thing about normalisation.** `headCount` and
   `headcount` are genuinely different keys to a snake_case normaliser — it
   reads the first as two words and cannot know the second is one. The behaviour
   is correct; the test was wrong, and the corrected test now documents why.

3. **A prototype-pollution test that could not fail.** `{ __proto__: 'x' }` in
   source sets the prototype and creates no own property, so `Object.entries`
   never sees it. The actual threat vector is a parsed JSON request body, which
   does create a real own key. The test now uses `JSON.parse`, which is what the
   guard is actually defending against.

---

## 3. What was NOT implemented

### 3.1 Payments (spec 2.5)

**Not started.** Stripe payment links per contact, and PayPal after.

The `PaymentLink` model is defined and carries the one structural decision that
matters: the organisation's own Stripe account collects these payments, while
the platform's account collects subscription revenue. Different accounts,
different keys, different webhooks. Nothing in the model or any future service
for it may read `env.STRIPE_SECRET_KEY` — sharing configuration between the two
would let a bug in one charge customers through the other.

To build it: Stripe Connect onboarding for the operator's account, or per-
organisation encrypted API keys following the `MessagingIdentity` pattern
already established in Phase 1. That is a product decision (who bears the
Stripe relationship) as much as a technical one, and it should be made before
code is written.

### 3.2 CSV import through the batch machinery (spec 2.1)

**Not started.** The specification calls for reusing the existing batch
preview-and-approve machinery, which is the right call — it already handles
streaming, chunked inserts, dedupe keys and an approve-before-execute gate
safely.

What is missing is the join: a batch operation that maps CSV columns onto
contact fields and custom field keys, validates each row through
`applyCustomFields`, and reports per-row failures in the existing preview.
`batchService` currently canonicalises operations against external connector
providers; a local `contact.import` operation would need adding to that map.

### 3.3 Client UI

No React interface was built for any of Phase 2. The API is complete for
everything in §1; the kanban board, contact view and segment builder described
in the specification exist only as endpoints. Section 7's PWA work has not
started.

### 3.4 Contact merge

`services/dedupe` already plans merges against external providers. Merging two
*local* contacts — which Phase 2 makes possible by letting contacts originate
locally — is not implemented, and the `contact.merged` activity type is
therefore currently unused.

---

## 4. What is unverified

The same overriding caveat as Phase 1: **no database was available**, so no
index in this work has been created or exercised, and no route has been executed
against a real request.

Specifically unverified:

- The weighted text index on `Contact`. If it fails to build, `$text` search
  returns nothing rather than erroring, which reads as "no matching contacts"
  and would be mistaken for correct behaviour.
- The unique indexes on `CustomFieldDefinition`, `Pipeline`, `SavedSegment` and
  `HostedForm`. Each backs a duplicate-name 409 that will not fire without it.
- Every compiled segment query. The compiler is tested; whether the queries it
  emits return what an operator expects has not been observed against data.
- The compare-and-swap in `moveDeal` under real concurrency.
- The public form submission path end to end.

The logic is tested where it is pure — 60 new tests over field validation,
segment compilation and stage canonicalisation, including the injection attempts
the compiler exists to refuse. The persistence is not.

---

## 5. Gate status

| Gate | Result |
|---|---|
| `npm run guardrails` | passing, 318 files |
| `npm run lint:security` | 0 findings |
| `npm run typecheck` | 0 errors, both apps |
| `npm run test` | 33 files / 245 tests server, 2 / 6 client — passing |
| `npm run build` | passing, both apps |
| `npm run test:integration` | **not run** — no MongoDB available |

### Baseline movement

| Metric | After Phase 1 | After Phase 2 |
|---|---|---|
| Repository guardrail files | 300 | 318 |
| Tenant-isolation exceptions | 39 | 41 |
| Server test files / tests | 31 / 208 | 33 / 245 |

The two new tenant-isolation exceptions are both in `routes/forms.ts`: the
public form fetch and the public submission. Both are unauthenticated by
necessity — a form is embedded on the customer's own site and its submitters
have no session — and in both the organisation is *derived from* the matched
form rather than accepted from the caller.

All nine new tenant-owned models — `CustomFieldDefinition`, `ContactNote`,
`ContactActivity`, `Pipeline`, `Deal`, `SavedSegment`, `HostedForm`,
`FormSubmission`, `PaymentLink` — are registered in **both** guardrail scripts.

One ESLint suppression was added, in `services/crm/segments.ts`, for the dynamic
`RegExp`. It carries a written justification and two stated preconditions
(metacharacter escaping, length bounding); if either is removed the suppression
must go with it.

---

## 6. Data lifecycle registration

All nine Phase 2 models are registered in the `TENANT_MODELS` registry in
`services/dataLifecycle.ts`, so an organisation erasure removes them and the
export includes them.

They were nearly left out on the grounds that `FormSubmission` carries consent
evidence and `ContactActivity` carries an audit-adjacent timeline, and that
whether either has a retention obligation outliving the organisation is a
question for counsel. That reasoning is sound but the default it implied was
wrong: leaving nine collections of personal data behind after a deletion request
is the same failure as not honouring the request, and the reverse default
retains personal data on a guess. Deletion is the default; if counsel determines
that consent evidence must survive, that becomes an explicit, documented
carve-out — which is a much easier position to defend than the inverse.

**Open question for counsel:** does evidence of consent (the wording shown, the
timestamp, the submitting address) need to survive erasure of the controller
that collected it? If yes, `form_submissions` needs a carve-out equivalent to
the one `suppression_entries` has in `retention.ts`, and the carve-out should
retain the consent fields only, not the submitted values.
