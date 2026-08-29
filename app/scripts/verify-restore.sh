#!/usr/bin/env bash
#
# Restores the newest backup into a throwaway database and proves it is usable.
#
# The reason this exists: `mongodump` exits 0 in several situations that leave an
# archive you cannot restore — a connection dropped partway, credentials that
# could read some collections and not others, a truncated write when a disk
# filled. None of them announce themselves. You find out at the one moment you
# cannot afford to.
#
# So the archive is restored for real, on a schedule, and the result is checked
# against production. An untested backup is a hypothesis.
#
#   ./scripts/verify-restore.sh                  newest archive in ./backups
#   ./scripts/verify-restore.sh path/to.archive.gz
#
# Environment:
#   VERIFY_TARGET_URI   where to restore. Defaults to MONGODB_URI — i.e. the
#                       production cluster, in a scratch database that is dropped
#                       afterwards. Point it at a local mongod to keep the
#                       restore off production entirely; that is the better shape
#                       and costs nothing but a container.
#   VERIFY_TOLERANCE    how far below production a core collection may be
#                       before it counts as data loss rather than a backup that
#                       is a few hours old. Default 0.10.
#   ALERT_WEBHOOK_URL   posted to on failure, if set.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

env_value() {
  sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | sed 's/^"//; s/"$//'
}

URI="${MONGODB_URI:-$(env_value MONGODB_URI)}"
DB="${MONGODB_DB:-$(env_value MONGODB_DB)}"
DB="${DB:-gcloud}"
TARGET_URI="${VERIFY_TARGET_URI:-$(env_value VERIFY_TARGET_URI)}"
TARGET_URI="${TARGET_URI:-$URI}"
BACKUP_DIR="${BACKUP_DIR:-$here/backups}"
WEBHOOK="${ALERT_WEBHOOK_URL:-$(env_value ALERT_WEBHOOK_URL)}"

bold()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()   { printf '  \033[31m✕\033[0m %s\n' "$1"; }
info()  { printf '  \033[2m%s\033[0m\n' "$1"; }

fail() {
  bad "$1"
  printf '\n\033[31mVERIFICATION FAILED\033[0m — %s\n\n' "$1"
  if [[ -n "$WEBHOOK" ]]; then
    curl -fsS -X POST "$WEBHOOK" \
      -H 'content-type: application/json' \
      -d "$(printf '{"text":"[GCloud] Backup restore verification FAILED: %s","kind":"backup-verify","status":"failed"}' "$1")" \
      >/dev/null 2>&1 || true
  fi
  exit 1
}

# ── Preconditions ────────────────────────────────────────────────────────────

bold 'Preconditions'

[[ -n "$URI" ]] || fail 'No MONGODB_URI — set it in the environment or in app/.env'
command -v mongorestore >/dev/null 2>&1 \
  || fail 'mongorestore is not on PATH. Install the MongoDB Database Tools.'
command -v mongosh >/dev/null 2>&1 \
  || fail 'mongosh is not on PATH. Install the MongoDB Shell.'
ok 'mongorestore and mongosh are available'

ARCHIVE=''
NO_DRIVE=''
for arg in "$@"; do
  case "$arg" in
    # Skips the catalogue-to-Drive spot check. For environments with no Google
    # credential — CI, mainly. The scheduled run on real data must not use it:
    # that check is the one that proves the two halves of the library still
    # line up, which is most of the value here.
    --no-drive) NO_DRIVE='--no-drive' ;;
    -*) fail "unknown option $arg" ;;
    *) ARCHIVE="$arg" ;;
  esac
done

if [[ -z "$ARCHIVE" ]]; then
  if [[ ! -d "$BACKUP_DIR" ]]; then
    fail "No backup directory at $BACKUP_DIR — the backup has never run. There is nothing protecting the catalogue."
  fi
  ARCHIVE="$(find "$BACKUP_DIR" -name 'gcloud-*.archive.gz' -type f -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null | head -n 1)"
fi

[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] \
  || fail "No backup archive found in $BACKUP_DIR — run 'npm run backup' first."

age_days=$(( ( $(date +%s) - $(stat -c %Y "$ARCHIVE" 2>/dev/null || stat -f %m "$ARCHIVE") ) / 86400 ))
size="$(du -h "$ARCHIVE" | cut -f1)"
ok "using $(basename "$ARCHIVE")  ($size, ${age_days}d old)"

# A backup nobody has taken in a fortnight is a backup of a library that no
# longer exists. Say so, but still verify what is there.
if (( age_days > 7 )); then
  bad "this archive is ${age_days} days old — the nightly backup is not running"
fi

# ── Restore into a scratch database ──────────────────────────────────────────

SCRATCH="gcloudverify_$(date -u +%Y%m%d%H%M%S)_$$"

cleanup() {
  # Runs on every exit path, including a failed restore half-way through. A
  # verification that leaves debris behind gets switched off within a month.
  printf '\n'
  info "dropping scratch database $SCRATCH"
  mongosh "$TARGET_URI" --quiet --eval \
    "db.getSiblingDB('$SCRATCH').dropDatabase()" >/dev/null 2>&1 \
    && info 'scratch database dropped' \
    || bad "could not drop $SCRATCH — remove it by hand"
}
trap cleanup EXIT

bold 'Restore'
info "restoring into $SCRATCH (never touches $DB)"

# Deliberately not --quiet. mongorestore writes the reason it gave up to stderr
# and --quiet suppresses exactly that, leaving a failure with no explanation.
# The progress chatter is filtered out below instead.
log="$(mktemp)"
if ! mongorestore --uri "$TARGET_URI" \
  --gzip --archive="$ARCHIVE" \
  --nsFrom="${DB}.*" --nsTo="${SCRATCH}.*" \
  --drop >"$log" 2>&1
then
  detail="$(grep -oE 'Failed:.*' "$log" | tail -n 1)"
  rm -f "$log"
  # A torn archive often restores several collections before it hits the tear,
  # which is why the exit code matters more than the row counts: a partial
  # restore looks perfectly healthy until you go looking for what is missing.
  fail "mongorestore could not read the archive — ${detail:-no detail given}"
fi

restored_docs="$(grep -oE '[0-9]+ document\(s\) restored successfully' "$log" | tail -n 1)"
rm -f "$log"
ok "archive restored${restored_docs:+  ($restored_docs)}"

# ── Prove it is a catalogue, not just bytes ──────────────────────────────────

if ! MONGODB_URI="$URI" MONGODB_DB="$DB" VERIFY_TARGET_URI="$TARGET_URI" \
  node infra/verify-restore.mjs --db "$SCRATCH" $NO_DRIVE
then
  fail 'the restored catalogue did not pass its checks (see above)'
fi

# A stamp the security audit reads, so "when was this last actually tested?" has
# an answer that does not depend on how the script happened to be invoked.
mkdir -p "$BACKUP_DIR" 2>/dev/null || true
printf '%s verified %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$ARCHIVE")" \
  >> "$BACKUP_DIR/.last-verified" 2>/dev/null || true

printf '\n\033[32mBACKUP VERIFIED\033[0m — this archive would rebuild the library.\n'

if [[ -n "$WEBHOOK" ]]; then
  curl -fsS -X POST "$WEBHOOK" \
    -H 'content-type: application/json' \
    -d "$(printf '{"text":"[GCloud] Backup restore verification passed (%s)","kind":"backup-verify","status":"ok"}' "$(basename "$ARCHIVE")")" \
    >/dev/null 2>&1 || true
fi
