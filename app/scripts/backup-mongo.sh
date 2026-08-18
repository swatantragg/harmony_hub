#!/usr/bin/env bash
#
# Catalogue backup.
#
# Google Drive holds the bytes and has its own history: a trashed file is recoverable for
# thirty days and a replaced one keeps its revisions. MongoDB holds everything else — which
# song a file belongs to, what it is called, who may see it, every share link, every audit
# row — and had no backup at all. Losing it does not lose a single byte of audio and still
# loses the product: 116 assets become 116 anonymous files in a Drive folder.
#
# So this dumps the catalogue, compresses it, keeps a rolling window, and is meant to be
# run from cron. It is deliberately a shell script rather than a feature: a backup that
# depends on the application being healthy is not a backup.
#
#   ./scripts/backup-mongo.sh                    → ./backups
#   BACKUP_DIR=/mnt/vol ./scripts/backup-mongo.sh
#   RETAIN_DAYS=30 ./scripts/backup-mongo.sh
#
# Restore, when it comes to it:
#
#   mongorestore --uri "$MONGODB_URI" --nsInclude 'GCloud.*' --drop --gzip --archive=<file>
#
# Test that command against a scratch database occasionally. An untested backup is a
# hypothesis.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

# Read MONGODB_URI/MONGODB_DB out of .env without sourcing it — .env holds credentials and
# arbitrary shell in a value would run.
env_value() {
  sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | sed 's/^"//; s/"$//'
}

URI="${MONGODB_URI:-$(env_value MONGODB_URI)}"
DB="${MONGODB_DB:-$(env_value MONGODB_DB)}"
BACKUP_DIR="${BACKUP_DIR:-$here/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

if [[ -z "$URI" ]]; then
  echo "No MONGODB_URI — set it in the environment or in app/.env" >&2
  exit 1
fi

if ! command -v mongodump >/dev/null 2>&1; then
  echo "mongodump is not on PATH. Install the MongoDB Database Tools:" >&2
  echo "  https://www.mongodb.com/docs/database-tools/installation/" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_DIR/gcloud-$stamp.archive.gz"

echo "→ dumping ${DB:-(default db)} to $archive"
mongodump --uri "$URI" ${DB:+--db "$DB"} --gzip --archive="$archive" --quiet

# A dump is a complete copy of every account record and every audit row. It is readable by
# its owner and nobody else.
chmod 600 "$archive"

size="$(du -h "$archive" | cut -f1)"
echo "✓ $size"

# Rolling window. Deleting the oldest is the point — an unbounded backup directory fills
# the disk and takes the application down with it.
find "$BACKUP_DIR" -name 'gcloud-*.archive.gz' -type f -mtime "+$RETAIN_DAYS" -print -delete \
  | sed 's/^/  swept /'

count="$(find "$BACKUP_DIR" -name 'gcloud-*.archive.gz' -type f | wc -l | tr -d ' ')"
echo "  $count backup(s) held, $RETAIN_DAYS-day window"

# An off-site copy is what makes this a backup rather than a second copy on the same disk.
if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  echo "→ copying to $BACKUP_REMOTE"
  rsync -a --chmod=600 "$archive" "$BACKUP_REMOTE/"
  echo "✓ off-site copy done"
else
  echo "  (set BACKUP_REMOTE=user@host:/path to copy off this machine)"
fi
