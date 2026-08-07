# Remediation 2.4 — Phase 4: social and GBP engine

Base: Phase 3 as recorded in `REMEDIATION_2_3.md`.
Scope: **Phase 4 only.** Phase 5 (AI voice) was not started.

---

## 0. The shape of this phase

Phase 4 splits into two halves that differ fundamentally, and conflating them
would misrepresent what was delivered.

**The review engine is complete.** It sends through the operator's own email and
SMS providers, which Phase 1 already built. No platform's permission is needed,
so nothing is blocked and nothing is guessed.

**Social publishing is not, and cannot honestly be.** Every platform requires a
separate app review — Meta, TikTok, Pinterest, LinkedIn — and Google Business
Profile API access is historically restricted and may be refused outright. The
specification's instruction is explicit: *"Gate every platform behind the
capability system. Each requires separate app review, and any may be refused."*

So the composer, the scheduler, the calendar and the media pipeline are real and
complete. **Every publish call refuses**, with the outstanding approval and the
required documentation attached to the refusal.

That is not a shortfall against the specification; it is the specification
followed. Writing six publish integrations from memory would produce something
that appears finished and posts the wrong content to a customer's public
profile, or gets their app suspended.

---

## 1. What was built and works

### 1.1 Review engine (spec 4.3)

Complete. Review requests by SMS or email, a public submission page, moderation,
and an embeddable widget.

Two controls shape it, both aimed at the failure mode where a review programme
is the thing that makes customers mute a business:

- **One outstanding request per contact**, enforced by a partial unique index. A
  customer with three completed jobs gets one ask, not three, and a stage change
  that fires twice sends one message.
- **Suppression and quiet hours apply.** A review request is marketing and is
  not exempt because it is polite. Quiet hours here *defer* rather than skip —
  unlike missed-call text back, a review request reads perfectly well the next
  morning.

Reviews are **never published automatically.** The widget is unauthenticated and
effectively permanent, so a review becomes world-readable only when a person
decides it should — which is also the only defence against a submission link
being shared or abused. Publishing is audited: "who made this public" needs an
answer.

### 1.2 The embeddable widget (spec 4.3)

Public, unauthenticated, rate-limited, scoped to one organisation by an
unguessable key, and exposing nothing beyond published reviews.

It runs on somebody else's website, which governs every decision in it:

- **Zero dependencies.** Plain DOM in an IIFE. It does not pull a framework onto
  a customer's page.
- **`textContent` throughout, never `innerHTML`.** Review bodies and author
  names are attacker-influenced — anyone with a submission link can put text in
  one — and they land in the DOM of a business's public site. An XSS here is not
  a bug in this product, it is a bug in every customer's website at once. Tested
  in both the server-rendered and script paths.
- **Schema.org `AggregateRating` as JSON-LD**, with `<`, `>` and `&` escaped to
  unicode so a `</script>` inside a review body cannot terminate the block.
- **The aggregate covers only the reviews actually shown.** An average over
  reviews a visitor cannot read is a figure nobody can verify, and search
  engines penalise exactly that.
- **No disclosure of what was filtered.** Publishing "12 shown of 40" would leak
  the ratio of reviews an operator suppressed, which is precisely what the
  widget must not reveal.
- **The accent colour is constrained to a hex literal** before it is
  interpolated into a stylesheet. Anything else is an injection point.

Four layouts (carousel, grid, list, badge), a rating filter, and a
server-rendered variant for hosts that will not run a script.

### 1.3 Media variants (spec 4.1)

Complete, as pure geometry: crop or pad computation for 1:1, 9:16, 16:9 and 4:5.
No image processing and no I/O — keeping the geometry separate is what makes it
provable, and geometry is where the errors live. An off-by-one in a crop offset
is invisible in review and obvious in a published post with someone's head cut
off.

`cover` is the default because a padded feed post looks like a mistake while a
tight crop looks intentional; `contain` is offered because for a poster or a
price list, losing edge content is the worse failure. Upscaling is **flagged,
not prevented** — an operator may knowingly accept a soft image but should not
discover it after publishing.

### 1.4 Composer and durable scheduling (spec 4.1)

A single composer targeting multiple platforms with per-platform caption
overrides, validated against each target's constraints. Every issue is collected
rather than failing on the first.

The validation catches the failures that would otherwise surface at publish
time: Instagram and TikTok have no text-only post, Pinterest accepts one media
item, caption limits differ by an order of magnitude across platforms.

**The platform is taken from the stored account, never from the request.** A
caller could otherwise claim a permissive platform's limits while targeting a
stricter one.

Scheduling is durable, in MongoDB, using the same two-stage lease as
`ScheduledStep` and for the same reason: a content calendar planned a month out
must not evaporate with a Redis restart. `publish_started` matters more here
than for messaging — a blind retry posts the same content to a public profile
twice.

Targets are marked **`blocked` at composition**, with the reason, rather than
discovered as failures at publish time.

---

## 2. What is deliberately not implemented

### 2.1 Every social publish call

All six platforms report `unimplemented`, and a test asserts it. If that test
ever fails, someone marked a platform publishable and must have a verified
implementation behind it.

