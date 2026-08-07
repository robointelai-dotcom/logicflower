# Remediation 2.2 — Phase 2.5: tasks, appointments and location targeting

Base: Phase 2 as recorded in `REMEDIATION_2_1.md`.

## 0. Why this exists, and the argument against it

This work is **not in the build specification.** It was added after reviewing a
competitor feature graphic (Act! "Key Mobile CRM Features") against what Phases
1 and 2 deliver.

The case for doing it now rather than later is one specific dependency:
**Phase 3.3 defines industry snapshots as configuration data — custom fields,
pipelines, sequence and form templates.** If tasks exist before that format is
written, a Trades snapshot can ship task templates. If they do not, the format
gets revised in Phase 4 and any snapshot already shipped needs migrating.

The case against, recorded because it has not gone away: this adds two more
models and five more routes to a system where **no index has ever been created
and no message has ever been sent.** An hour spent here is an hour not spent
verifying Phase 1 against a real database, which remains the largest risk in the
project. This was built on the operator's explicit instruction with that trade
stated.

A competitor's marketing graphic is not a requirements document. Two of its five
items were built; three were declined, and §3 says why.

---

## 1. What was built

### 1.1 Tasks

`Task`: title, optional contact and deal, assignee, due date, timezone, status,
priority, source.

Deliberately **not** modelled on `ScheduledStep`. A scheduled step is work the
scheduler performs; a task's due date is a prompt to a human. Conflating them
would mean the scheduler repeatedly tries to "execute" something it cannot.

The due date carries the timezone it was set in, so "due Friday" renders as
Friday for the engineer who was given it rather than shifting to whoever opens
the list.

`GET /scheduling/tasks?mine=true` resolves to the caller rather than accepting a
user id, so one member cannot enumerate another's workload by guessing ids.

### 1.2 Stage-driven tasks

Pipeline stages gained `taskTemplates`. Entering "Quoted" can now both start a
chase sequence and raise "call them in 48 hours" against the deal owner — the
human counterpart to the sequence triggers built in Phase 2.

Tasks are raised **after** the stage write, like the sequence triggers, so a
malformed template cannot roll back the stage change that triggered it. The
stage change is the truth; the task is a consequence of it.

### 1.3 Appointments

`Appointment`: start, end, timezone, contact, assignee, status, location.

Times are stored as instants with the booking timezone alongside. Storing a
wall-clock time without its zone is how a 9am site visit becomes 3:30am for the
engineer.

Overlap is **half-open**: an appointment ending at 10:00 and one starting at
10:00 do not conflict. Treating them as conflicting would make back-to-back
scheduling impossible, which is how most field work is actually booked.

Conflicts are **reported, not enforced.** Double-booking is sometimes
deliberate — a provisional hold, two people on one job, a call taken from the
van. Refusing the booking would push the operator into working around the
system, so the conflict is surfaced and the decision left with them.

The agenda groups by **local** date. An 8pm IST appointment belongs to that
evening for the person attending it, not to the following UTC day.

### 1.4 Location targeting

`Contact.location` as a GeoJSON point with a sparse `2dsphere` index, plus
`locationSource` so accuracy is never overstated.

A `within_radius` operator in the segment compiler, so "leads within 10km of
this job site" composes with every existing filter. This was the cheap part
precisely because the compiler and its allow-list already existed — one operator
and one field type, not a subsystem.

Three traps handled explicitly, each of which fails *silently* rather than
loudly:

- **Axis order.** GeoJSON is `[longitude, latitude]`, the reverse of how humans
  write coordinates. Getting it backwards places a Chennai contact in the Indian
  Ocean and a radius query then returns nothing, which reads as "no contacts
  nearby" rather than as a bug. Every function takes named `latitude`/
  `longitude` and the swap happens in exactly two places.
- **Radians.** `$centerSphere` takes its radius in radians. Passing kilometres
  yields a radius of thousands of earth-circumferences and matches everything.
- **`$geoWithin`, not `$near`.** `$near` cannot appear inside `$or`, so an
  any-match segment containing a location condition would fail at query time
  rather than at compile time — a failure the segment's author would never see
  coming.

`0,0` is refused. "Null Island" is where a contact lands when empty form fields
coerce to zero, and it is far more often a bug than a real position in the Gulf
of Guinea.

Coordinates are absent from the activity timeline summary and metadata. The
timeline is the surface most likely to be rendered somewhere broad, and a
person's precise position is not something to scatter through it.

---

## 2. Mapping to the feature graphic

