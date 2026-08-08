# Live-provider acceptance checklist

Application tests use deterministic mocks and contract fixtures. A connector or payment capability must remain disabled in production until its provider-owned acceptance checks pass in a dedicated sandbox/test account.

## How to produce evidence

Several gates below are now executable rather than declarative. Run:

```bash
npm run acceptance --prefix server
```

with `ACCEPTANCE_HOSTNAME`, `ACCEPTANCE_API_URL`, `ACCEPTANCE_EMAIL_TO` and the Stripe test-mode variables set. The command writes a hashed evidence bundle to `ACCEPTANCE_EVIDENCE_DIR` and **exits non-zero if any check fails _or_ is unconfigured**. A check that could not run has not run; it is never recorded as a pass.

Record the bundle hash beside the item it satisfies. Items without an `[evidence: ...]` marker still require a named human to observe the behaviour and sign.

| Command | Gates it evidences |
|---|---|
| `npm run acceptance --prefix server` | DNS, TLS, readiness, security headers, SMTP acceptance, Stripe test-mode prices |
| `npm run test:integration --prefix server` | Tenant isolation, role authorization, cross-tenant negative paths |
| `POST /api/v1/connections/:id/capabilities/:capability/probe` | Per-connection provider capability ([V3]) |
| `GET /api/v1/connections/meta/release-states` | Connector quarantine posture ([V14]) |

## Global release gates

- [ ] Production domains, DNS, TLS, CORS, cookie policy, and trusted proxy configuration are verified. `[evidence: acceptance bundle — dns, tls, headers]`
- [ ] Security contact, privacy policy, terms, subprocessor list, retention schedule, and incident contacts are published and approved. `[docs/SUBPROCESSORS.md checklist complete and countersigned; SECURITY.md security address configured]`
- [ ] The incident response plan has been rehearsed at least once — credential compromise, suspected cross-tenant exposure, and a restore from backup. `[docs/INCIDENT_RESPONSE.md]`
- [ ] An SBOM has been generated for the runtime dependency tree and retained. `[.github/workflows/security.yml sbom job artifact]` `[docs/SUBPROCESSORS.md checklist complete and countersigned; SECURITY.md security address configured]`
- [ ] The incident response plan has been rehearsed at least once — credential compromise, suspected cross-tenant exposure, and a restore from backup. `[docs/INCIDENT_RESPONSE.md]`
- [ ] An SBOM has been generated for the runtime dependency tree and retained. `[.github/workflows/security.yml sbom job artifact]`
- [ ] Production secrets are in a managed secret store; repository and image scans contain no credentials.
- [ ] Tenant-isolation, role authorization, session rotation/revocation, lockout, CSRF/CORS, SSRF, webhook replay, and job idempotency tests pass. `[evidence: npm run test:integration --prefix server with INTEGRATION_REQUIRED=1]`
- [ ] Backup restoration and queue reconstruction have been demonstrated in staging. `[evidence: server/scripts/backup/restore-drill.sh evidence record — exits non-zero unless expected collections restore non-empty]`
- [ ] Continuous cloud backup / PITR is enabled on the cluster and a point-in-time restore has been performed once. The logical dump is not a substitute for this.
- [ ] The cluster is a replica set with an odd voting membership of at least three. A standalone stops metered work, because the usage ledger requires transactions.
- [ ] Key rotation has been rehearsed: raise `ENCRYPTION_KEY_VERSION`, restart, confirm existing credentials still decrypt, then run `npm run rotate:rewrap --prefix server` to completion.
- [ ] Email authentication/delivery, bounce handling, and security notification templates pass. `[evidence: acceptance bundle — smtp; arrival and bounce behaviour still require a human observation]`
- [ ] Logs, metrics, alerts, error tracking, on-call routing, and runbooks are connected and tested.
- [ ] Load tests meet the documented capacity target without exceeding provider limits.

## Each OAuth connector

