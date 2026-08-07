# Remediation 2.5 — Phase 5: AI voice

Base: Phase 4 as recorded in `REMEDIATION_2_4.md`.

**This is the final phase of the build specification. It is also the least
complete, and deliberately so.**

---

## 0. What was built, in one line

**The gates. Not the calls.**

Every regulatory control the specification demands — calling windows, DND
checking, consent basis, AI disclosure, recording consent, mid-call opt-out,
agent version pinning — is implemented and tested. **No call can be placed**,
because neither the telephony provider nor the conversational provider has a
verified contract.

That split follows §4.2 and §5.6 read together: *"do not assume [Call Fluent's]
request/response shape"* alongside *"regulatory controls — implement, do not
assume."* One says do not guess the integration; the other says build the
controls regardless. So the controls exist and refuse.

The specification's own framing of this phase — *"highest risk, most regulated,
most expensive to get wrong"* — is the reason the refusals are structural rather
than a to-do list.

---

## 1. What was built

### 1.1 Calling windows and jurisdiction policy (spec 5.5)

**There is no table of statutory calling hours in this codebase.** That is the
central decision in this phase and it deserves stating plainly.

Calling-time rules vary by country, by state, by whether the call is a
solicitation or one the recipient requested, and they change. A hardcoded
"08:00–21:00 because TCPA" would be asserted by software, relied on by an
operator, and wrong somewhere — and being *nearly* right about a calling-hours
rule is worse than having none, because it manufactures confidence.

Instead: a **conservative default** of 09:00–19:00 local, Monday to Saturday,
chosen to sit inside the narrowest window the author is aware of rather than to
match any particular regime. Widening it is permitted only with a recorded legal
review — name and date. **Software must not be the thing that decided 07:00
calls were acceptable.** Narrowing needs no review; a more cautious operator
needs no permission to be more cautious.

Overnight windows are rejected as configuration errors, because permitting one
would let a misconfiguration authorise 3am calls.

An unresolvable contact timezone **blocks the call**. For a message that is a
timing error; for a phone call it means dialling a stranger at an hour decided
by accident.

### 1.2 The dial gate chain (spec 5.5, 5.6)

Four gates: suppression, consent basis, DND registry, calling window.

**Every gate is evaluated and recorded, not short-circuited.** When a regulator
asks whether the do-not-call registry was consulted, "the call was blocked for a
different reason first" is not an answer.

**Fails closed throughout.** A suppression lookup that errors blocks the call. A
DND check that errors blocks the call.

**The default DND checker reports every number as registered**, so a dialer with
no registry access does not dial at all. This is the most important default in
the phase. A stub returning "not registered" would be the most dangerous
possible choice: it silently authorises exactly the calls the check exists to
prevent, and nothing would look wrong.

DND registry access cannot be inferred. India's DND and DLT scrubbing run
through a registered telemarketer relationship with an access provider, not a
public API. The US National DNC list needs a subscription and organisation
identifier. Both are commercial arrangements, not integrations.

**Deferral is only for timing.** Outside-window and blackout-date defer to the
next permitted instant. Consent, suppression and DND status never do — retrying
a DND-listed number on a schedule turns one misconfiguration into a pattern.

### 1.3 Agent configuration and version pinning (spec 5.2)

Agents are versioned and **pinned per call**, like `WorkflowVersion` and
`SequenceVersion`. It matters more here: after a complaint the question is "what
exactly did it say to them", and the answer must be a document nobody could have
edited since. `agentDefinitionHash` ties a recording to a script.

Prompt variables are an **allow-list**, not free path expressions. A prompt is
read aloud, and letting it address arbitrary paths would let an agent recite
whatever is on the contact record — internal custom fields, or in the healthcare
vertical, notes that must never be spoken down a phone line.

### 1.4 Regulatory disclosures (spec 5.6)

**AI disclosure is mandatory and cannot be blanked.** Several jurisdictions
require disclosing the caller is not human; in the rest, a person still deserves
to know.

**Recording defaults to off and cannot be enabled without a consent
announcement.** Whether recording is lawful at all turns on one-party versus
two-party consent rules this system cannot evaluate, so it refuses rather than
defaults.

Disclosures are assembled by `openingDisclosures()` rather than left inside the
agent's free-text prompt. A disclosure living in a prompt is one an operator can
edit away and a model can decline to say.

**Baseline opt-out phrases are merged in and cannot be removed by
configuration.** "Stop calling me" ends a call whether or not an operator
thought to list it.

### 1.5 Call records and retention (spec 5.4, 5.6)

Transcripts and AI summaries are **encrypted at rest** with per-record AADs. A
transcript is the most sensitive artefact this system produces: a verbatim
record of what someone said, captured without them typing it.

**Recordings are referenced, never copied.** The audio stays with the telephony
provider; duplicating it here would double the number of places a recording has
to be found and destroyed. `retainUntil` and `recordingDeletedAt` exist to drive
that destruction.

Sentiment is stored with its **source recorded** — a provider's opinion, never a
fact about how a person felt.

---

## 2. Defects found during this work

One real, and it is the kind that would have mattered.

**Opt-out detection could never match a contraction.** The utterance was
normalised by stripping non-letters — turning "don't" into "don t" — while the
configured phrases were only lowercased. So the baseline phrase `"don't call"`
could not match a caller saying "don't call again". Apostrophes are ubiquitous
in speech transcripts, and **the failure was silent: the call would simply
continue.**

Fixed by routing both sides through one normaliser. Any normalisation applied to
one side must be applied to the other, and a single function is the only way to
keep that true.

---

## 3. What was NOT implemented

### 3.1 Both provider layers