| Feature | Status |
|---|---|
| Automation for follow-ups and workflows | Built in Phase 1 |
| Lead and sales pipeline management | Built in Phase 2, API only |
| Task and calendar integration | **Tasks and internal appointments built. No external calendar sync.** |
| Location-based targeting | **Radius targeting built. No geocoding.** |
| Real-time customer data access | Data layer only; no push, no UI |

Every item in that graphic is framed as a *mobile* feature, and **no client UI
exists for any of it.** Specification §7 (PWA) has not been started. That
remains the largest gap between this system and the graphic, and it is not
closed by anything in this phase.

---

## 3. What was deliberately declined

### 3.1 External calendar sync (Google, Outlook)

**Not built, and not a gap to close casually.** Specification §3 says: *"Do not
attempt bidirectional field sync — it is a conflict-resolution problem that will
consume the project."* Calendar sync is that problem in its purest form:
recurrence rules, cancellations racing edits, timezone drift, attendee state,
three providers with materially different semantics.

To do it properly would need: a decision on one-way versus two-way (one-way
push to an external calendar is perhaps a tenth of the work and covers most of
the value), OAuth onboarding per provider, webhook or poll-based change
detection, and a conflict-resolution policy written down *before* code.

Recommendation: build one-way push only, and only when a customer asks.

### 3.2 Geocoding

**Not built.** Turning "12 Anna Salai, Chennai" into coordinates requires Google
Geocoding, Mapbox or similar — a third-party contract this build has no current
documentation for, and a billing decision nobody has made. §4.2 applies.

Coordinates are accepted from a form, an import, a device's GPS or manual entry.
The `locationSource` field records which, so a device-GPS position and a
hand-typed one are never presented as equally precise.

### 3.3 Real-time push

**Not built.** Websockets or SSE is infrastructure, and "real-time data access"
is mostly a *UI* claim. Building push before there is a client to push to is
backwards.

### 3.4 Task reminders through the sequence engine

**Not built.** A task falling due could notify its assignee through the Phase 1
engine. It was left out because the notification target is an internal team
member, not a contact, and the sequence engine's entire suppression and consent
model is built around contacts. Routing internal notifications through it would
either bypass suppression (wrong) or subject staff to a contact suppression list
(nonsense). Internal notification belongs on the existing
`NotificationChannel` machinery instead.

---

## 4. What is unverified

Same overriding caveat as both prior phases: **no database.** Specifically:

- The sparse `2dsphere` index on `Contact.location` has never been created. If
  it fails to build, `$geoWithin` with `$centerSphere` still works — it does not
  require an index — so **the failure mode is a silent full collection scan,
  not an error.** On a large contact set that is a performance cliff nobody will
  attribute to a missing index. Confirm with `db.contacts.getIndexes()`.
- No radius query has been run against real documents. The axis order, the
  radian conversion and the query shape are unit-tested; whether stored
  documents match them has not been observed.
- The conflict-detection query in `findConflicts` expresses half-open overlap as
  `startAt < end AND endAt > start`. The predicate is tested as pure logic via
  `intervalsOverlap`; the query itself has not been run.

23 new tests cover coordinate parsing, axis order, radian conversion, `$or`
composability, interval overlap, timezone-local day grouping and the validation
bounds.

---

## 5. Gate status

| Gate | Result |
|---|---|
| `npm run guardrails` | passing, 325 files |
| `npm run lint:security` | 0 findings |
| `npm run typecheck` | 0 errors, both apps |
| `npm run test` | 34 files / 268 tests server, 2 / 6 client — passing |
| `npm run build` | passing, both apps |
| `npm run test:integration` | **not run** — no MongoDB available |

### Baseline movement

| Metric | After Phase 2 | After Phase 2.5 |
|---|---|---|
| Repository guardrail files | 318 | 325 |
| Tenant-isolation exceptions | 41 | 41 |
| Server test files / tests | 33 / 245 | 34 / 268 |

`Task` and `Appointment` are registered in both guardrail scripts and in the
`dataLifecycle` erasure registry. No new tenant-isolation exceptions were
needed: every query in this phase is organisation-scoped.

---

## 6. Live acceptance additions

Add to `LIVE_ACCEPTANCE.md` before this is relied on:

- [ ] `db.contacts.getIndexes()` shows the `2dsphere` index on `location`.
      Without it, radius queries still return correct results via a full
      collection scan — the failure is slow, not wrong, and will not surface as
      an error.
- [ ] A contact with known coordinates is returned by a radius query centred
      nearby and excluded by one centred far away. This is the axis-order check:
      a swapped pair returns nothing rather than erroring.
- [ ] Back-to-back appointments for one assignee produce no conflict; an
      overlapping pair produces exactly one.
- [ ] A stage change with a task template raises the task against the deal
      owner, and a malformed template does not roll back the stage change.
