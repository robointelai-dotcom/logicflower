# Testing every user level

Twenty-six accounts across nine organisations. Enough to exercise every role,
every tier, and every isolation boundary the system claims to enforce.

## Create them

```bash
docker exec -it leadflower-20-source_api_1 sh -c \
  'SEED_PASSWORD="ChooseSomethingLong123" npm run seed:tiers --prefix server'
```

Or outside Docker:

```bash
SEED_PASSWORD="ChooseSomethingLong123" npm run seed:tiers
```

It refuses to run when `NODE_ENV=production`. Re-running is safe — it resets
passwords and roles rather than duplicating anything, and the same base secret
reproduces exactly the same passwords.

**Change the base secret** and every password below changes. The table is
generated with `ChooseSomethingLong123` as an example; use your own.

## The estate

```
LogicFlower Corporate
  ├─ Agency Alpha ──┬─ Ridgeway Plumbing   (standing access)
  │                 └─ Calder Dental       (access on request)
  ├─ Agency Beta  ──── Harlow Fitness      (standing access)
  ├─ Fairfield Joinery                     (direct, no agency)
  └─ Brightside Cleaning                   (direct, no agency)
```

**Two agencies and two direct clients, deliberately.** With one of each, the
rules that matter cannot fail. Agency Alpha must not open Harlow Fitness, and
Fairfield must not reach Brightside — neither is testable without the second.

## Every account has its own password

Not one shared password. A single leaked credential would otherwise open every
tier at once, including corporate, which reaches the whole estate.

Each is derived from your base secret plus the account's email, so they are all
different, reproducible, and none reveals the base or any other.

| # | Email | Password | Workspace | Workspace role | Platform role |
|---|---|---|---|---|---|
| 1 | `corp.owner@seed.local` | `Lf!NpUF2f0TvyeDioRE9` | LogicFlower Corporate | owner | owner |
| 2 | `corp.admin@seed.local` | `Lf!EZuUQjg-cEff-oMF9` | LogicFlower Corporate | admin | admin |
| 3 | `corp.editor@seed.local` | `Lf!tsP8KRau_uY5hiV89` | LogicFlower Corporate | operator | admin |
| 4 | `corp.support@seed.local` | `Lf!R8Myq7kyK-KU4D5y9` | LogicFlower Corporate | viewer | support |
| 5 | `corp.billing@seed.local` | `Lf!aDwBm7kcAdyqHrs_9` | LogicFlower Corporate | billing | user |
| 6 | `alpha.owner@seed.local` | `Lf!RW3R6tvDhi7MpbwP9` | Agency Alpha | agency_owner | user |
| 7 | `alpha.admin@seed.local` | `Lf!d_KaH9U7ba-cdU3_9` | Agency Alpha | admin | user |
| 8 | `alpha.operator@seed.local` | `Lf!bQWSBKgFecGHYZVH9` | Agency Alpha | operator | user |
| 9 | `alpha.viewer@seed.local` | `Lf!kxoPkrhvLWsA1MEy9` | Agency Alpha | viewer | user |
| 10 | `beta.owner@seed.local` | `Lf!P8Aguj1ZjhKsTJ7l9` | Agency Beta | agency_owner | user |
| 11 | `beta.operator@seed.local` | `Lf!DvIyZI5TS8ivd8_O9` | Agency Beta | operator | user |
| 12 | `ridgeway.owner@seed.local` | `Lf!fp-rA44g-D-dL_M09` | Ridgeway Plumbing | owner | user |
| 13 | `ridgeway.admin@seed.local` | `Lf!OG83qQU3bSzMAVEs9` | Ridgeway Plumbing | admin | user |
| 14 | `ridgeway.operator@seed.local` | `Lf!Nl0PZ32nVUidh21M9` | Ridgeway Plumbing | operator | user |
| 15 | `ridgeway.viewer@seed.local` | `Lf!lLML7qklgTro4d0W9` | Ridgeway Plumbing | viewer | user |
| 16 | `ridgeway.billing@seed.local` | `Lf!QVuDfGdIbmecPwyA9` | Ridgeway Plumbing | billing | user |
| 17 | `ridgeway.customer@seed.local` | `Lf!1T6vlc_jkQ5kI8dZ9` | Ridgeway Plumbing | customer | user |
| 18 | `calder.owner@seed.local` | `Lf!tEYaPpWNmFNOXsEQ9` | Calder Dental | owner | user |
| 19 | `calder.operator@seed.local` | `Lf!3vB_Y4pVI3Oc8xGO9` | Calder Dental | operator | user |
| 20 | `calder.viewer@seed.local` | `Lf!ff8Nn3mSBxQg80wZ9` | Calder Dental | viewer | user |
| 21 | `harlow.owner@seed.local` | `Lf!zGeaI8JG-RsBE68i9` | Harlow Fitness | owner | user |
| 22 | `harlow.admin@seed.local` | `Lf!Qtr_-CBPgaO8mqQz9` | Harlow Fitness | admin | user |
| 23 | `harlow.operator@seed.local` | `Lf!QPS3UW2ExtYAYlFw9` | Harlow Fitness | operator | user |
| 24 | `fairfield.owner@seed.local` | `Lf!-76THJw4s06yvqfe9` | Fairfield Joinery | owner | user |
| 25 | `fairfield.operator@seed.local` | `Lf!Hs4brmTsXJSu1JxB9` | Fairfield Joinery | operator | user |
| 26 | `brightside.owner@seed.local` | `Lf!yeDpzL1T3CupbaMP9` | Brightside Cleaning | owner | user |

