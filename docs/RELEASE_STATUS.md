# Release status

> **1.1.1 supersedes the 1.1.0 completion claims.** See [REMEDIATION_1_1_1.md](REMEDIATION_1_1_1.md).
> Functions 4, 5, 6 and 8 are **not** deliverable until a provider capability probe records `available` for the relevant connection; the earlier "Complete" markings assumed a scope grant that was never confirmed. Duplicate resolution plans but does not execute. Overage is measured, not charged. Tenant isolation has a suite that has not yet run.

The independent 2026-08-05 re-audit is recorded in [COMPLETION_AUDIT.md](COMPLETION_AUDIT.md). Release 1.1.0 scores **100/100 for the defined, code-verifiable application implementation scope**. Live-provider, infrastructure, legal and third-party security acceptance remain evidence-gated in [LIVE_ACCEPTANCE.md](LIVE_ACCEPTANCE.md).

## What the report’s “72 / 100” means

The feasibility report's `72 / 100` is a weighted commercial **build-decision score**, not a measurement that the original repository was 72% implemented. It combines demand, differentiation, feasibility, economics, platform dependence, legal exposure, capital intensity, and founder fit. Source code cannot turn that business-risk score into 100/100.

This release is measured instead against the report's fourteen recommended launch functions and the repository's deterministic release gates.

## Recommended launch functions

| # | Function | Source status | Deployment acceptance |
|---:|---|---|---|
| 1 | Organisation accounts, users, roles and permissions | Complete | Create two staging tenants and run the isolation checklist |
| 2 | HighLevel OAuth with encrypted credentials | Complete, configuration-gated | Register the real app/scopes and pass sandbox install/reconnect/revoke tests |
| 3 | Database and repository tenant isolation | Complete | Run migration/index creation and staging negative tests |
| 4 | Automatic workflow inventory | Complete where a provider exposes the required read scope | Verify each enabled provider's current scope and response contract |
| 5 | Continuous workflow monitoring and change detection | Complete | Tune `MONITOR_INTERVAL_MS` and validate against real accounts |
| 6 | Break/failure detection and human-readable incidents | Complete | Exercise outage, expired-token and changed-workflow scenarios |
| 7 | Email, Slack and signed-webhook alert routing | Complete | Configure SMTP/endpoints and perform delivery tests |
| 8 | Cross-account workflow/connection health dashboard | Complete | Validate data at expected production account volume |
| 9 | Governed batch formatting, normalisation and deduplication | Complete | Run the 50,000-record acceptance case with regional fixtures |
| 10 | Mandatory dry-run and pre-flight impact estimate | Complete | Compare preview digest/counters to a sandbox write run |
| 11 | Partial-success accounting and encrypted failed-record export | Complete | Verify tenant-only download, expiry and object-storage lifecycle |
| 12 | Job/execution history and append-only audit events | Complete | Connect long-term log/metrics retention and incident tooling |
| 13 | Stripe subscriptions, atomic usage metering and tier enforcement | Complete | Configure products/prices and pass Stripe test-mode reconciliation |
| 14 | Self-serve onboarding to first monitored connection/workflow | Complete | Time an unaided staging onboarding with production OAuth consent |

## Additional implemented modules

- Structured no-code workflow Studio and immutable workflow versions.
- Safe expression/condition/split/delay execution without customer JavaScript.
- HubSpot, Klaviyo, ActiveCampaign, Google Sheets and generic HTTPS connector adapters.
- Provider-signed webhook ingestion with raw-body verification, replay freshness, durable receipt and fan-out.
- Vault snapshot history, structural diff and encrypted neutral export where provider read capability exists.
- BYOK structured AI for OpenAI, Anthropic and Google AI with owner consent, model/budget allowlists, strict JSON Schema output, local validation and metering.
- Batch pause/resume/cancel/retry and capability-gated rollback from complete before-state data.
- Reports, usage, billing portal, audit, destination allowlists, MFA, session management and platform administration.
- Docker API/web/worker topology, MongoDB replica set, Redis queues, durable artifact volume/S3 option, CI, security guardrails and operational runbooks.

## Deliberate boundaries

The report explicitly places whole-workflow migration, unrestricted free-form execution, full bidirectional multi-system sync, managed AI credits and full white-label agency billing outside the recommended public-launch scope. This release does not pretend those platform-dependent roadmap ideas are safe or approved. It provides governed one-directional Google Sheets operations and reviewed batch synchronisation; it does not claim a general conflict-resolving sync engine.

“Complete” above means implemented, authorization-scoped, validated, failure-handled, documented and covered by the local release gates. It does not mean a third party has issued OAuth approval, accepted marketplace terms, delivered SMTP mail, charged a real/test card, created DNS/TLS, or passed provider sandbox traffic. Those evidence-dependent steps remain unchecked in [LIVE_ACCEPTANCE.md](LIVE_ACCEPTANCE.md) until an accountable operator runs them with real deployment credentials.
