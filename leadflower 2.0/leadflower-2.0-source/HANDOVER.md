# HANDOVER — LogicFlower with the "Getting found" module

Read this before running anything. The previous handover is kept as
`HANDOVER_PREVIOUS.md` and is still accurate on architecture.

**Verified on packaging:**

| Gate | Result |
|---|---|
| Repository guardrails | 484 files, passing |
| Tenant-isolation guard | passing |
| ESLint security | 0 findings |
| TypeScript | 0 errors, both apps |
| Server tests | 55 files / 591 tests |
| Client tests | 4 files / 29 tests |
| Builds | both passing, 27 pages prerendered |

---

## 1. Before anything else

### 1.1 Rotate the three secrets

`trypost.env` has now been removed from the tree twice. That is **not enough**:
the values are in git history and the repository is publicly clonable — it was
cloned during this work with no credentials at all.

Rotate today:

- the trypost database password
- `APP_KEY`
- the Passport RSA private key

Then purge from history (`git filter-repo` or BFG) and force-push. **Rotation is
the part that matters.** The purge is hygiene.

### 1.2 Three checks were disabled in code, and are now flags

Each was commented out during a deployment. Commented-out code leaves no record
that a state was meant to be temporary, and no way to reverse it without another
commit — so all three are now environment flags with safe defaults and a
start-up warning.

| Flag | Default | If a deployment is blocked |
|---|---|---|
| `CORPORATE_MFA_REQUIRED` | `true` | Enrol MFA on the corporate account. Do not turn this off. |
| `TRYPOST_ALLOW_INSECURE` | `false` | Only where trypost is on a private network. The fix is TLS. |
| `TRYPOST_MIN_SECRET_LENGTH` | `32` | Run `npm run secrets:generate`. Lower it only deliberately. |

**Please use the flags rather than commenting the checks out again.** A flag
leaves a trace in the environment; a comment does not.

---

## 2. What changed in this release

### Restored to green

The tree arrived with 10 lint errors, 3 failing tests and a failing guardrail:

- `logicflower.com` hardcoded in three places — now read from site settings, so
  staging does not emit production canonicals
- `trypost.env` recommitted with live values — removed
- the 32-character secret minimum commented out — restored as a flag
- an unused import, an unused variable, and eight `require()` calls in a new
  `.js` script (scoped ESLint override added; those scripts legitimately run
  against compiled output)
- RSS emitted `/blog/` while the sitemap and prerendered pages use `/blog` —
  two different URLs to a search engine, now consistent

### New: the "Getting found" module

Six features, all per-workspace, none requiring an external approval, none
costing anything per customer per month.

| | Feature | Route |
|---|---|---|
| 1 | Business profile and schema | `/seo/profile` |
| 2 | WordPress plugin and pairing | `/seo/website` |
| 3 | Attribution — search to booked job | `/seo/results` |
| 4 | Search Console connection | `/seo/website` |
| 5 | Questions clustered from the inbox | `/seo/questions` |
| 6 | Article briefs from completed work | API |

New models: `BusinessProfile`, `AnswerCapsule`, `SiteConnection`,
`SearchConsoleConnection`.
New services: `server/src/services/visibility/`.
New plugin: `wordpress-plugin/logicflower/`.

---

## 3. Scope — the mistake most likely to be made here

`server/src/routes/content.ts` is gated on **`platformRole`** because there is
one public marketing website and it belongs to the platform operator.

`server/src/routes/visibility.ts` is the **opposite**. Every client has their own
business, their own website and their own customers, so it is scoped to
`organizationId` and gated on the **workspace** role.

If somebody later copies the corporate gate into this module, the whole feature
locks to platform administrators — and it will look like it works right up until
an agency's client tries to use it.

---

## 4. Running it

```bash
npm run install:all
cp server/.env.example server/.env
npm run secrets:generate
npm run verify
```

Expect exactly the numbers in the table at the top. Anything different means
something did not transfer.

### The integration suite reports a false pass locally

```bash
INTEGRATION_REQUIRED=1 npm run test:integration --prefix server
```

**Always set that flag.** Without it a missing MongoDB is reported as a skip that
reads as a pass — "6 passed" when it ran nothing. CI already sets it.

### Before a production build