Telephony and conversation are **separate interfaces**, per the specification's
instruction not to couple them. Both refuse.

Keeping them separate matters practically: the day the client changes voice
vendor — likely, this is a young market — the telephony integration is rewritten
too, and the DND and calling-window logic would get rewritten alongside it. That
logic is the part that must not be touched casually.

**Telephony needs:** the provider choice, its outbound voice API contract, its
status callback format, its recording storage and deletion semantics, and
confirmation the numbers in use are registered for outbound calling in each
jurisdiction dialled.

**Conversation needs:** which provider (Call Fluent or an alternative), its
session initiation contract, its webhook or streaming format for turns and
in-call actions, its latency characteristics, and how it signals that a caller
spoke an opt-out phrase.

Twilio's voice API is better known but carries the same caveat already recorded
for its messaging API: written from working knowledge, not documentation. **For
voice the stakes differ in kind. A wrong messaging call fails. A wrong voice
call places a real call to a real person, and there is no unsend.**

### 3.2 In-call actions (spec 5.3)

Not implemented. The permitted-action list is validated and pinned per agent
version, but nothing executes.

The specification requires every in-call action be idempotent — a retried turn
must not double-book or double-charge. Building that without knowing how the
conversational provider signals a retried turn would be building against an
imagined failure mode. The idempotency design has to follow the provider's
actual turn semantics.

### 3.3 The dialer worker

`DialerJob` exists with its lease fields and unique constraint; no worker drains
it. A worker whose every iteration evaluates four gates and then hits an
unimplemented provider would produce failure records at volume with no
information in them.

### 3.4 Speed-to-lead triggering

Not wired. The trigger points exist (form submission, stage change), but
connecting them to a dialer that cannot dial would create queued jobs that
accumulate and expire.

### 3.5 Analytics beyond the data model

Duration, outcome tags, transcript and summary have fields and encryption. No
computation, because there is nothing to compute over.

---

## 4. What is unverified

Everything about voice, more so than any prior phase. **No call has been placed.
No transcript has been written. No DND registry has been contacted.**

The gate logic is pure and thoroughly tested — 29 tests covering window
evaluation, timezone refusal, unreviewed-window refusal, fail-closed behaviour
on every gate, deferral classification, disclosure assembly and opt-out
detection including the contraction case. That is the part worth testing and it
is tested.

But note what tests cannot establish here: **whether the conservative default
window is actually lawful in any given jurisdiction.** That is a question for
counsel, and the code is arranged so counsel's answer gets recorded rather than
assumed.

### Specifically unverified

- The partial unique index on `DialerJob` preventing double-dialling.
- Transcript encryption round-trip through Mongo.
- Whether any telephony number in use is registered for outbound calling.
- Whether the operator has any lawful basis for automated calling at all.

---

## 5. Gate status

| Gate | Result |
|---|---|
| `npm run guardrails` | passing, 360 files |
| `npm run lint:security` | 0 findings |
| `npm run typecheck` | 0 errors, both apps |
| `npm run test` | 37 files / 338 tests server, 2 / 6 client — passing |
| `npm run build` | passing, both apps |
| `npm run test:integration` | **not run** — no MongoDB available |

| Metric | After Phase 4 | After Phase 5 |
|---|---|---|
| Repository guardrail files | 351 | 360 |
| Tenant-isolation exceptions | 44 | 44 |
| Server test files / tests | 36 / 309 | 37 / 338 |

Four new models registered in both guardrail scripts and the `dataLifecycle`
erasure registry. No new tenant-isolation exceptions: every voice query is
organisation-scoped.

---

## 6. Before any call is ever placed

These are not ordinary acceptance gates. Several are legal preconditions, and
the software cannot discharge any of them.

- [ ] **Counsel has advised on automated calling** in every jurisdiction to be
      dialled, and the calling window reflects that advice with the reviewer and
      date recorded. Until then only the conservative default is available.
- [ ] **A DND registry checker is configured.** Until one is, the default blocks
      every call — verify that it does, rather than assuming.
- [ ] **India:** DLT registration complete, telemarketer registration with an
      access provider, and DND scrubbing confirmed working against a known
      registered number.
- [ ] **Telephony numbers are registered for outbound calling** in each
      jurisdiction.
- [ ] **AI disclosure is spoken and audible** on a real call, at the start,
      before any conversation.
- [ ] **Recording consent** is spoken where recording is enabled, and legal
      advice on the applicable consent regime is recorded.
- [ ] **A mid-call opt-out ends the call** and writes a suppression entry.
      Test with contractions ("don't call me") — that specific case was broken
      once already.
- [ ] **Keyword opt-out detection is NOT relied on alone.** It is a floor. A
      test in this repository deliberately asserts that phrases like "I would
      rather you did not contact me again" are missed. The conversational
      provider must also signal opt-out intent and that signal must be honoured
      independently. An agent that argues with someone who has already refused
      is the worst thing this system can do and precisely what regulators look
      at.
- [ ] **Recording deletion works**, verified by confirming the audio is gone
      from the provider, not just that a flag was set locally.

---

## 7. Closing note on the whole build

All five phases are code-complete against the specification, to the extent the
specification could be satisfied without external approvals. **None of them has
been verified against a running database, and no message, post or call has ever
left this system.**

That gap has now compounded across five phases. It is the largest risk in the
project and no further phase reduces it. Every remaining item of value —
verifying indexes exist, confirming provider contracts, obtaining app reviews
and registry access — requires infrastructure, credentials or approvals that
must come from outside this build.

The honest recommendation is unchanged from Phase 1: get a MongoDB instance and
work `LIVE_ACCEPTANCE.md` top to bottom before writing another line.