| Platform | Approval outstanding | Documentation needed |
|---|---|---|
| Facebook Page | Meta App Review (`pages_manage_posts`) + Business Verification | Current Graph API version, Page publishing endpoint, media upload flow, current permission names — these have been renamed more than once |
| Instagram Business | Meta App Review (`instagram_content_publish`), linked Business account | Current Content Publishing API: container-then-publish flow, rate limits, carousel and Reels constraints |
| LinkedIn Page | Marketing Developer Platform access — application-based, may be refused | Current Posts API contract, organisation URN format, asset registration flow |
| TikTok | Content Posting API access, separate audit | Whether direct post or upload-to-inbox is granted, and the audit obligations of each |
| Pinterest | Developer app review with write access | Current Pins API create contract, board identifier format |
| **Google Business Profile** | **Access request — historically restricted, may be refused** | **Confirmation access is granted at all**, then Local Post contract, CTA button types, media endpoint, Q&A surface, holiday-hours representation |

### 2.2 Google Business Profile specifically (spec 4.2)

The specification says *"Confirm current API access requirements before
building."* That confirmation has not been obtained and cannot be obtained from
inside this build, so **nothing was built.**

This is the one platform where the product must work if access is refused, and
it is treated that way: GBP is one target among six in the composer, not a
foundation anything else rests on. Posts with CTA buttons, photo sync, Q&A
management and holiday hours are all unimplemented.

### 2.3 Review-to-post image cards

**Not built.** Spec 4.3 asks for image cards generated from reviews. Producing a
raster image requires an image library not currently a dependency; producing SVG
is possible but an SVG is not what social platforms accept, so it would need
rasterising anyway. Given that no platform can be posted to, this would have
been generating assets with nowhere to go. It should be built alongside the
first working publish integration.

### 2.4 Drag-and-drop calendar

The **API** supports a calendar: posts are queryable by scheduled date range
with their targets and status. The drag-and-drop month view is UI, and there is
still no client for any phase.

### 2.5 The publish worker

`ScheduledPost` records exist and are created on schedule, but **no worker
drains them.** Adding one would mean a loop whose every iteration refuses,
writing failure records for posts that were already marked `blocked` at
composition. It should be wired at the same time as the first real publisher.

---

## 3. What is unverified

**No database, as in every prior phase.** Specific to this one:

- No widget has been rendered on a real page. The escaping is tested against
  hostile input in both paths, but browser behaviour under an unusual host CSS
  or CSP has not been observed.
- The unique indexes backing anti-nagging (`ReviewRequest`) and widget key
  lookup have never been created.
- No review request has been sent, because that path runs through the same
  unverified SendGrid and Twilio integrations flagged in
  `REMEDIATION_2_0.md` §5.
- The media geometry is arithmetic and fully tested, but **no image has been
  processed** — nothing in this build reads or writes pixels.

30 new tests cover crop and pad geometry, upscale detection, per-platform
composer constraints, capability gating, and widget escaping against hostile
review content.

---

## 4. Defects found during this work

Both were test assertions rather than code, and both are worth recording because
the corrected versions are stronger:

1. **An XSS assertion that was too crude.** It rejected the substring
   `onerror=alert`, which appears legitimately as inert escaped text. The
   corrected test asserts the property that matters — that every element in the
   output is one the renderer opened itself — rather than scanning for
   scary-looking strings.

2. **An `innerHTML` assertion that matched a comment.** Now strips comments
   first and checks for actual assignments, the same technique the suppression
   guardrail uses.

---

## 5. Gate status

| Gate | Result |
|---|---|
| `npm run guardrails` | passing, 351 files |
| `npm run lint:security` | 0 findings |
| `npm run typecheck` | 0 errors, both apps |
| `npm run test` | 36 files / 307 tests server, 2 / 6 client — passing |
| `npm run build` | passing, both apps |
| `npm run test:integration` | **not run** — no MongoDB available |

### Baseline movement

| Metric | After Phase 3 | After Phase 4 |
|---|---|---|
| Repository guardrail files | 337 | 351 |
| Tenant-isolation exceptions | 43 | 44 |
| Server test files / tests | 35 / 281 | 36 / 307 |

The one new tenant-isolation exception is the public widget lookup in
`routes/social.ts`: the unguessable widget key is the identifier and the
organisation is derived from the matched widget.

Six new models registered in both guardrail scripts and the `dataLifecycle`
erasure registry.

---

## 6. Live acceptance additions

- [ ] Every platform still reports `unimplemented`. Before flipping any to
      `available`, confirm the app review is **granted** (not submitted) and the
      publish call is written against current documentation, not from memory.
- [ ] **Google Business Profile access confirmed or refused, in writing.** The
      product must continue to work if refused, and the answer should be
      recorded either way rather than left open.
- [ ] A review request sends, and a second request to the same contact while the
      first is outstanding is refused.
- [ ] A review request to a suppressed contact sends nothing.
- [ ] `db.reviewrequests.getIndexes()` shows the partial unique index on
      `(organizationId, contactId)`. Without it the anti-nagging control does
      not exist and the failure is a customer receiving repeated asks.
- [ ] A review containing `<script>`, quote characters and an `onerror`
      attribute renders as inert text on a real page, in both the script and
      server-rendered widgets.
- [ ] The widget is validated by Google's Rich Results test and the
      `AggregateRating` is accepted.
- [ ] A widget key that does not exist returns 404 without revealing whether the
      organisation exists.
- [ ] Origin restriction, where configured, rejects an unlisted origin.
