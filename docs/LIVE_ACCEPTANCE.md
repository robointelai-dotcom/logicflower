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

## Legal and policy gates

These cannot be discharged by software. They are listed here because the code now fails closed on each of them, and the failure is only removed by recording the answer.

- [ ] **[V11]** Counsel has read each provider's developer terms on cached-data deletion after disconnection. Until recorded, `providerDataPolicy` purges all provider-derived data on disconnection with `legalBasis: unreviewed`, and Vault history does not survive a disconnect.
- [ ] **[V14]** Counsel has read the ActiveCampaign API licence for competitive-use restrictions. Until recorded, the connector is `quarantined`: no new connections, no writes.
- [ ] **[V29]** An exhaustive search for an existing HighLevel workflow backup or monitoring product has been completed and filed. No code change depends on this; the go-to-market wedge does.
- [ ] **[V43] / [V44]** Domain availability and trademark clearance completed before any brand spend. Until recorded, problem type URIs remain on the `urn:logicflower:problem` namespace and no brand domain appears in the API contract.

Do not check an item based only on source review or mocks. The accountable operator signs it after live evidence exists.

