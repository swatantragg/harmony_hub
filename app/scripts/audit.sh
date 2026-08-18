#!/usr/bin/env bash
#
# The check that belongs in CI, and the one to run before a deploy.
#
# Three things, in the order that catches the most for the least time:
#
#   1. Known vulnerabilities in the dependency tree that actually ships.
#   2. Secrets that have been committed. `.gitignore` covers the known names, which is
#      exactly why the failure mode is a *new* file nobody thought to add to it.
#   3. The configuration mistakes that turn a hardened build back into an open one.
#
# Exits non-zero on anything it considers a release blocker.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

fail=0
warn=0

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }
bad()     { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
meh()     { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn + 1)); }
ok()      { printf '  \033[32m✓\033[0m %s\n' "$1"; }

# ── 1. Dependencies ─────────────────────────────────────────────────────────
section 'Dependencies'
# Production only. A vulnerability in a build-time tool is worth knowing about and is not
# the same class of thing as one in code that serves requests.
if npm audit --omit=dev --audit-level=high >/dev/null 2>&1; then
  ok 'no high or critical advisories in the runtime tree'
else
  bad 'npm audit reports high/critical advisories — run: npm audit --omit=dev'
fi

# ── 2. Secrets ──────────────────────────────────────────────────────────────
section 'Secrets'
if git -C "$here/.." rev-parse >/dev/null 2>&1; then
  tracked="$(git -C "$here/.." ls-files | grep -Ei '(^|/)\.env($|\.)|\.pem$|\.key$|serviceaccount.*\.json$|_rsa$' | grep -v '\.env\.example$' || true)"
  if [[ -n "$tracked" ]]; then
    bad "credential files are tracked by git:"
    printf '      %s\n' $tracked
  else
    ok 'no credential files tracked'
  fi

  # The high-signal shapes. Deliberately few patterns: a scanner that cries wolf is turned
  # off within a week.
  # Each pattern requires enough real key material to rule out the documentation form —
  # `MIIE...` in a README is an illustration, not a leak, and a scanner that flags it is a
  # scanner people learn to ignore.
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

# ── 3. Configuration ────────────────────────────────────────────────────────
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

# ── 4. The things that must not come back ───────────────────────────────────
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
