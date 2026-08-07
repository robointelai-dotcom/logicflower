# Operations and recovery

## Service objectives

Define alert thresholds from measured traffic, then track at least:

- API availability and p95/p99 latency by route class
- authentication failure/lockout rate and suspicious tenant-boundary denials
- queue depth, oldest runnable job, retry rate, and terminal failure rate
- provider request latency, throttling, token refresh, and webhook verification failures
- batch preview-to-confirm conversion, checkpoint age, partial success, and cancellation time
- MongoDB/Redis capacity, replication, connections, and backup status
- notification delivery and suppression/deduplication rate

Connection and workflow-inventory monitoring is reconciled continuously by the worker. `MONITOR_INTERVAL_MS` controls the per-connection cadence (15 minutes by default); stable interval-bucket job identifiers and recent monitor records suppress duplicate runs.

## Incident priorities

| Severity | Examples | Initial action |
|---|---|---|
| SEV-1 | Cross-tenant access, credential disclosure, destructive writes outside confirmed plan | Disable affected capability, preserve evidence, rotate/revoke, notify incident lead immediately |
| SEV-2 | Widespread login failure, queue unable to progress, provider writes repeatedly failing | Stop new affected work, protect checkpoints, restore service or roll back |
| SEV-3 | Single-tenant degradation, delayed schedules, noisy alerts | Contain, communicate status, repair within normal on-call path |
| SEV-4 | Cosmetic/reporting defect without incorrect durable state | Track and schedule normally |

Never delete failed jobs, webhook receipts, or relevant audit events while an incident is under investigation. Do not place secrets or raw customer records in chat/tickets.

## Disaster recovery objectives

The feasibility report's Chapter 20.3 table specified "Managed Postgres with automated failover and PITR". This deployment runs MongoDB, so those mechanisms describe a system that does not exist here. The targets below are restated against the datastore actually in use.

| Scenario | RTO | RPO | Mechanism in this deployment |
|---|---|---|---|
| Application instance loss | < 5 min | 0 | Stateless API and worker containers behind a health check. No local state; `/readyz` gates traffic on Mongo and Redis reachability. |
| Primary node loss | < 1 min | ~0 | Replica-set election. The driver retries writes through the election, so most in-flight requests survive it. Requires an odd-numbered voting set of at least three members. |
| Database cluster failure | < 30 min | < 5 min | Continuous cloud backup with point-in-time recovery, restoring to a new cluster and repointing `MONGO_URI`. **PITR is the mechanism that meets a 5-minute RPO; the logical `mongodump` in `scripts/backup/` cannot and is not a substitute.** |
| Region failure | < 8 h | < 1 h | Cross-region encrypted copies written by `scripts/backup/backup.sh`, restored via `scripts/backup/restore-drill.sh` into a new cluster in the surviving region. RPO here is the backup interval, not the PITR window. |
| Accidental destructive customer job | N/A | N/A | Batch before-state artefacts retained for the plan's window; rollback is a capability-gated batch operation. Not a database-level restore. |
| Ransomware or credential compromise | < 24 h | < 1 h | Backups encrypted client-side before upload, so the storage credential alone does not read them. Replica-bucket lifecycle is managed by its own policy, so this job's credential cannot delete both copies. Key rotation via `ENCRYPTION_KEY_VERSION`; forced re-authorisation of all provider connections. |

### Two constraints worth stating plainly

**A replica set is required, not optional.** The usage ledger uses transactions and fails closed without them. A standalone `mongod` will not merely degrade the RPO — metered work stops. Single-node replica sets satisfy the transaction requirement but provide no failover, so they are acceptable for development only.

**These are targets, not measurements.** No figure in this table has been observed in this deployment. Each becomes evidence only after the drill below has been run and its output recorded against the backup gate in `LIVE_ACCEPTANCE.md`.

## Backup and restore

Two independent mechanisms, with different jobs:

1. **Continuous cloud backup / PITR** — the primary recovery path, and the only one that meets the sub-5-minute RPO. Configured on the cluster, not in this repository.
2. **Logical encrypted dumps** (`server/scripts/backup/backup.sh`) — a portable artefact you hold outside the provider's control plane. This is what survives a provider-account compromise that deletes the cluster and its snapshots together, and it is what a restore drill exercises.

Object and failed-record artefacts are backed up with bucket versioning. Redis is coordination state only: recovery rebuilds runnable work from durable job records rather than trusting a stale queue snapshot.

### Backup job

```bash
MONGO_URI=... \
BACKUP_S3_BUCKET=logicflower-backups \
BACKUP_REPLICA_BUCKET=logicflower-backups-dr \
BACKUP_REPLICA_REGION=eu-west-1 \
BACKUP_ENCRYPTION_PASSPHRASE=... \
BACKUP_RETENTION_DAYS=35 \
  server/scripts/backup/backup.sh
```

The archive is encrypted before upload, a manifest records both plaintext and ciphertext SHA-256, and the cross-region copy is performed explicitly so a replication failure shows up in the job's exit status rather than silently not happening.

### Restore drill

Quarterly, and once before public launch rather than after it. A backup that has never been restored is not a backup.

```bash
RESTORE_TARGET_URI=mongodb://.../logicflower-restore-drill \
BACKUP_S3_BUCKET=logicflower-backups \
BACKUP_ENCRYPTION_PASSPHRASE=... \
BACKUP_STAMP=2026-08-05T03-00-00Z \
  server/scripts/backup/restore-drill.sh
```

The script refuses to run when the target equals the live `MONGO_URI`, or when the target name does not look isolated. It verifies the ciphertext hash against the manifest before decrypting, and — because `mongorestore` exits zero on an empty restore — asserts that expected collections came back non-empty. It writes a hashed evidence record and exits non-zero on failure.

Alongside the automated checks, each drill should still:

1. verify indexes, tenant counts, job-state invariants, snapshot hashes and audit continuity;
2. rebuild queues without executing provider writes;
3. exercise a read-only login and preview flow;
4. destroy the isolated copy per the data-retention procedure;
5. record actual recovery time and data loss against the targets above.

## Queue recovery

On worker outage, prevent duplicate schedulers, restore dependencies, and restart a single worker group first. Reconcile durable jobs in queued/running/retrying states. Jobs with expired leases return to runnable state; already-recorded idempotency keys prevent duplicate side effects. Increase concurrency only after provider throttling and checkpoint movement are healthy.

## Credential incident

Disable the connection, stop its runnable jobs, revoke the provider credential, rotate encryption/signing material if exposure is possible, invalidate affected sessions, and search redacted telemetry/audit history for use. Re-authorization creates new encrypted material; it must never reactivate a possibly exposed token.

## Customer disconnect and deletion

Disconnect immediately blocks new provider work and attempts provider revocation. Deletion is an audited background process that removes cached tenant data according to contractual retention requirements while retaining only legally/operationally required, minimized audit/billing records. Confirm completion to the requester without revealing internal identifiers or secrets.