```bash
CANONICAL_ORIGIN=https://your-domain \
SOCIAL_IMAGE_PATH=/your-card.jpg \
npm run build --prefix client
```

Without `CANONICAL_ORIGIN`, canonical URLs are relative and `og:image` is
omitted entirely — most crawlers ignore a relative canonical, and a missing
share card is better than a blank one. The build warns when it is absent.

### Optional configuration

| Variable | For |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Search Console. Free, no application to Google needed. |
| `TRYPOST_MIN_SECRET_LENGTH` | See section 1.2 |

**Search Console is not the Business Profile API.** Search Console needs no
approval — the customer authorises their own property. Business Profile, which
would allow importing Google reviews, is a separate application that can be
refused and **has not been applied for**.

---

## 5. Test accounts

```bash
SEED_PASSWORD="ChooseSomethingLong" npm run seed:tiers
```

26 accounts across 9 organisations, each with its own derived password. Refuses
to run when `NODE_ENV=production`. See `TESTING_TIERS.md` for the estate and the
17 checks in order.

---

## 6. THE WORDPRESS PLUGIN IS UNVERIFIED

`wordpress-plugin/` was written without a WordPress install, and without even a
PHP binary to lint it. **Treat every line as untested.**

Install on a staging site first. Never a customer's.

The check that matters most, from `docs/LIVE_ACCEPTANCE.md`:

> **With LogicFlower unreachable, the customer's site must still load normally.**

The payload cache exists so that our outage does not become theirs. That has
never been exercised.

Also verify the site token cannot read contacts: try
`GET /api/v1/crm/contacts` with it and confirm it fails. The plugin is designed
so that if the customer's WordPress is compromised — and small business sites
regularly are — nothing about *their* customers leaks, because none of it was
ever reachable from there.

---

## 7. The thing that matters more than any feature

**None of this has run against a live database.** No message sent, no
appointment booked, no article scheduled, no payment taken.

591 tests prove the logic. They prove nothing about persistence, and several
core guarantees are indexes that fail **silently** when absent:

| Guarantee | Enforced by | If the index is missing |
|---|---|---|
| A message is never sent twice | unique index on `SendRecord` | Duplicate messages to customers |
| Two people cannot book one slot | partial unique index on `Appointment` | Both turn up |
| An inbound message is handled once | partial unique index on `Message` | Duplicated conversations |
| Contact search | text index | Returns nothing; reads as "no matches" |

Work `docs/LIVE_ACCEPTANCE.md` top to bottom before a paying customer touches
it. **Start with payments in Stripe test mode** — everything else fails visibly,
whereas a payments error moves real money into the wrong account.

Note also: `/seo/results` shows *"Nothing to show yet"* until a workspace has won
deals. That is correct behaviour, not a bug — but it means the feature cannot be
demonstrated until somebody is genuinely using the product.

---

## 8. Not built, and blocked

**Not built:** rank tracking and geo-grid (£3–35 per customer per month in
bought SERP data) · AI visibility scoring · custom-field editor UI ·
lead-to-workspace conversion · blog authors and categories as records · article
revision history · server-side rendering of article bodies.

**Blocked on somebody else:**

| | Waiting on |
|---|---|
| Social publishing | Meta, LinkedIn, TikTok, Pinterest app review |
| Google review import | Business Profile API — **not yet applied for** |
| WhatsApp | A business solution provider, then Meta |
| AI calling — dialling | Provider API docs, telephony, DNC registry, legal advice |
| AVIF images | A build of `sharp` with the encoder compiled in |
| Responsive verification | A human with a browser at 320px |

**Do not put any of these on a pricing page.** The application labels them
honestly; the marketing must match.

---

## 9. Where to read next

| Document | Covers |
|---|---|
| `docs/LIVE_ACCEPTANCE.md` | **Start here.** Everything to verify against real infrastructure |
| `TESTING_TIERS.md` | The 26 test accounts and the order to check them in |
| `HANDOVER_PREVIOUS.md` | The earlier handover, still accurate on architecture |
| `docs/REMEDIATION_2_*.md` | What was built per phase, and what was not |

Each record states what was **not** built as plainly as what was. None carries a
completion score, deliberately — this repository previously held a self-issued
100/100 that was wrong.