- [ ] Marketplace/developer application exists and the exact production redirect URLs are registered.
- [ ] Requested scopes match the capability manifest and consent copy; no unused write scope is requested.
- [ ] The provider returns an explicit scope grant in its token response, or a live capability probe has been recorded. `[evidence: GET /connections/:id/capabilities shows scopeSource other than requested_not_confirmed]`
- [ ] **[V3]** `workflow.inventory` resolves to `available` on a real sandbox connection. Until it does, workflow inventory, monitoring, break detection and the health dashboard are not deliverable for this provider and must not be marketed.
- [ ] Install, callback state validation, encrypted persistence, expiry display, refresh rotation, concurrent refresh locking, reconnect, revoke, and delete pass.
- [ ] Revoked/expired/insufficient-scope credentials produce a visible degraded state and actionable alert.
- [ ] Pagination, throttling, retry-after, timeout, 4xx non-retry, 5xx retry, malformed response, and partial failure cases pass against the live sandbox.
- [ ] Provider API version/revision headers and deprecation monitoring are owned.

## Webhooks

- [ ] Provider signature verification uses the documented production algorithm and the raw request body.
- [ ] Valid event, invalid signature, stale timestamp, duplicate event, reordered delivery, burst traffic, unknown event, oversized body, and handler retry pass.
- [ ] Endpoint registration/renewal/removal and secret/key rotation pass.
- [ ] No event is acknowledged as processed before its durable receipt is committed.

## Batch and data operations

- [ ] A real read-only scan reports correct counts across multiple pages.
- [ ] Preview and impact estimate match the final plan; mutation is impossible without a valid confirmation digest.
- [ ] Pause, process restart, resume, cancel, retry, rate limit, single-record validation failure, and provider partial failure preserve exact counters and avoid duplicate writes.
- [ ] Failed-record and before-state export can be downloaded by the owning organisation only and expires according to policy.
- [ ] Deduplication/normalisation fixtures are reviewed with real regional data and destructive merge policy is explicitly approved.
- [ ] **Duplicate resolution.** `contact.merge` and `contact.delete` are `unverified` for every provider in this release and merge execution refuses. Before enabling: confirm the provider's documented merge/delete contract, record a capability probe, and rehearse a full rollback from a `merge_before_state` artifact on a sandbox account.

## Billing

- [ ] Stripe products/prices and entitlements map to application plan identifiers.
- [ ] Checkout, customer portal, signed webhook, duplicate/out-of-order webhook, failed payment, retry, upgrade, downgrade, cancellation, and refund pass in test mode.
- [ ] Usage aggregation reconciles with raw usage records and cannot be modified by a tenant.
- [ ] 80% and 100% threshold notices are delivered exactly once per metric per billing period, including when a single job crosses both boundaries.
- [ ] Overage is **measured and reported only** in this release. Before charging it, reconcile reported overage units against Stripe metered usage records in test mode.
- [ ] Entitlement changes take effect safely without interrupting in-flight paid work or allowing new over-limit work.
- [ ] Tax, invoices, refund terms, and accounting ownership are approved before live mode.

## Platform-specific sign-off

Record the live-tested API/app version, test account, timestamp, reviewer, evidence link, approved scopes, confirmed limits, destructive operations enabled, and outstanding provider approval for:

- [ ] GoHighLevel / LeadConnector
- [ ] HubSpot
- [ ] Klaviyo
- [ ] ActiveCampaign
- [ ] Google Sheets
- [ ] AI providers enabled for BYOK

## Sequence engine (Phase 1)

`SEQUENCE_ENGINE_ENABLED` defaults to `false`. Every gate below must be
discharged against live infrastructure before it is set to `true`, because
turning it on begins sending messages to real people under the operator's own
sending domain and telephony numbers.

Nothing in this section can be signed off from source review or from the unit
suite. The engine was built without a running database and without provider
credentials; the unit tests prove the algorithm against in-memory stores, not
the queries or the provider calls.

### Durability and correctness

- [ ] **Indexes exist.** `db.sendrecords.getIndexes()` shows the unique index on
      `(organizationId, enrolmentId, stepIndex, channel)`, and
      `db.scheduledsteps.getIndexes()` shows the unique index on
      `(organizationId, enrolmentId, stepIndex)`. These indexes **are** the
      duplicate-send guarantee. If either failed to build, the guarantee is
      silently absent and nothing else in this list will reveal it.
