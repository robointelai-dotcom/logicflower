#!/usr/bin/env bash
#
# Restore drill.
#
# The report's note is the whole reason this file exists: "Backups that have
# never been restored are not backups." This script restores a chosen backup
# into an isolated target, counts what came back, and writes a signed evidence
# record. It refuses to run against anything that looks like production.
#
# Exit status is the assertion: non-zero means the backup did not restore, and
# that is a finding, not a warning.
#
set -Eeuo pipefail

: "${RESTORE_TARGET_URI:?RESTORE_TARGET_URI is required (an isolated cluster, never production)}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"
: "${BACKUP_STAMP:?BACKUP_STAMP is required (the timestamp directory to restore)}"

BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-logicflower/backups}"
BACKUP_REGION="${BACKUP_REGION:-us-east-1}"
EVIDENCE_DIR="${RESTORE_EVIDENCE_DIR:-./restore-evidence}"
# Collections whose emptiness after a restore means the restore failed, even if
# mongorestore exited zero.
EXPECTED_COLLECTIONS="${RESTORE_EXPECTED_COLLECTIONS:-organizations users memberships platformconnections}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# A drill that can overwrite production is not a drill.
if [[ "${RESTORE_TARGET_URI}" == "${MONGO_URI:-}" ]]; then
  log "FATAL restore target is the live MONGO_URI; refusing"
  exit 2
fi
if [[ "${RESTORE_ALLOW_UNSAFE_TARGET:-0}" != "1" ]] && [[ ! "${RESTORE_TARGET_URI}" =~ (restore|drill|staging|test) ]]; then
  log "FATAL restore target does not look isolated. Name it with restore/drill/staging/test, or set RESTORE_ALLOW_UNSAFE_TARGET=1 deliberately."
  exit 2
fi

WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "${WORKDIR}"; }
trap cleanup EXIT

SRC="s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/${BACKUP_STAMP}"
log "fetching ${SRC}"
aws s3 cp "${SRC}/" "${WORKDIR}/" --recursive --region "${BACKUP_REGION}" --only-show-errors

SEALED="$(find "${WORKDIR}" -name '*.archive.gz.enc' | head -n1)"
[[ -f "${SEALED}" ]] || { log "FATAL no encrypted archive found in ${SRC}"; exit 1; }

# Verify the ciphertext hash before spending time decrypting it.
if [[ -f "${WORKDIR}/manifest.json" ]]; then
  EXPECTED="$(python3 -c "import json;print(json.load(open('${WORKDIR}/manifest.json'))['ciphertextSha256'])")"
  ACTUAL="$(sha256sum "${SEALED}" | awk '{print $1}')"
  if [[ "${EXPECTED}" != "${ACTUAL}" ]]; then
    log "FATAL ciphertext hash mismatch: manifest ${EXPECTED}, actual ${ACTUAL}"
    exit 1
  fi
  log "ciphertext hash verified"
fi

ARCHIVE="${WORKDIR}/restore.archive.gz"
log "decrypting"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in "${SEALED}" -out "${ARCHIVE}" -pass env:BACKUP_ENCRYPTION_PASSPHRASE

START_EPOCH=$(date -u +%s)
log "restoring into the isolated target"
mongorestore --uri="${RESTORE_TARGET_URI}" --archive="${ARCHIVE}" --gzip --drop
END_EPOCH=$(date -u +%s)
DURATION=$(( END_EPOCH - START_EPOCH ))

# mongorestore exiting zero is necessary but not sufficient. An empty restore
# also exits zero, and an empty restore is the failure mode that matters.
log "verifying restored collections"
FAILURES=0
COUNTS="{}"
for collection in ${EXPECTED_COLLECTIONS}; do
  COUNT="$(mongosh "${RESTORE_TARGET_URI}" --quiet --eval "db.getCollection('${collection}').countDocuments({})" || echo 0)"
  log "  ${collection}: ${COUNT}"
  COUNTS="$(python3 -c "
import json,sys
d=json.loads('''${COUNTS}''')
d['${collection}']=int('${COUNT}' or 0)
print(json.dumps(d))
")"
  if [[ "${COUNT}" -eq 0 ]]; then
    log "  FAIL ${collection} restored empty"
    FAILURES=$(( FAILURES + 1 ))
  fi
done

mkdir -p "${EVIDENCE_DIR}"
EVIDENCE="${EVIDENCE_DIR}/restore-drill-${BACKUP_STAMP}.json"
python3 - <<PY > "${EVIDENCE}"
import hashlib, json, datetime
record = {
    "schemaVersion": 1,
    "backupStamp": "${BACKUP_STAMP}",
    "performedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "restoreDurationSeconds": ${DURATION},
    "collectionCounts": json.loads('''${COUNTS}'''),
    "emptyCollections": ${FAILURES},
    "outcome": "pass" if ${FAILURES} == 0 else "fail",
}
record["evidenceHash"] = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
print(json.dumps(record, indent=2))
PY

log "evidence written to ${EVIDENCE}"
if [[ "${FAILURES}" -gt 0 ]]; then
  log "RESTORE DRILL FAILED: ${FAILURES} expected collection(s) came back empty"
  exit 1
fi
log "RESTORE DRILL PASSED in ${DURATION}s — record this against the LIVE_ACCEPTANCE backup gate"
