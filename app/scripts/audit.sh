#!/usr/bin/env bash

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

fail=0
warn=0

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }
bad()     { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
meh()     { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn + 1)); }
ok()      { printf '  \033[32m✓\033[0m %s\n' "$1"; }

section 'Dependencies'
if npm audit --omit=dev --audit-level=high >/dev/null 2>&1; then
  ok 'no high or critical advisories in the runtime tree'
else
  bad 'npm audit reports high/critical advisories — run: npm audit --omit=dev'
fi

section 'Secrets'
if git -C "$here/.." rev-parse >/dev/null 2>&1; then
  tracked="$(git -C "$here/.." ls-files | grep -Ei '(^|/)\.env($|\.)|\.pem$|\.key$|serviceaccount.*\.json$|_rsa$' | grep -v '\.env\.example$' || true)"
  if [[ -n "$tracked" ]]; then
    bad "credential files are tracked by git:"
    printf '      %s\n' $tracked
  else
    ok 'no credential files tracked'
  fi

  leaked="$(git -C "$here/.." grep -nIE '(AIza[0-9A-Za-z_-]{35}|GOCSPX-[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[^A-Za-z0-9]{0,4}[A-Za-z0-9+/=]{40,}|mongodb(\+srv)?://[^:[:space:]]+:[^@[:space:]]{6,}@|1//[0-9A-Za-z_-]{30,})' -- . ':(exclude)*.example' ':(exclude)*SECURITY.md' ':(exclude)*audit.sh' 2>/dev/null || true)"
  if [[ -n "$leaked" ]]; then
    bad 'credential-shaped strings in tracked files:'
    printf '      %s\n' "$leaked" | head -10
  else
    ok 'no credential-shaped strings in tracked files'
  fi
else
  meh 'not a git repository — skipped the tracked-secret checks'
fi

if [[ -f .env ]]; then
  perms="$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null)"
  if [[ "$perms" == "600" ]]; then ok '.env is 600'; else bad ".env is mode $perms — run: chmod 600 .env"; fi
fi

section 'Configuration'
value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1; }

if [[ -f .env ]]; then
  jwt="$(value JWT_SECRET)"
  case "$jwt" in
    ''|*change-me*|*changeme*|*CHANGE_ME*) bad 'JWT_SECRET is unset or a placeholder — every session is forgeable' ;;
    *) [[ ${#jwt} -ge 32 ]] && ok 'JWT_SECRET looks real' || bad "JWT_SECRET is only ${#jwt} characters" ;;
  esac

  [[ -n "$(value FILE_TOKEN_SECRET)" ]] \
    && ok 'FILE_TOKEN_SECRET is set separately from JWT_SECRET' \
    || meh 'FILE_TOKEN_SECRET is blank — file tickets are signed with JWT_SECRET, so rotating either revokes both'

  case "$(value ADMIN_PASSWORD)" in
    12345678|password|admin123|changeme123|'') bad 'ADMIN_PASSWORD is a well-known default' ;;
    *) ok 'ADMIN_PASSWORD is not a known default' ;;
  esac

  [[ "$(value TRUST_PROXY)" == "true" ]] \
    && bad 'TRUST_PROXY=true — any client can forge req.ip, defeating the rate limiter and the audit trail' \
    || ok "TRUST_PROXY=$(value TRUST_PROXY)"

  [[ "$(value ALLOW_DESTRUCTIVE_DEMO)" == "true" ]] \
    && bad 'ALLOW_DESTRUCTIVE_DEMO=true — the library-wipe route is reachable' \
    || ok 'ALLOW_DESTRUCTIVE_DEMO is off'

  [[ "$(value ALLOW_EMPTY_DRIVE_TRASH)" == "true" ]] \
    && meh 'ALLOW_EMPTY_DRIVE_TRASH=true — reaches the whole connected account, not only this library' \
    || ok 'ALLOW_EMPTY_DRIVE_TRASH is off'

  if [[ "$(value NODE_ENV)" == "production" ]]; then
    case "$(value PUBLIC_ORIGIN)" in
      https://*) ok 'PUBLIC_ORIGIN is https' ;;
      *) bad 'NODE_ENV=production with a non-https PUBLIC_ORIGIN — sessions travel in the clear' ;;
    esac
  fi
fi

section 'Backups'
backup_dir="${BACKUP_DIR:-$here/backups}"
newest="$(find "$backup_dir" -name 'gcloud-*.archive.gz' -type f -print0 2>/dev/null \
  | xargs -0 ls -t 2>/dev/null | head -n 1)"

if [[ -z "$newest" ]]; then
  bad 'no MongoDB backup has ever been taken — Drive protects the bytes, nothing protects the catalogue (npm run backup)'
else
  age=$(( ( $(date +%s) - $(stat -c %Y "$newest" 2>/dev/null || stat -f %m "$newest") ) / 86400 ))
  if (( age > 7 )); then
    bad "the newest backup is ${age} days old — the nightly dump is not running (npm run backup:schedule)"
  else
    ok "backup taken ${age} day(s) ago"
  fi
  # A dump nobody has restored is a hypothesis: mongodump exits 0 on partial
  # archives, and the failure only shows up when it is needed.
  if [[ -f "$backup_dir/.last-verified" ]]; then
    vage=$(( ( $(date +%s) - $(stat -c %Y "$backup_dir/.last-verified" 2>/dev/null || stat -f %m "$backup_dir/.last-verified") ) / 86400 ))
    (( vage > 100 )) \
      && meh "the last restore test was ${vage} days ago — run npm run backup:verify" \
      || ok "restore tested ${vage} day(s) ago"
  else
    meh 'no restore has ever been tested — an untested backup is a hypothesis (npm run backup:verify)'
  fi
fi

crontab -l 2>/dev/null | grep -q 'scripts/backup-mongo.sh' \
  && ok 'the nightly backup is scheduled' \
  || meh 'the backup is not on cron (npm run backup:schedule)'

section 'Regressions'
grep -q 'contentSecurityPolicy: false' server/src/index.js 2>/dev/null \
  && bad 'the content security policy has been disabled again in index.js' \
  || ok 'content security policy is enabled'

grep -qE "^\s*app\.set\('trust proxy', true\)" server/src/index.js 2>/dev/null \
  && bad "trust proxy is hard-coded to true in index.js" \
  || ok 'trust proxy comes from configuration'

grep -rq "localStorage.setItem(TOKEN_KEY" client/src 2>/dev/null \
  && bad 'the access token is being written to localStorage again' \
  || ok 'the access token is not persisted to localStorage'

printf '\n'
if [[ $fail -gt 0 ]]; then
  printf '\033[31m%d blocker(s)\033[0m, %d warning(s)\n\n' "$fail" "$warn"
  exit 1
fi
printf '\033[32mclean\033[0m — %d warning(s)\n\n' "$warn"