- [ ] **Crash mid-wait.** Enrol a contact into a sequence whose second step
      waits three days. Kill the worker. Restart it. Confirm the step is still
      pending with the original `dueAt`, then move the clock (or use a
      short-wait sequence) and confirm it fires exactly once, at the right time.
- [ ] **Redis loss loses nothing.** With enrolments pending, `FLUSHALL` the
      Redis instance. Confirm every pending step still fires. This is the
      property the whole design exists for.
- [ ] **Lease recovery, before send.** Kill a worker between claim and dispatch.
      Confirm the step returns to `pending` and is subsequently sent once.
- [ ] **Lease recovery, after send.** Kill a worker after dispatch begins.
      Confirm the step becomes `outcome_unknown`, is **not** retried, and
      appears in `GET /sequences/operations/health`.
- [ ] **Concurrency.** Run two or more workers against the same database with a
      backlog of due steps. Confirm the count of provider sends equals the count
      of enrolment steps exactly. Not approximately.
- [ ] **Enrolment idempotence.** Fire the same enrolment trigger twice
      concurrently. Confirm one active enrolment.

### Suppression and consent

- [ ] **Unsubscribe end to end.** Click the link in a real delivered message.
      Confirm a suppression entry is created, all active enrolments for that
      contact exit, and a subsequent enrolment attempt sends nothing.
- [ ] **One-click.** Confirm `List-Unsubscribe` and `List-Unsubscribe-Post`
      headers are present on delivered mail and that a provider-initiated POST
      is honoured.
- [ ] **Prefetch safety.** Confirm a `GET` on the unsubscribe URL does not
      unsubscribe anyone. Mail scanners follow links.
- [ ] **Suppression survives retention.** Run `runRetentionMaintenance()` with a
      retention window that has elapsed. Confirm suppression entries remain and
      send records are purged.
- [ ] **Hard bounce feeds suppression.** Send to a known-invalid address.
      Confirm the bounce callback creates a suppression entry and exits
      enrolments.
- [ ] **Every channel is checked.** Suppress an address on SMS only. Confirm
      email steps still send and SMS steps exit.

### Quiet hours and timezones

- [ ] **Deferral.** Configure quiet hours and confirm a step due inside the
      window is deferred to the next permitted local instant, not sent and not
      skipped, and that `deferralCount` increments while `attempts` does not.
- [ ] **DST.** With a contact in a DST-observing zone, confirm a time-of-day
      step lands at the configured wall-clock time on both sides of a
      transition.

### Providers

Record for each: the live-tested API version, the test account, timestamp,
reviewer, and evidence link.

- [ ] **SMTP** — a message delivered to an external mailbox from a per-
      organisation identity, with correct envelope sender and unsubscribe
      headers.
- [ ] **SendGrid** — **currently marked `unverified`.** The request shape and
      error taxonomy were written from working knowledge, not from current
      documentation. Confirm both against live docs, then confirm a delivered
      message and a received event webhook.
- [ ] **Twilio** — **currently marked `unverified`.** Same condition. Confirm
      request shape, confirm a delivered SMS, and confirm the status callback
      updates the ledger.
- [ ] **Callback signature verification.** Twilio `X-Twilio-Signature` and
      SendGrid's ECDSA event signature are **not implemented** — see
      `REMEDIATION_2_0.md` §4.3. Do not rely on callback data for billing or
      compliance evidence until this is closed.
- [ ] **WhatsApp** — **not implemented.** Do not sign off. Record BSP choice,
      Meta Business verification status, approved template inventory and current
      per-conversation pricing before any implementation begins.

### Deliverability and regulatory

- [ ] SPF, DKIM and DMARC published for each sending domain, with alignment
      confirmed by a receiving provider's report, not by a DNS lookup alone.
- [ ] Sending domain and IP warm-up plan agreed before first bulk send.
- [ ] **India DLT/DND:** sender IDs and templates registered with the relevant
      access provider, and scrubbing against DND registries confirmed, before
      any SMS to an Indian number.
