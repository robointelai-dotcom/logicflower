# Incident response plan

Owner: the accountable security contact named in [SECURITY.md](../SECURITY.md).
Review: every six months, and after every SEV-1 or SEV-2.

This plan is written to be usable at 3am by someone who did not write it.

## Severity definitions

Severity is set by impact, not by cause. Set it high and downgrade later; the reverse wastes the only hour that matters.

| Level | Definition | Examples | Response |
|---|---|---|---|
| **SEV-1** | Confirmed or suspected unauthorised access to customer data, credentials, or cross-tenant data exposure. | Tenant isolation failure; provider token exfiltration; database exposed. | Immediate. Page the security contact. Start the clock in "Statutory clocks" below. |
| **SEV-2** | Customer-visible loss of service or integrity, no evidence of unauthorised access. | Queue not progressing; provider writes repeatedly failing; incorrect bulk write into a customer account. | Within 1 hour. Stop affected work before diagnosing. |
| **SEV-3** | Degraded service with a workaround, or a security weakness with no evidence of exploitation. | Elevated error rate; dependency vulnerability with no reachable path. | Next business day. |
| **SEV-4** | No customer impact. | Internal tooling failure; low-severity finding in a scan. | Scheduled work. |

**A single incorrect bulk write into a live customer account is at minimum SEV-2**, and SEV-1 if the before-state artefact is missing. The feasibility report identifies this as the primary technical risk; treat it accordingly rather than as a support ticket.

## First thirty minutes

1. **Declare.** State the severity and take the incident-lead role explicitly. An incident without a named lead has no one deciding.
2. **Stop the bleeding before diagnosing.** Disable the affected connection, pause the batch, or scale the worker to zero. Root cause can wait; further writes cannot be undone.
3. **Preserve evidence.** Do not delete failed jobs, webhook receipts, audit events, or artefacts while an incident is open. Retention purges are suspended for the affected organisation.
4. **Open a timeline.** Record every action with a UTC timestamp as you take it. Reconstructing it afterwards produces a document nobody can defend.
5. **Correlate.** Every response carries a `correlationId`. It is the fastest route from a customer report to the request, the execution, and the audit entries.

## Containment by incident type

**Credential compromise** — disable the connection, stop its runnable jobs, revoke the provider credential, rotate encryption and signing material if exposure is possible (`ENCRYPTION_KEY_VERSION`, then `npm run rotate:rewrap --prefix server`), invalidate affected sessions, and search redacted telemetry and audit history for use. Re-authorisation must create new material; it must never reactivate a possibly exposed token.

**Suspected cross-tenant exposure** — this is SEV-1 by definition. Capture the offending request and its `correlationId`, identify every organisation whose data could have been returned, and preserve the audit range before anything else. Do not deploy a fix until the blast radius is known; a fix destroys the evidence of what was reachable.

**Incorrect bulk write** — pause the batch, locate the `batch_before_state` artefact, and confirm it covers every affected record before attempting any compensating operation. Partial before-state means partial rollback, which is worse than none because it looks like a safety net.

**Infrastructure or data loss** — see the disaster-recovery objectives and restore runbooks in [OPERATIONS.md](OPERATIONS.md).

## Statutory clocks

These start when the organisation becomes **aware** of a personal-data breach, not when it finishes investigating. Awareness is a low bar and does not require certainty.

| Obligation | Clock | Notes |
|---|---|---|
| GDPR / UK GDPR — notify the supervisory authority | **72 hours** from awareness | Required even if the investigation is incomplete; notify with what is known and supplement later. |
| GDPR / UK GDPR — notify data subjects | Without undue delay | Required where there is high risk to rights and freedoms. |
| India DPDP Act — notify the Data Protection Board and affected data principals | Follow the timing prescribed by the Board's current rules | Confirm the current requirement with counsel; it is not assumed here. |
| Contractual — notify affected customers | Per the DPA signed with each customer | Frequently stricter than statute. Check the actual agreements. |

> These are the obligations as understood at the time of writing and have **not** been reviewed by counsel. Confirm each with a qualified lawyer before relying on it. Recording an unreviewed clock is safer than recording none; treating one as legal advice is not.

Because a supervisory-authority clock can start before anyone knows the extent, the incident lead's first act on a suspected data breach is to notify the accountable person who can make the disclosure decision. That person is not necessarily the engineer on call.

## Communications

- Do not place secrets, credentials, or raw customer records in chat, tickets, or status updates.
- Status page updates say what is affected and when the next update comes. They do not speculate about cause.
- One person owns external communication. Engineers do not brief customers directly during an active incident.

## After the incident

Within five business days: a written review covering timeline, customer impact, contributing factors, what detected it, what should have detected it, and corrective actions with named owners and dates.

Blameless in tone, specific in content. "Human error" is not a contributing factor; the absence of a guardrail that would have caught the error is.

Every SEV-1 and SEV-2 review must answer one question explicitly: **would an automated check have caught this, and can we add it?** The tenant-isolation guard, the dry-run gate, and the capability provenance model each exist because that question has a cost attached when it goes unasked.

## Rehearsal

Once before public launch, then annually. A plan that has never been exercised is a document, not a capability — the same reasoning that makes an unrestored backup not a backup.

Rehearse at minimum: a credential compromise, a suspected cross-tenant exposure, and a restore from backup.
