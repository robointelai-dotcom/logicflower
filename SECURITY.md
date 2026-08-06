# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Send a minimal reproduction, affected version, and impact assessment to the security contact configured for the deployment. Do not include customer data, access tokens, passwords, or private keys in the report.

Until a public security address is configured, production deployment is blocked by the live acceptance checklist.

### Safe harbour

Research conducted in good faith under this policy is authorised, and we will not pursue or support legal action against you for it. Good faith means:

- you test only against your own account or an account you have written permission to test;
- you stop as soon as you have confirmed a vulnerability, and do not access, modify, delete, or exfiltrate data belonging to anyone else;
- you do not degrade service for other users — no denial-of-service, no automated scanning that generates production load, no social engineering of staff or customers;
- you give us a reasonable opportunity to remediate before disclosing publicly.

If you are unsure whether an action is in scope, ask first. We will not treat a question as an admission.

### What to expect

| Stage | Target |
|---|---|
| Acknowledgement of your report | 3 business days |
| Initial triage and severity assessment | 10 business days |
| Remediation of a confirmed critical issue | 30 days, or a written explanation of why longer is necessary |
| Public disclosure | Coordinated with you; we will not ask for indefinite silence |

These are targets, not contractual commitments, and they are unproven — no report has yet been received through this process.

### Out of scope

Reports consisting solely of automated scanner output with no demonstrated impact; missing headers with no exploitable consequence; vulnerabilities in third-party services we do not control; and anything requiring physical access or a compromised endpoint.

### Recognition

We will credit you in the remediation notes unless you prefer otherwise. There is currently **no monetary bounty programme**; we would rather say so plainly than imply one exists.

## Security invariants

- Every tenant-owned record and queued job is scoped to an `organizationId` derived from the authenticated session, never from a trusted-looking request body alone.
- Membership and role authorization are enforced server-side. Hiding a control in the browser is not authorization.
- Provider credentials are encrypted at rest with authenticated encryption and are redacted from logs and API responses.
- Access sessions are short-lived; refresh sessions are revocable and rotated. Browser credentials use `HttpOnly`, `Secure` in production, and an explicit `SameSite` policy.
- Passwords are slow-hashed, login attempts are rate-limited, and repeated failure creates a temporary lockout.
- OAuth callbacks validate short-lived, one-time state bound to both the organisation and initiating session.
- Webhook bodies are size-limited, signatures are verified against the raw body, timestamps are checked where supported, and event identifiers are processed idempotently.
- Customer-supplied JavaScript, shell commands, templates with property traversal, and private-network HTTP targets are prohibited.
- Destructive batch operations default to preview, require an explicit confirmation token tied to the immutable plan, and preserve a before-state/failed-record artefact for the configured retention period.
- Sensitive values are never accepted through query strings and are never included in audit metadata.
- Every query against a tenant-owned model constrains by `organizationId`, enforced statically at build time by `scripts/tenant-isolation-guard.mjs`. Exceptions are annotated inline with a written reason and are enumerated on every run.
- Record encryption uses versioned data keys under a key-management provider; rotation is additive, so no ciphertext becomes unreadable during a key change.

## Verified and unverified

This distinction is deliberate and is maintained honestly.

**Verified by automation on every build:** tenant-isolation predicates, absence of JavaScript evaluation, absence of raw HTTP workflow executors, absence of hardcoded brand URLs, absence of a requested-to-granted scope fallback, no authentication tokens in browser storage, SSRF and DNS-pinning behaviour, webhook signature and freshness logic, encryption round-trip and rotation, and response header policy.

**Not verified, and not claimed:** penetration testing, provider sandbox behaviour, backup restoration, and load behaviour. These are tracked in [docs/LIVE_ACCEPTANCE.md](docs/LIVE_ACCEPTANCE.md) and remain unchecked until an accountable operator records evidence. A control that has been written is not a control that has been observed.

## Related documents

- [Incident response plan](docs/INCIDENT_RESPONSE.md) — severity definitions, containment, statutory clocks
- [Subprocessors](docs/SUBPROCESSORS.md) — third parties that may process customer data
- [Live acceptance](docs/LIVE_ACCEPTANCE.md) — evidence gates that must pass before production

## Secret management

`server/.env.example` contains names and non-secret placeholders only. Never commit `.env`, OAuth tokens, Stripe signing secrets, SMTP passwords, database credentials, cookie secrets, or the encryption key. Production should inject them from a managed secret store and restrict read access to the API/worker runtime identities.

Rotate secrets independently. Rotation order is:

1. add the new verification/decryption key while retaining the old key;
2. rotate active sessions or re-encrypt stored connection material;
3. make the new key primary;
4. remove the old key after the maximum token/session lifetime and an audited verification pass.

## Dependency and release policy

Every release must pass `npm run verify`, production dependency audit, container scanning, tenant-isolation tests, authentication-abuse tests, webhook verification tests, and backup restore validation. High or critical findings block deployment unless a written, time-bounded risk acceptance is approved by the accountable owner.

## Data handling

Collect only fields needed for an enabled capability. Connection disconnect/delete revokes provider credentials where supported, stops new jobs, and schedules tenant-owned cached data for deletion under the configured retention policy. Audit records contain identifiers and outcomes, not secrets or raw customer payloads.

