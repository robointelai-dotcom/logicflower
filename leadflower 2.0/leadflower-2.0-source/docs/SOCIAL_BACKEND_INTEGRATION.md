# Social publishing integration

How this platform connects to a self-hosted **trypost** instance for social
publishing, what that does and does not give you, and what you must decide
before going live.

---

## 1. Architecture

```
  This platform (Node / Express / MongoDB)        trypost (PHP / Laravel / MySQL)
  ┌─────────────────────────────────────┐        ┌──────────────────────────────┐
  │  Sequence engine                    │        │  REST API  /api/posts        │
  │  CRM, pipelines, tasks              │        │            /api/social-…     │
  │  Unified inbox                      │        │            /api/workspace    │
  │  Voice (gates only)                 │        │                              │
  │                                     │        │  OAuth connect flow (web UI) │
  │  SocialPublisher interface          │        │                              │
  │    └─ TrypostSocialPublisher ───────┼─HTTP──▶│  Horizon queue → platforms   │
  │                                     │        │                              │
  │  reconcileSocialPosts() ◀───poll────┼────────┤  (no outbound webhook)       │
  └─────────────────────────────────────┘        └──────────────────────────────┘
         MongoDB                                          MySQL
```

**Two applications, two databases, one HTTP boundary.**

## 2. What "single platform" means here, precisely

This matters more than anything else in this document, because it is the thing
most easily misunderstood.

**There is no shared database.** MongoDB and MySQL cannot be joined. No query
returns "contacts who engaged with our Instagram post". No aggregation spans
both systems.

**The unified experience is assembled in the application layer**, and it is real
for the user despite that:

- A `SocialPost` may carry a `contactId`. When it publishes, `reconcileSocialPosts`
  writes a `social.published` entry onto that contact's activity timeline — in
  *this* database, from *this* code.
- The composer, calendar, scheduling and media geometry are all native here. A
  user never sees trypost for any of them.
- trypost's post identifier is stored as an opaque string. It is a reference,
  not a foreign key.

**What still leaks:** connecting a social account. `GET /app/social/connect/facebook`
is a web route with no API equivalent, because OAuth requires a real browser
redirect. The client's browser lands on a trypost-rendered page and returns.
Options are covered in §6.

## 3. What this does NOT give you

**It does not grant platform access.** trypost publishes using *your* approved
platform apps — its own configuration expects `FACEBOOK_CLIENT_ID`,
`INSTAGRAM_CLIENT_SECRET`, `TIKTOK_CLIENT_ID` and the rest, all blank on a fresh
install.

**App review remains the binding constraint.** This integration removes the need
to *write and maintain* six platform integrations. It does not remove the need
to be *approved* to use them. That distinction is why every platform is reported
as `unverified` when the backend is configured, never `available`: a configured
backend is evidence publishing is possible, not that it works.

An aggregator (Blotato, Ayrshare and similar) is the option that *does* remove
app review, because they hold approved apps. trypost does not.

## 4. Setup

### 4.1 Deploy trypost

Separately, with its own PHP-FPM, MySQL, Redis and Horizon workers. Its repo
ships Docker Compose files. Supply your own platform app credentials in its
`.env`.

### 4.2 Configure this platform

```
TRYPOST_BASE_URL=https://social.internal.example.com
TRYPOST_ADMIN_API_KEY=…
TRYPOST_TIMEOUT_MS=20000
TRYPOST_POLL_INTERVAL_MS=60000
```

Unset means social publishing is disabled. Posts still compose and schedule;
targets report `blocked`. That is the Phase 4 behaviour and it is safe.

### 4.3 Link each organisation to a workspace

trypost has **no admin API for workspace creation**. An operator creates the
workspace in trypost's UI, generates a workspace API key, and posts it here:

```
POST /api/v1/social/backend/workspace
{ "apiKey": "…", "workspaceLabel": "Acme Services" }
```

The key is encrypted with a per-organisation AAD and never defaults to the admin
key — workspace keys are tenant-scoped, so using the wrong one is a cross-tenant
write.

This manual step is surfaced rather than automated away. Hiding it would leave
an operator wondering why onboarding produced no workspace.

### 4.4 Sync connected accounts

`POST /api/v1/social/backend/sync` mirrors trypost's connected accounts into
`SocialAccount`. A mirror, not a source of truth: trypost owns the OAuth tokens.

## 5. Status reconciliation

trypost exposes **no outbound webhook** for publish status. `reconcileSocialPosts`
polls in-flight posts on `TRYPOST_POLL_INTERVAL_MS` and is the only mechanism by
which a post leaves `publishing`.

Status mapping is total and conservative: an unrecognised status resolves to
`publishing`, never `published`. Treating an unknown state as success is how a
failed post gets reported as live to a customer.

## 6. The branding decision — read before forking

**Running trypost unmodified is the clean case.** Separate programs communicating
over HTTP are not one derivative work; this codebase stays under its own licence.
AGPL §13 still requires you to offer trypost's source to users who interact with
it — trivially satisfied by pointing at the upstream repository.

**Modifying it changes that.** Rebranding, theming, adding SSO — those diffs are
AGPL and must be offered as source to anyone using them over a network.

| | Unmodified | Forked and rebranded |
|---|---|---|
| Upgrades | `git pull` + migrations | Merge conflicts every release |
| Security patches | Immediate | Delayed by your merge |
| Source disclosure | Point at upstream | Publish your diff |
| Visible branding | trypost, on connect pages | Yours |

If you fork, **keep the diff tiny** — theming and the two connect controllers —
so merges stay mechanical. The connect flow is roughly 2 controllers out of 471
frontend files, so a targeted theme is contained.

### On calling it by this platform's name

Two separate constraints:

1. **AGPL** does not require keeping the trypost name, but copyright notices and
   the licence text must be preserved in the source, and the rebrand diff is
   disclosable.
2. **Trademark is not granted by AGPL**, and is a separate question in both
   directions — using their mark, and applying yours.

Note also that this repository's own guardrail
(`scripts/repository-guardrails.mjs`) **fails the build on a hardcoded brand
URL**, because domain availability and trademark clearance are recorded as
outstanding in `LIVE_ACCEPTANCE.md` under `[V43]/[V44]`. Applying this
platform's name to a second application widens an exposure that has already been
flagged as uncleared. Clear the mark first.

## 7. Operational reality

You will be running two stacks: Node/MongoDB/Redis and PHP/MySQL/Redis/Horizon.
That doubles what you patch, monitor and back up.

trypost is internet-facing and holds your clients' OAuth tokens for their
Facebook Pages. Its security patches matter, and a fork that delays them by two
weeks is a real exposure.

## 8. Acceptance gates

- [ ] `TRYPOST_BASE_URL` unset → posts compose, schedule, and report `blocked`.
      Verify this before configuring anything.
- [ ] A workspace key for organisation A cannot read organisation B's posts.
- [ ] A post created here appears in trypost's queue with the right accounts.
- [ ] A published post updates here within one poll interval and lands on the
      contact's timeline.
- [ ] A failed post reports `failed`, not `published`.
- [ ] Killing trypost mid-poll leaves posts in `publishing`, not falsely
      completed.
- [ ] Legal advice recorded on: (a) serving unmodified AGPL software alongside
      this platform, (b) whether any rebrand diff must be published, (c)
      trademark position on both names.
- [ ] Platform app review granted. **Nothing publishes without it.**
