# Remediation record — 1.1.2

Covers Category A (Stage 1–2 security controls), Category B (technical debt D3–D8 and Pricing Rule 5), and Category C (infrastructure and compliance reconciliation).

## Summary matrix

| Ref | Control | Status | Evidence |
|---|---|---|---|
| A1 | Envelope encryption, versioned data keys | **Resolved** | `security/kms/kmsProvider.ts`, `security/keyring.ts`, `security/encryption.ts` (v2 format) |
| A1 | Zero-downtime key rotation | **Resolved** | `services/keyRotation.ts`, `scripts/rotate-keys.ts`; proven by test — ciphertext written before rotation still decrypts after |
| A2 | Managed secret injection | **Resolved in code**, unexercised against a live store | `config/secretStore.ts`, `bootstrapRuntime.ts` |
| A3 | Webhook freshness for GHL / ActiveCampaign | **Resolved** | `services/webhookSecurity.ts`; 8-day replay now rejected |
| A4 | Secure SDLC pipeline | **Resolved in config**, never executed on a runner | `.github/workflows/security.yml`, `.gitleaks.toml`, `eslint.config.mjs`; `npm run lint:security` passes locally with zero findings |
| A5 | Backup and restore automation | **Resolved in code**, never run against a real cluster | `scripts/backup/backup.sh`, `scripts/backup/restore-drill.sh` |
| D3 | CSV streaming | **Resolved** | `services/csvIngest.ts`, `createBatchFromChunks`; 7 tests |
| D5 | TOTP replay ring | **Resolved** | `auth/mfa.ts`; test proves the A→B→A replay is now rejected |
| D6 | Provider key overrides | **Resolved** | `GHL_WEBHOOK_PUBLIC_KEY`, `GHL_LEGACY_WEBHOOK_PUBLIC_KEY` |
| D7 | Scan cap parameterised | **Resolved** | `CONNECTION_SCAN_LIMIT`, `CONNECTION_SCAN_MAX_LIMIT` |
| D8 | Empty directories | **Resolved** | Four removed |
| Rule 5 | Grandfathered pricing | **Resolved** | `services/pricingLock.ts`, `priceLocked` / `legacyPlanId` on Organization |
| C1 | MongoDB DR realignment | **Resolved as documentation** | `docs/OPERATIONS.md`; targets are stated, not measured |
| C2 | [V3] contingency flag | **Resolved** | `services/watchMode.ts`, `FEATURE_WATCH_WORKFLOWS_ENABLED`, surfaced on `/readyz` |

## Verification

| Gate | 1.1.1 | 1.1.2 |
|---|---|---|
| Repository guardrails | 251 files | 266 files |
| ESLint security rules | did not exist | 0 findings |
| Server TypeScript | clean | clean |
| Client TypeScript | clean | clean |
| Server tests | 25 files / 120 | **27 files / 147** |
| Client tests | 2 / 6 | 2 / 6 |
| Production builds | pass | pass |

## Design notes worth reading

### A1 — why the call surface stayed synchronous

Fourteen modules call `encryptString` / `decryptString` synchronously. A textbook envelope design calls KMS Decrypt per operation, which would have forced every one of them async — a large refactor, a network round trip on every record read, and no additional security.

KMS therefore wraps *data keys*, not payloads. Keys are unwrapped once into a cached keyring at boot, and record encryption stays local and synchronous. `LocalKmsProvider` derives versioned keys by HKDF, so development and tests need no external service; `AwsKmsProvider` returns `null` from `unwrapDataKeySync`, which makes a hidden blocking network call structurally impossible and forces explicit boot-time initialisation.

Rotation is additive, not a cutover. Raising `ENCRYPTION_KEY_VERSION` makes a new key active for writes while every prior version stays loaded. There is no window in which a record is unreadable, the re-wrap job is interruptible and idempotent, and v1 ciphertext remains readable permanently — dropping it would strand every credential written before the upgrade.

### A3 — freshness without a timestamp header

HubSpot and Klaviyo send signature timestamps; HighLevel and ActiveCampaign do not. Freshness is therefore evaluated against the timestamp *inside the signed body*, which is still a real defence because an attacker cannot advance it without invalidating the signature. A payload with no usable timestamp returns `no_timestamp` and is rejected by default rather than passing silently.

An existing test asserted the old behaviour — that a timestamp-less payload was accepted. It was updated to the new contract. Worth knowing that the vulnerability was pinned by a passing test.

### A4 — two ReDoS findings were false positives, and were verified as such

ESLint flagged three regexes as unsafe. All three were tested against 120k–200k character adversarial inputs and completed in 1–3 ms. The character classes are disjoint (`[^\s]+` versus `\s+`, and anchored segments versus `.`), so there is no ambiguous split for a backtracking engine to explore.

Length bounds were added as defence in depth and the suppressions carry the reasoning inline. The rule was not disabled globally — a security rule turned off wholesale stops finding the real instance later.

### B5 — grandfathering is a price guarantee, not a feature freeze

`lockPrice` deliberately takes no expiry parameter, because "permanently" in the report means permanently and an optional duration makes it trivial to ship a lock that quietly lapses. `limitsForLockedPlan` resolves entitlements from the current tier rather than the legacy price identifier: resolving from the legacy price would lock a grandfathered customer out of every subsequent allowance increase, turning a loyalty reward into a penalty.

### C1 — the DR table described a database this project does not use

Chapter 20.3 specified managed Postgres with PITR. The build is MongoDB, so the mechanism column described a system that does not exist. Targets are restated against replica-set elections and continuous cloud backup.

Two constraints are now stated explicitly: a replica set is **required** rather than recommended, because the usage ledger uses transactions and fails closed without them; and the logical `mongodump` is **not** the mechanism that meets a 5-minute RPO — PITR is. A logical dump alone cannot, and presenting it as though it could would be the same category of error as the Postgres reference.

## What 1.1.2 still may not claim

1. That any of this works in production. Every control is verified statically or by unit test; none has run against AWS KMS, a real secret store, a real cluster, or a GitHub runner.
2. That backups are restorable. The drill script exists and its safety guards were proven to fire; it has never restored a real backup.
3. That the DR targets are achievable. They are targets. No figure in the table has been observed.
4. That the isolation suite passes. Carried forward from 1.1.1 — written, CI-gated, still never executed.
5. Anything about [V3], [V11], [V14] or [V29]. Unchanged: those need a scope grant, counsel, and an afternoon in the marketplace.
