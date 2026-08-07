# Remediation 2.6 — CRM completion

Closes the gaps found in a Phase 2 audit. All five items raised are addressed;
one remains outstanding.

## Why this exists

Phases 2 through 5 each recorded gaps honestly and then moved on. Honesty about
a gap is not the same as fixing it, and the CRM in particular was left with the
hard parts built and the ordinary CRUD missing — a state where a small business
could not have run on it.

## What was closed

### Deal CRUD

Deals could be created and moved between stages, and nothing else. Now list,
fetch, edit and delete.

`stageId` is deliberately **not** editable through `PATCH /deals/:id`, and the
route refuses it explicitly. A stage change fires sequence triggers, raises
tasks and writes a timeline entry, all inside `moveDeal`. Allowing it through a
generic patch would bypass every one of them and leave a deal in a stage whose
automation never ran — a silent failure nobody would attribute to the edit.

Deleting a deal keeps the timeline entry. "This existed and was deleted" is more
useful than a gap.

### Saved segments made executable

Segments could be created and listed but never run. As shipped, saving one
accomplished nothing. Now: run, recount, edit, delete.

Compiled at read time from the stored condition tree, never cached. A segment is
a live question, and a cached answer returns contacts who no longer qualify —
which, for a segment used to choose who gets messaged, is the wrong kind of
wrong. Recompiling also means a segment referencing a since-deleted custom field
fails loudly instead of silently matching nothing.

Editing revalidates and clears the cached count, so a segment cannot be saved
into a state that only fails when someone tries to use it.

### Task and appointment editing

Neither could be edited — an appointment could not be rescheduled at all.

Both revalidate the whole record rather than the changed fields, so a partial
edit cannot produce something that would have been rejected on creation.
Rescheduling recomputes conflicts **excluding the appointment itself**; without
that exclusion every reschedule reports a conflict with itself.

### Contact archive and delete

`archivedAt` was filtered on but never set.

Archive is reversible and exits active enrolments — an archived contact still
receiving automated follow-up is the exact failure archiving was meant to stop.

Permanent deletion requires `?confirm=permanent` and removes notes, activity,
deals, tasks, appointments and enrolments. **Suppression entries are retained**,
and the audit record says so explicitly. Deleting the record that says "this
person asked us to stop" would silently re-permit contact if they ever re-enter
the system.

### CSV import

Follows the preview-and-approve pattern the specification asks for: suggest a
mapping, preview every row, approve, apply.

It does **not** route through `batchService`, and that is a deliberate
deviation. Every operation that service knows about ends in a call to an
external provider, and its machinery is built around remote-call semantics —
lease stages named `remote_started`, `outcome_unknown` for calls that may have
happened. A local insert has none of those properties, and adding a fake
provider whose executor writes locally would make the batch code harder to
reason about for everyone.

Notable behaviours:

- Duplicates **within the file** are caught. Two rows for the same person would
  otherwise become a create then an update, with the last row silently winning.
- Custom fields are non-strict: an unrecognised column is reported, not fatal. A
  supplier's export is not the operator's to control, and losing 500 leads over
  one stray column is the wrong trade.
- Updates merge custom fields rather than replacing them, so an import cannot
  erase values the spreadsheet had no column for.
- Every import response states that imported contacts **carry no consent
  record**. A spreadsheet is not a lawful basis for contacting anyone on it.

### Payments

Per-organisation Stripe credentials, following the `MessagingIdentity` pattern:
encrypted, per-record AAD, never selected by default.

**The separation is the point.** Platform billing uses the platform's Stripe
account via `env.STRIPE_SECRET_KEY`. Customer payments use each operator's own
account. Nothing in `services/crm/payments.ts` reads the platform key, and there
are two guards — at storage and at use — that refuse it outright. If the
platform key were ever used for a customer payment link, the operator's customer
would pay the platform, and the money would land in the wrong bank account.

Checkout Sessions with inline price data rather than reusable Price objects,
because these are ad-hoc amounts and a permanent Price per invoice would fill an
operator's Stripe account with single-use products.

`markPaymentReceived` is idempotent by status, so a redelivered webhook cannot
double a contact's revenue. **This is what finally makes
`Contact.revenueMinorUnits` mean something** — it was present and always zero
until now.

**Stripe Connect was not chosen**, and that is a business decision rather than a
technical one: Connect makes the platform a payment facilitator with onboarding,
KYC and liability obligations. The per-organisation key approach keeps the
platform out of the money flow entirely and does not preclude adding Connect
later behind the same interface.

## Defect found

**Single-word CSV headers did not map.** `lastname` normalises to `lastname`
while the field `lastName` normalises to `last_name`, so they never met. Since
`firstname`, `lastname` and `companyname` are among the most common headers in a
real export, a large fraction of imports would have silently dropped names.

Same root cause as a defect found in Phase 2 — a snake_case normaliser cannot
know a run-together word is two words. Fixed by listing the single-word forms
explicitly.

## Still outstanding

**File attachments on the contact view (spec 2.2).** Not built. The artifact
store already exists, so this is mostly wiring, but it was not done here.

**PayPal.** The specification says "PayPal second". Only Stripe is implemented.

**Payment webhooks.** `markPaymentReceived` exists and is idempotent, but no
endpoint receives Stripe's `checkout.session.completed`. Payments must currently
be reconciled manually via `POST /payments/links/:id/mark-paid`. Wiring the
webhook needs a per-organisation signing secret and the same tenant-resolution
problem recorded in `REMEDIATION_2_0.md` §4.3.

## Gate status

| Gate | Result |
|---|---|
| `npm run guardrails` | passing, 368 files |
| `npm run lint:security` | 0 findings |
| `npm run typecheck` | 0 errors, both apps |
| `npm run test` | 39 files / 351 tests server, 2 / 6 client — passing |
| `npm run build` | passing, both apps |
| `npm run test:integration` | **not run** — no MongoDB available |

Unverified as ever: no index created, no import run against real data, no Stripe
call made. The payment path in particular has never been exercised — a wrong
assumption there moves real money.
