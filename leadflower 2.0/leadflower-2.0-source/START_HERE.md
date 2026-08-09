# LogicFlower — source handover

Everything verified on the day it was packaged:

| Gate | Result |
|---|---|
| Repository guardrails | 456 files, passing |
| Tenant-isolation guard | passing |
| ESLint security | 0 findings |
| TypeScript | 0 errors, both apps |
| Server tests | 53 files / 553 tests |
| Client tests | 4 files / 29 tests |
| Builds | both passing, 27 pages prerendered |

---

## 1. The layout changed, deliberately

**`package.json` is at the root of this archive.** The deployed repository has
everything nested under `leadflower 2.0/leadflower-2.0-source/` — a directory
name containing a space — which means a fresh clone cannot install, build or
test, and CI finds nothing.

If you would rather keep the nested layout, use the patch file instead of this
archive; it targets the existing structure. Otherwise moving to root fixes a
real problem and costs one commit.

---

## 2. Rotate three secrets before anything else

`trypost.env` has been removed from the working tree and from git tracking. That
is not enough on its own: **the values are in git history and the repository is
publicly clonable.**

Rotate all three, today:

- the trypost database password
- `APP_KEY`
- the Passport RSA private key

Then purge the file from history (`git filter-repo` or BFG) and force-push.
Rotation is the part that matters; the purge is hygiene.

---

## 3. Two flags that were switched off in code

Both were disabled during a deployment to get things working. Neither left any
record that the state was meant to be temporary, so both are now environment
flags with safe defaults and a start-up warning.

### `CORPORATE_MFA_REQUIRED` — default `true`

Platform administration demands a second factor. Setting it false means a stolen
platform password is enough to read every tenant and publish to your own
marketing domain.

**If MFA is blocking a deployment, enrol MFA on the corporate account. Do not
turn this off.**

### `TRYPOST_ALLOW_INSECURE` — default `false`

The trypost SSO secret travels in the request body. Over plain HTTP it is
readable by anything on the path, and it is enough to mint a session as any
user. Set this true only where trypost sits on a private network the hop cannot
be observed on. The correct fix is TLS.

---

## 4. Running it

```bash
npm run install:all
cp server/.env.example server/.env
npm run secrets:generate
npm run verify
```

Expect exactly the numbers in the table above. Anything different means
something did not transfer.

### The integration suite reports a false pass locally

```bash
INTEGRATION_REQUIRED=1 npm run test:integration --prefix server
```

**Always set that flag.** Without it, a missing MongoDB is reported as a skip
that reads as a pass — "6 passed" when it ran nothing. CI already sets it.

### Before a production build

```bash
CANONICAL_ORIGIN=https://your-domain \
SOCIAL_IMAGE_PATH=/your-card.jpg \
npm run build --prefix client
```

Without `CANONICAL_ORIGIN`, canonical URLs are relative and `og:image` is
omitted — most crawlers and every social scraper ignore a relative canonical,
and a missing card is better than a blank one. The build warns when it is
absent.

---

## 5. Creating test accounts

```bash
SEED_PASSWORD="ChooseSomethingLong" npm run seed:tiers
```

Creates 26 accounts across 9 organisations, each with its own derived password,
and prints the order to verify them in. Refuses to run when
`NODE_ENV=production`. See `TESTING_TIERS.md`.

---

## 6. The one thing that matters more than any feature

**None of this has run against a live database.** No index has been created, no
message sent, no appointment booked, no payment taken, no article scheduled.

553 tests prove the logic. They prove nothing about persistence, and several of
the product's core guarantees are database indexes that fail *silently* when
absent:

| Guarantee | Enforced by | If the index is missing |
|---|---|---|
| A message is never sent twice | unique index on `SendRecord` | Duplicate messages to customers |
| Two people cannot book one slot | partial unique index on `Appointment` | Both turn up |
| An inbound message is handled once | partial unique index on `Message` | Duplicated conversations |
| Contact search | text index | Returns nothing; reads as "no matches" |
| Radius search | 2dsphere index | Full collection scan |

Work `docs/LIVE_ACCEPTANCE.md` top to bottom before a paying customer touches
it. **Start with payments in Stripe test mode** — everything else fails visibly,
whereas a payments error moves real money into the wrong account.

---

## 7. Where to read next

| Document | Covers |
|---|---|
| `docs/LIVE_ACCEPTANCE.md` | **Start here.** Everything to verify against real infrastructure |
| `TESTING_TIERS.md` | The 26 test accounts and the order to check them in |
| `HANDOVER.md` | The earlier handover, still accurate on architecture |
| `docs/REMEDIATION_2_*.md` | What was built per phase, and what was not |
| `docs/SOCIAL_BACKEND_INTEGRATION.md` | Running trypost alongside, and the AGPL position |

Each remediation record states what was **not** built as plainly as what was.
None carries a completion score, deliberately — this repository previously held
a self-issued 100/100 audit that was wrong.

---

## 8. What is not built, and what is blocked

**Not built:** custom-field editor UI (the API is complete) · lead-to-workspace
conversion · blog authors and categories as records rather than text · article
revision history · full server-side rendering of article bodies.

**Blocked outside this codebase:**

| | Waiting on |
|---|---|
| Social publishing | App review from Meta, LinkedIn, TikTok, Pinterest |
| Google Business Profile | A separate access request, which can be refused |
| WhatsApp | A business solution provider, then Meta template approval |
| AI calling — dialling | Provider API docs, telephony, a do-not-call registry, legal advice |
| AVIF images | A build of `sharp` with the AVIF encoder compiled in |
| Responsive verification | A human with a browser at 320px |

**Do not put any of these on a pricing page.** The application labels them
honestly; the marketing must match.
