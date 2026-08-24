#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

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

chmod 600 "$archive"

size="$(du -h "$archive" | cut -f1)"
echo "✓ $size"

find "$BACKUP_DIR" -name 'gcloud-*.archive.gz' -type f -mtime "+$RETAIN_DAYS" -print -delete \
  | sed 's/^/  swept /'

count="$(find "$BACKUP_DIR" -name 'gcloud-*.archive.gz' -type f | wc -l | tr -d ' ')"
echo "  $count backup(s) held, $RETAIN_DAYS-day window"

if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  echo "→ copying to $BACKUP_REMOTE"
  rsync -a --chmod=600 "$archive" "$BACKUP_REMOTE/"
  echo "✓ off-site copy done"
else
  echo "  (set BACKUP_REMOTE=user@host:/path to copy off this machine)"
fi
