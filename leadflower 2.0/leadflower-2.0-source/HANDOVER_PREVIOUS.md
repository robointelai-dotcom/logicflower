# HANDOVER — LogicFlower

Read this before running anything. It is short on purpose; the detail is in
`docs/`.

**Baseline:** `e97f349` (Final update of logicflower production)
**Verified:** 413 files, 439 tests, 0 lint findings, both apps build.

---

## 1. Two things to do before you write any code

### 1.1 Rotate the committed secrets

`trypost.env` is in the repository history with real values — a database
password, a Laravel `APP_KEY`, and an RSA private key that signs authentication
tokens. **The repository is publicly clonable**; it was cloned during this work
with no credentials at all.

Deleting the file does not help. It stays in history and GitHub indexes it.

1. Rotate every value: database password, `APP_KEY`, Passport keypair.
2. Add `*.env` to `.gitignore`.
3. Purge `trypost.env` and the two committed `.zip` archives from history
   (`git filter-repo` or BFG), then force-push.

Rotation is the part that matters. The history purge is hygiene.

### 1.2 Decide the repository layout

Everything currently sits under `leadflower 2.0/leadflower-2.0-source/` — a
directory name containing a space. `package.json` is not at the root, so a fresh
clone cannot install, build or test, and CI finds nothing.

**The patch in this handover targets the repository ROOT.** It will not apply to
the nested layout. Either:

- **Move the contents up to root** (recommended — fixes the space, fixes CI,
  fixes a fresh clone), then apply the patch; or
- **Tell whoever produced the patch** to retarget it at the nested path.

---

## 2. Applying the work

```bash
git clone https://github.com/robointelai-dotcom/logicflower.git
cd logicflower
git checkout -b leadflower-2.0

git apply --check ../leadflower-all-phases.patch   # dry run first
git apply ../leadflower-all-phases.patch

git add -A && git commit -m "LeadFlower 2.0"
git push -u origin leadflower-2.0
```

Open a pull request rather than pushing to `main`: it gives a reviewable diff and
somewhere to resolve conflicts calmly.

The zip is an alternative for a fresh repository, but it loses history.

---

## 3. Verifying it landed

```bash
npm run install:all
cp server/.env.example server/.env
npm run secrets:generate
npm run verify
```

Expect exactly:

| Gate | Expected |
|---|---|
| Repository guardrails | 413 files, passing |
| Tenant-isolation guard | passing |
| ESLint security | 0 findings |
| TypeScript | 0 errors, both apps |
| Server tests | 45 files / 423 tests |
| Client tests | 3 files / 16 tests |
| Builds | both passing |

Anything different means something did not transfer.

### The integration suite reports a false pass locally

```bash
INTEGRATION_REQUIRED=1 npm run test:integration --prefix server
```

**Always set that flag.** Without it, a missing MongoDB is reported as a skip
that reads as a pass — "6 passed" when it ran nothing. CI already sets it.

---

## 4. The single most important thing

**None of this has ever run against a database.** No index has been created, no
message sent, no appointment booked, no payment taken, no call placed.

The 439 tests prove the logic. They prove nothing about persistence, and several
of the product's core guarantees are database indexes that fail *silently* when
absent:

| Guarantee | Enforced by | Symptom if the index is missing |
|---|---|---|
| A message is never sent twice | unique index on `SendRecord` | Duplicate messages to customers |
| Two people cannot book one slot | partial unique index on `Appointment` | Both turn up |
| An inbound message is processed once | partial unique index on `Message` | Duplicated conversations |
| Contact search | text index | Returns nothing; reads as "no matches" |
| Radius search | 2dsphere index | Full collection scan |

Work `docs/LIVE_ACCEPTANCE.md` top to bottom before a paying customer touches it.

**Start with payments, in Stripe test mode.** Every other subsystem fails
visibly. A payments error moves real money into the wrong account.

---

## 5. What works, and what does not

### Works once deployed with a database and your own email/SMS provider

Follow-up sequences · contacts, tags, pipelines, deals · shared inbox ·
missed-call text back · booking pages and the visitor booking link · review
collection and the website widget · industry starter packs · the three tier
dashboards and access ledger · blog and website manager · help centre

### Built, but waiting on somebody outside this codebase

| Feature | Blocked on | Who |
|---|---|---|
| Social publishing | App review per platform | Meta, LinkedIn, TikTok, Pinterest |
| Google Business Profile | Separate access request; can be refused | Google |
| WhatsApp | Business solution provider, then template approval | A BSP, then Meta |
| AI calling — actually dialling | Provider API docs, telephony, DNC registry, legal advice | You |
| Payment confirmation | Webhook endpoint not built | Configuration |

**Do not put any of these on a pricing page.** The application labels them
honestly; the marketing must too.

### Not built

Custom-field editor UI (the API is complete) · lead-to-workspace conversion ·
blog media library · marketing sitemap pages (`/features/*`, `/compare/*`) ·
Social/Reviews navigation split · MFA for platform administrators ·
a dedicated security-hardening pass · the README/ARCHITECTURE/RBAC document set

---

## 6. Where to read next

| Document | What it covers |
|---|---|
| `docs/LIVE_ACCEPTANCE.md` | **Start here.** Everything to verify against real infrastructure |
| `docs/REMEDIATION_2_0.md` … `2_6.md` | What was built per phase, what was not, and why |
| `docs/SOCIAL_BACKEND_INTEGRATION.md` | Running trypost alongside, and the AGPL position |
| `docs/OPERATIONS.md` | Existing operational guidance |

Each remediation record states what was **not** built as plainly as what was.
None carries a completion score, deliberately — the repository previously held a
self-issued 100/100 that was wrong.

---

## 7. Things that will look like bugs and are not

| Symptom | Cause |
|---|---|
| "Activate" greyed out on a sequence | No published steps. Open it and publish some. |
| "New Deal" greyed out | No pipeline exists. Run `/setup`, or create one. |
| Every call reports blocked | No do-not-call registry connected. A check that cannot verify must not report a number as clear. |
| Nothing publishes to social | Platform approval outstanding. The screen says so. |
| Sequences arrive switched off | Deliberate. Nothing messages a customer until a person turns it on. |

---

## 8. Legal points that need answering, not coding

1. **Automated calling** in every jurisdiction you will dial — calling hours,
   consent basis, do-not-call obligations.
2. **The AGPL position on trypost**: does serving it unmodified alongside this
   platform create any obligation on this platform? Modifying it — including
   rebranding — makes that diff disclosable.
3. **Trademark clearance** for the brand name. `scripts/repository-guardrails.mjs`
   fails the build on a hardcoded brand URL because `[V43]`/`[V44]` record this
   as outstanding. That guard is doing its job; do not remove it.

---

*Nothing in this handover is a score or an estimate. Every figure above was
produced by running the command that produces it.*
