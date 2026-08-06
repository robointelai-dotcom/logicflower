#!/usr/bin/env bash
#
# Encrypted logical backup for MongoDB, with cross-region replication and
# retention enforcement.
#
# Scope, stated plainly: this is a logical `mongodump`. It is the right tool for
# a portable, verifiable, restore-drillable artefact, and it is NOT the primary
# recovery mechanism. Point-in-time recovery comes from the cluster's own
# continuous backup (Atlas PITR or an equivalent oplog-based mechanism); see
# docs/OPERATIONS.md. A logical dump alone cannot meet a 5-minute RPO, and
# anything claiming otherwise is measuring the wrong thing.
#
# What this gives you that PITR does not:
#   - an artefact you hold, outside the provider's control plane
#   - a restore drill that can run in an isolated environment
#   - protection against a provider-account compromise deleting the cluster
#     and its snapshots together
#
set -Eeuo pipefail

: "${MONGO_URI:?MONGO_URI is required}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"

BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-logicflower/backups}"
BACKUP_REGION="${BACKUP_REGION:-us-east-1}"
BACKUP_REPLICA_BUCKET="${BACKUP_REPLICA_BUCKET:-}"
BACKUP_REPLICA_REGION="${BACKUP_REPLICA_REGION:-}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-35}"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
WORKDIR="$(mktemp -d)"
ARCHIVE="${WORKDIR}/logicflower-${STAMP}.archive.gz"
SEALED="${ARCHIVE}.enc"

cleanup() { rm -rf "${WORKDIR}"; }
trap cleanup EXIT

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

log "starting logical dump"
mongodump --uri="${MONGO_URI}" --archive="${ARCHIVE}" --gzip --readPreference=secondaryPreferred

# Encrypted before it leaves the host. Server-side encryption alone would mean
# the backup is readable by anyone holding the storage credential, which is
# exactly the credential an attacker who reached the account already has.
log "encrypting archive"
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -in "${ARCHIVE}" -out "${SEALED}" \
  -pass env:BACKUP_ENCRYPTION_PASSPHRASE

PLAIN_SHA="$(sha256sum "${ARCHIVE}" | awk '{print $1}')"
SEALED_SHA="$(sha256sum "${SEALED}" | awk '{print $1}')"

cat > "${WORKDIR}/manifest.json" <<JSON
{
  "schemaVersion": 1,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "archive": "logicflower-${STAMP}.archive.gz.enc",
  "plaintextSha256": "${PLAIN_SHA}",
  "ciphertextSha256": "${SEALED_SHA}",
  "sizeBytes": $(stat -c%s "${SEALED}"),
  "cipher": "aes-256-cbc/pbkdf2-600000",
  "sourceRegion": "${BACKUP_REGION}",
  "replicaBucket": "${BACKUP_REPLICA_BUCKET}",
  "retentionDays": ${BACKUP_RETENTION_DAYS},
  "restoreVerified": false
}
JSON

DEST="s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/${STAMP}"
log "uploading to ${DEST}"
aws s3 cp "${SEALED}" "${DEST}/" --region "${BACKUP_REGION}" --only-show-errors
aws s3 cp "${WORKDIR}/manifest.json" "${DEST}/" --region "${BACKUP_REGION}" --only-show-errors

# Cross-region copy. Done explicitly rather than relying solely on bucket
# replication configuration, so a failure is visible in this job's exit status
# instead of silently not happening.
if [[ -n "${BACKUP_REPLICA_BUCKET}" && -n "${BACKUP_REPLICA_REGION}" ]]; then
  log "replicating to ${BACKUP_REPLICA_BUCKET} (${BACKUP_REPLICA_REGION})"
  aws s3 cp "${DEST}/" "s3://${BACKUP_REPLICA_BUCKET}/${BACKUP_S3_PREFIX}/${STAMP}/" \
    --recursive --source-region "${BACKUP_REGION}" --region "${BACKUP_REPLICA_REGION}" --only-show-errors
else
  log "WARNING no replica bucket configured; this backup exists in one region only"
fi

# Retention. Applied to the primary only: the replica's lifecycle is managed by
# its own bucket policy so that a compromise of this job's credential cannot
# delete both copies.
log "enforcing ${BACKUP_RETENTION_DAYS}-day retention on the primary bucket"
CUTOFF="$(date -u -d "${BACKUP_RETENTION_DAYS} days ago" +%Y-%m-%dT%H-%M-%SZ)"
aws s3 ls "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/" --region "${BACKUP_REGION}" \
  | awk '{print $2}' | tr -d '/' | while read -r entry; do
      [[ -z "${entry}" ]] && continue
      if [[ "${entry}" < "${CUTOFF}" ]]; then
        log "expiring ${entry}"
        aws s3 rm "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/${entry}/" --recursive --region "${BACKUP_REGION}" --only-show-errors
      fi
    done

log "backup complete: ${DEST} (sha256 ${SEALED_SHA})"
log "REMINDER a backup that has never been restored is not a backup; run scripts/backup/restore-drill.sh"