## Verify in this order

Each refusal **before** the matching permission. A test that only confirms
something works has not shown the guard exists.

### Isolation — a failure here stops a release

1. **`alpha.owner`** — opening Harlow Fitness by organisation id is refused.
2. **`beta.owner`** — the Clients console lists Harlow only, never Ridgeway or Calder.
3. **`fairfield.owner`** — cannot reach Brightside, and no agency can reach either.
4. **`corp.support`** — reaches nothing at all until a client approves a request.
5. **`corp.owner`** — the Estate **payload** contains no contact, message or deal. Check the network response, not the screen: a field fetched but not displayed was still sent.

### Access mode

6. **`alpha.owner`** — Calder shows *Request access*; Ridgeway shows *Open*.
7. **`calder.owner`** — can switch Calder to standing access, and back again.

### Least privilege — check the sidebar **markup**, not just the screen

8. **`ridgeway.viewer`** — no Sequences, Booking, Social, Calling or Workflows.
9. **`ridgeway.operator`** — no Team, Billing, Connections or Vault.
10. **`ridgeway.billing`** — billing and reports only, redirected off the dashboard.
11. **`ridgeway.customer`** — the narrowest role, and the least tested. Confirm what it can actually reach.
12. **`ridgeway.owner`** — no Agency or Corporate section anywhere in the DOM. They should be absent, not hidden by a style.

### Corporate

13. **`corp.editor`** — can publish a blog article. Needs platform admin plus a second factor.
14. **`alpha.owner`** — `/website` returns 403. A workspace role, however senior, is not enough.

### Modules — one workspace is enough

15. **`ridgeway.owner`** — run `/setup`, publish sequence steps, activate a sequence.
16. **`calder.operator`** — publish a booking page and open the link in a private window.
17. **`ridgeway.operator`** — add a tag and confirm it fires what you expect.

## Reporting a failure

Give the check number, the account, and the response body. Checks 1–5 are tenant
isolation and should stop a release; 6–17 are correctness bugs in the navigation
or the access resolver.

## When you are finished

Delete `seed-accounts.local.txt` — it holds live passwords for that environment.
These accounts are for a test deployment; do not seed them anywhere real.