- [ ] Consent provenance recorded for every imported contact list. The engine
      enforces suppression; it cannot manufacture a lawful basis for the initial
      contact.
- [ ] Engagement tracking (`engagementTrackingEnabled`) left off unless the
      operator has recorded a lawful basis for behavioural tracking. Delivery
      state is unaffected by this switch.

### Operational

- [ ] `GET /sequences/operations/health` is monitored, with alerting on
      `outcomeUnknown` and on `overdue`. An unknown outcome needs a human; it is
      not a failure to be retried and must not be aggregated into one.
- [ ] A documented runbook exists for reconciling an `outcome_unknown` step,
      including how to determine from the provider whether the message was
      delivered before deciding to re-send.

## Legal and policy gates

These cannot be discharged by software. They are listed here because the code now fails closed on each of them, and the failure is only removed by recording the answer.

- [ ] **[V11]** Counsel has read each provider's developer terms on cached-data deletion after disconnection. Until recorded, `providerDataPolicy` purges all provider-derived data on disconnection with `legalBasis: unreviewed`, and Vault history does not survive a disconnect.
- [ ] **[V14]** Counsel has read the ActiveCampaign API licence for competitive-use restrictions. Until recorded, the connector is `quarantined`: no new connections, no writes.
- [ ] **[V29]** An exhaustive search for an existing HighLevel workflow backup or monitoring product has been completed and filed. No code change depends on this; the go-to-market wedge does.
- [ ] **[V43] / [V44]** Domain availability and trademark clearance completed before any brand spend. Until recorded, problem type URIs remain on the `urn:logicflower:problem` namespace and no brand domain appears in the API contract.

Do not check an item based only on source review or mocks. The accountable operator signs it after live evidence exists.


## Booking pages

- [ ] `db.appointments.getIndexes()` shows the partial unique index on
      `(organizationId, assigneeUserId, startAt, status)`. **This is the
      double-booking guard.** Availability is re-checked immediately before
      writing, but between that check and the write another visitor can take the
      same slot; only the index catches that. Without it two people can book the
      same time and neither will know until they both turn up.
- [ ] Two simultaneous bookings of the same slot produce one appointment and one
      409. Test with concurrent requests, not sequential ones.
- [ ] A business in one timezone and a visitor in another see the same instant:
      the visitor's browser shows their local time, the appointment record holds
      the business's zone.
- [ ] Opening time stays fixed across a daylight-saving change.
- [ ] A buffer holds calendar time clear without shortening the appointment.
- [ ] Minimum notice is enforced — a slot inside the notice window is not offered
      and is refused if posted directly.
- [ ] Publishing a page whose settings would show an empty calendar is refused.
- [ ] Two booking pages pointing at the same assignee see each other's
      bookings and cannot double-book that person.
- [ ] A cancel link cancels, and an invalid token returns the same response as a
      valid one.
- [ ] The confirmation sequence enrols on booking and respects suppression and
      quiet hours like any other sequence.

## Organisation hierarchy and support access

The rules below are the tenant-isolation boundary restated for three tiers. Each
must be verified against a real database, because the resolver is the only thing
standing between an agency and somebody else's client.

### Access resolution

- [ ] A direct membership wins over any inherited authority. A support engineer
      who is also a member of an organisation acts as that member, and no grant
      is consumed or audited.
- [ ] An agency reaches its OWN clients and no others. Create two agencies with
      a client each and confirm neither can switch into the other's.
- [ ] An agency cannot reach another agency, nor the corporate organisation.
- [ ] A client's own staff cannot reach their parent agency, or any sibling
      client. Authority flows downward only.
- [ ] A client's staff see no evidence an agency sits above them —
      `GET /hierarchy/context` returns `tier: 'client'` with no agency id.
- [ ] Every switch writes an audit record naming the user, the organisation and
      the authority used (`membership`, `agency`, `corporate`, `support_grant`).

### Support access

- [ ] **Support with no approved grant is refused**, exactly as a stranger is.
      Verify before testing anything else — this is the property customers are
      being asked to trust.
- [ ] A grant admits support only to the organisation that approved it.
- [ ] A grant expires on its own. Set a short expiry, wait, confirm access stops
      mid-session without anyone acting.
