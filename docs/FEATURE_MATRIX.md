# Feature and release gates

This matrix defines completion as an observable behavior. A screen or route existing is not sufficient.

| Capability | Required proof |
|---|---|
| Authentication | Register/bootstrap policy, verified login, rotating refresh, logout/revoke-all, password reset, lockout/rate limits, optional MFA path, secure cookies |
| Organisations | Create/select organisation, scoped membership, invitations, role changes, ownership safety, cross-tenant negative tests |
| Connections | Encrypted secrets, OAuth state, refresh locking, health/re-auth/revoke/delete, capability/scopes display, no secret serialization |
| Workflows | Validated structured graph, immutable versions, publish/disable, bounded execution, deterministic retries, idempotent side effects |
| Batch | Import/query target, preview default, impact estimate, confirmation digest, chunk/checkpoint, pause/resume/cancel, failed export, before-state |
| Webhooks | Raw-body verification, freshness/replay defense, durable receipt, idempotent dispatch, provider-specific verification |
| Schedules | Tenant-scoped timezone-aware schedule, lease-safe dispatch, missed-run policy, disable/delete, audit trail |
| Watch | Connection/job/webhook/schedule health, deduplicated incidents, acknowledgement/resolution, email/webhook routing |
| Vault | Tenant-scoped snapshots, immutable versions, structural diff, export, retention/delete, honest capability gating |
| Sync | Mapping validation, direction/conflict policy, cursor/checkpoint, loop prevention, replay/reconciliation |
| AI | Per-organisation BYOK, consent record, schema-constrained output, timeout/budget, redaction, deterministic failure path |
| Billing and usage | Stripe-signed events, idempotent plan state, entitlements, immutable usage events, aggregation/reconciliation, portal |
| Audit | Append-only security/admin events with actor, organisation, action, target, outcome, request correlation; no secrets |
| Operations | Liveness/readiness, structured redacted logs, metrics, backups/restore, queue recovery, CI and container builds |
| Web application | Responsive accessible navigation; loading/empty/error states; auth/org/role handling; all API errors actionable; no tokens in browser storage |

## Definition of done

A capability is release-ready only when its implementation, authorization, validation, failure handling, telemetry, documentation, tests, and applicable live-provider acceptance all pass. Provider-dependent items can be code-complete while remaining disabled pending credentials or marketplace approval; that distinction must be visible in both administration and release notes.

