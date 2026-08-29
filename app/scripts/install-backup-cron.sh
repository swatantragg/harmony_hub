#!/usr/bin/env bash
#
# Installs the two cron entries that make the backup real:
#
#   nightly    take a dump
#   quarterly  restore the newest one and prove it rebuilds the library
#
# The second is the one people skip, and it is the one that decides whether the
# first was worth doing. A dump nobody has ever restored is a hypothesis.
#
#   ./scripts/install-backup-cron.sh            show what would be installed
#   ./scripts/install-backup-cron.sh --apply    install it
#   ./scripts/install-backup-cron.sh --remove   take it out again
#
# Both entries are tagged with a marker comment, so re-running replaces them
# rather than stacking up duplicates.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

MARKER='# gcloud-backup'
APPLY=false
REMOVE=false
for arg in "$@"; do
  [[ "$arg" == '--apply' ]] && APPLY=true
  [[ "$arg" == '--remove' ]] && REMOVE=true
done

NODE_BIN="$(command -v node || echo /usr/bin/node)"
PATH_LINE="PATH=$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin"

# Cron runs with almost no environment. Everything the scripts need is read from
# app/.env by the scripts themselves, so only PATH has to be handed over.
read -r -d '' ENTRIES <<EOF || true
$PATH_LINE
$MARKER nightly dump — keeps 14 days locally, copies off-site if BACKUP_REMOTE is set
30 2 * * * cd $here && bash scripts/backup-mongo.sh >> $here/backups/backup.log 2>&1
$MARKER quarterly restore test — fails loudly if the backup would not rebuild the library
0 4 1 */3 * cd $here && bash scripts/verify-restore.sh >> $here/backups/verify.log 2>&1
EOF

current="$(crontab -l 2>/dev/null || true)"
# Drop any previous block of ours: the marker line, the line after it, and our PATH.
cleaned="$(printf '%s\n' "$current" \
  | grep -vF "$MARKER" \
  | grep -vF 'scripts/backup-mongo.sh' \
  | grep -vF 'scripts/verify-restore.sh' \
  | grep -vF "$PATH_LINE" \
  | sed '/^[[:space:]]*$/d')"

if $REMOVE; then
  printf '%s\n' "$cleaned" | crontab - \
    && echo "✓ removed the GCloud backup entries" \
    || { echo "✕ could not write the crontab" >&2; exit 1; }
  exit 0
fi

if ! $APPLY; then
  cat <<TEXT

  These two entries would be installed for $(whoami):

$(printf '%s\n' "$ENTRIES" | sed 's/^/    /')

  Nightly at 02:30, quarterly at 04:00 on the 1st of Jan/Apr/Jul/Oct.

  Before applying, two things are worth setting in app/.env:

    BACKUP_REMOTE=user@host:/backups     a copy on the same disk as the database
                                         dies with the disk. This is the whole
                                         point of taking one.

    VERIFY_TARGET_URI=mongodb://…        where the restore test writes. Defaults
                                         to MONGODB_URI, i.e. a scratch database
                                         on the production cluster that is
                                         dropped afterwards. Pointing it at a
                                         local mongod keeps the test off
                                         production entirely.

    ALERT_WEBHOOK_URL=https://…          so a failed verification tells you
                                         instead of sitting in a log.

  Run again with --apply to install.

TEXT
  exit 0
fi

mkdir -p "$here/backups"
chmod 700 "$here/backups"

printf '%s\n%s\n' "$cleaned" "$ENTRIES" | crontab - \
  && echo "✓ installed — nightly dump 02:30, quarterly restore test 04:00 on the 1st" \
  || { echo "✕ could not write the crontab" >&2; exit 1; }

echo "  logs: $here/backups/backup.log and verify.log"
echo "  check with: crontab -l"