- [ ] Revoking cuts access immediately, not at the next login.
- [ ] `MAX_SUPPORT_GRANT_HOURS` is enforced at approval — a request for a longer
      window is capped rather than honoured.
- [ ] Support cannot approve its own request.
- [ ] `useCount` increments per request, so a customer can compare what support
      did against the reason they were given.
- [ ] Any member, not only an administrator, can see who currently has access.

### Hierarchy views leak nothing

- [ ] `GET /hierarchy/agency/clients` and `/corporate/portfolio` return
      organisation names, member counts and health figures **only**. Confirm no
      contact, message, deal or appointment appears in either response. To read
      a client's data an agency must switch into it, and the request is then
      scoped to that single organisation like any other.

### Tier dashboards

- [ ] A client's navigation contains **no** Agency or Corporate section — not
      hidden by CSS, absent from the DOM. Inspect the rendered markup, not the
      screen.
- [ ] `agencyAccessMode` defaults to `standing` on an agency-provisioned
      workspace and the client can change it to `on_request`.
- [ ] Under `on_request`, the agency is refused without a live approved grant,
      exactly as support is. Verify the refusal before verifying the grant.
- [ ] Switching into a client from the agency console scopes every subsequent
      request to that client alone.
- [ ] The corporate console returns **no** contact, message, deal or appointment
      in any response. Check the network payload, not the screen.
- [ ] The access ledger is readable by a `viewer`, not only an owner or admin.
- [ ] Withdrawing access ends an in-flight session immediately.

## Public website, blog and search settings

- [ ] A non-corporate user receives 403 from every `/content/*` route. Verify
      with a **workspace owner** and an **agency owner**, not only a viewer — a
      workspace role must not open the public website.
- [ ] `support` gets 403 too. Support has no standing access to anything,
      including this.
- [ ] Typing `/website` as a non-corporate user shows a plain refusal, not a
      page shell that flashes and then errors.
- [ ] **Deleting an organisation does NOT delete blog posts, site settings or
      redirects.** These are platform-owned and deliberately absent from the
      erasure registry; confirm that is still true after any change to
      `dataLifecycle.ts`.
- [ ] A scheduled post is not reachable at its public URL before its publication
      time, and is reachable after.
- [ ] A `noindex` post is absent from `/sitemap.xml` and carries a robots meta
      tag when fetched directly.
- [ ] `robotsNoindexAll` blocks the site in **both** `robots.txt` and the page
      metadata. A staging site that leaks through one route while blocked on the
      other is the failure this guards against.
- [ ] Changing the address of a published post is refused, and the redirect
      manager keeps the old link working.
- [ ] Article HTML is escaped: publish a post whose body contains a script tag,
      an `onerror` attribute and a `javascript:` link, then confirm none of them
      execute or appear as markup in the rendered page.
- [ ] `sitemap.xml` uses the configured canonical origin, and every URL in it
      resolves.

## Native CRM workflow triggers

- [ ] Adding a tag to a contact starts a workflow whose trigger is
      `trigger.crm.tagAdded` — with no external CRM involved and no per-action
      charge.
- [ ] A tag trigger narrowed to specific tags fires for `VIP` when written for
      `vip`, and does not fire for an unrelated tag.
- [ ] Moving a deal to a won stage fires `dealWon`, not `dealStageChanged`.
- [ ] **Two workflows that trigger each other stop at the depth limit** rather
      than running until the queue dies. Build the pair deliberately and confirm
      the warning appears in the log.
- [ ] A CRM write retried by its own caller starts the workflow **once**. The
      queue job id is derived from the subject, not the clock — verify by
      replaying the same request.
- [ ] A workflow that fails to dispatch does not roll back the CRM write that
      raised it: the tag stays applied.

## Booking page editing

- [ ] Editing hours on a published page is refused if the new settings would
      show an empty calendar.
- [ ] The slug cannot be changed. Duplicating produces a new address and always
      a draft.
- [ ] Deleting a page with upcoming appointments is refused without explicit
      confirmation, and the appointments survive the deletion.
