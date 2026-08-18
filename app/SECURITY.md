# Security

What protects this library, where the sharp edges are, and what to do when something goes
wrong. Written to be read by whoever is on duty, not by an auditor.

---

## The threat model in one paragraph

The library holds unreleased masters, artwork and contracts for a music company, in one
person's Google Drive, reachable by a small team and — through share links — by external
partners who have no account. The things that actually go wrong, in order of likelihood:
a share link ends up somewhere it should not; an account is phished or a laptop is lost;
somebody deletes the wrong thing; a credential leaks out of a config file. Everything below
is aimed at those four, in that order.

---

## What is in place

### Identity and sessions

| | |
|---|---|
| Passwords | bcrypt, cost 12. Minimum 12 characters, checked against the known handover values and the account's own name; optionally against the public breach corpus (`PASSWORD_BREACH_CHECK`, k-anonymity — the password never leaves the process) |
| Sign-in | Timing-equalised against unknown accounts, generic failure message, every failure recorded |
| Brute force | 10 attempts per address **and** per account per 15 minutes, then an 8-failure account lockout for 15 minutes. Both counters are on by default |
| Access token | 15 minutes, HS256, `iss`/`aud`/`jti` pinned, held **in memory in the browser** — never in `localStorage` |
| Refresh token | 14 days, HttpOnly + Secure + SameSite=Strict cookie scoped to `/api/auth`, rotated on every use, with **reuse detection**: presenting a spent token destroys the whole family and tells the account owner |
| Session caps | 30-day absolute, 12-hour idle, both enforced server-side |
| Revocation | `tokenVersion` on the account. A password change, a suspension, a role change or "sign out everywhere" invalidates every access token already issued, immediately |
| Step-up | Purging a file, emptying the Drive bin and resetting somebody's password re-ask for the operator's own password (5-minute ticket) |

### Authorisation

Two roles. The line is drawn at what cannot be undone, not at who is trusted.

| | User | Admin |
|---|:-:|:-:|
| Read, search, download, preview | ● | ● |
| Upload, edit, rename, move, share | ● | ● |
| Soft delete (recoverable 30 days) | ● | ● |
| Storage health, drift remediation | ● | ● |
| **Permanent purge** | | ● |
| **Empty the Drive bin** | | ● |
| Accounts, audit trail | | ● |

Permissions are resolved from the role on the server on every request. They are never
carried in a token, and the client's copy exists only so a button is not shown that the
server would refuse.

### The byte path (`/api/files/:token`)

This is the only route that streams file contents, and it answers on the same origin as
the application, so it gets the most attention.

- **Tickets**, not links: HMAC-SHA256, expiring (5 min download / 60 min preview), bound to
  one file, one purpose, and — where applicable — one account and one share.
- **Re-checked at redemption**, not only at mint: the account must still be active at the
  same session generation, the share must still be live, the asset must still exist and not
  have been deleted or replaced. This is what makes revocation real.
- **Nothing executes.** Every response carries
  `Content-Security-Policy: sandbox; default-src 'none'` — an opaque origin with no script —
  plus `nosniff`, `X-Frame-Options: DENY` and `no-store`. Only an allowlist of media types is
  served inline; everything else downloads, and executable types are rewritten to
  `application/octet-stream` on the way out.
- **Metered.** 600 requests per minute per address, because it is unauthenticated by design.

> **Why SVG is allowed inline.** SVG can carry `<script>`, and the library is full of SVG
> covers and banners. Refusing it would turn every one of them into a download. The sandbox
> header is what makes it safe: a sandboxed document cannot reach this application's
> storage or session, and an `<img>` never runs script in an SVG regardless. `INLINE_MIME`
> in `config.js` and the sandbox header in `routes/files.js` are one decision — do not
> change either without the other.

### Content policy

Refused at upload, by extension and by declared type: HTML, XHTML, XSLT, JavaScript, WASM,
JARs, and executables/scripts for every common platform. Double extensions
(`report.pdf.html`) are caught.

Then checked again against the **real bytes** — one 512-byte ranged read once Google has
the file — because everything at upload time was the uploader's word for it. A file whose
contents begin like HTML, an executable or a shell script is moved to the **Quarantine**
folder in Drive and never catalogued. Nothing is deleted: a false positive has to be
recoverable.

**Malware scanning**, when a ClamAV daemon is configured: every completed upload is read
back out of Drive and streamed past it before the catalogue record is written. Anything it
identifies goes to Quarantine with the signature name in the audit trail.

```ini
CLAMAV_ENABLED=true
CLAMAV_HOST=clamav          # docker compose --profile av up -d clamav
CLAMAV_FAIL_CLOSED=true     # an unreachable scanner refuses uploads rather than waving them through
```

`CLAMAV_FAIL_CLOSED` is the setting to think about. Closed means clamd going down stops
uploads; open means an outage silently turns scanning off and nobody notices. Closed is the
default — if you switched scanning on, you meant it. Check `GET /api/admin/health` for
whether the daemon is actually answering.

Ceilings: 25 GB per file, 50 GB per account per rolling day, 200 MB per scan (clamd's own
`StreamMaxLength` is 25 MB out of the box — raise both together, or larger files are
skipped rather than failed).

### Sharing

Hard expiry, download caps, instant revocation, three audiences (open / editor / named
recipients), an optional **passcode** (bcrypt-hashed, constant-time compared), and a
notification to the creator the first time a link is opened, with the address it came from.
The Drive file's own sharing settings are never touched, so revoking here genuinely revokes.

**A specific-allocation link issues one URL per recipient.** Each is revocable on its own,
so a single forwarded email costs that one person their access and nobody else theirs. The
share's own token is not usable on such a link — otherwise it would be a master key that no
per-recipient revocation touches. Opening a link issued to somebody else is refused even
when the token is valid, and recorded.

### Transport and headers

Full CSP (no `unsafe-inline` for scripts), HSTS with preload, `frame-ancestors 'none'`,
`Permissions-Policy` denying camera/microphone/geolocation, CORP `same-origin`, COOP
`same-origin`, `Referrer-Policy: no-referrer`, no `x-powered-by`.

### Audit

Every mutation: actor, role, before/after, user agent, and **two** addresses — `req.ip`
(derived from `X-Forwarded-For` per `TRUST_PROXY`) and the socket address, which the client
cannot forge. When they disagree, the row says so. Failed sign-ins, lockouts, rejected file
tickets, wrong share passcodes and refresh-token reuse are all recorded. Purges, trash
emptying, account changes and token reuse also raise a notification rather than waiting to
be found in a log.

Retention: `AUDIT_RETENTION_DAYS` (default 400), swept nightly at 03:00.

---

## Operational rules

### `TRUST_PROXY` — get this right

`req.ip` is what the rate limiter counts and what the audit trail records. `TRUST_PROXY=true`
means "believe whatever `X-Forwarded-For` says, from anybody", which hands every client
control of both. The boot warns if it is set.

- Direct to the internet, or behind nothing: `loopback` (the default)
- Behind exactly one reverse proxy: `1`
- Behind a known load balancer: its CIDR

### Destructive operations are off by default

| Flag | What it unlocks | Default |
|---|---|:-:|
| `ALLOW_DESTRUCTIVE_DEMO` | `POST /api/demo/reset` — permanently deletes every file under the GCloud folder and empties the catalogue | `false` |
| `ALLOW_EMPTY_DRIVE_TRASH` | Empties the **whole connected account's** Drive bin, including files this library never touched | `false` |

`ALLOW_DESTRUCTIVE_DEMO` cannot be enabled in production; the process refuses to start.
Even enabled, the reset route needs an authenticated Admin and the words `RESET THE LIBRARY`
typed out.

### Secrets

The process refuses to start on a placeholder `JWT_SECRET`, and in production on a secret
shorter than 32 characters or a well-known default admin/seed password.

```bash
openssl rand -base64 48       # JWT_SECRET, FILE_TOKEN_SECRET (generate separately)
chmod 600 app/.env
```

`FILE_TOKEN_SECRET` should be set separately from `JWT_SECRET` — rotating one then does not
sign every user out.

**Rotating `FILE_TOKEN_SECRET` invalidates every outstanding download, preview and share
URL immediately.** That is the emergency stop if a link leaks.

### Backups

Drive protects the bytes (30-day trash, per-file revisions). MongoDB holds everything that
makes them a library, and nothing protected it until now:

```bash
./scripts/backup-mongo.sh                       # → ./backups, 14-day window
BACKUP_REMOTE=user@host:/backups ./scripts/backup-mongo.sh
```

Run it from cron, off-site, and **restore it into a scratch database once a quarter**. An
untested backup is a hypothesis.

---

## If something goes wrong

**A share link leaked.** Revoke it (Shares → Revoke) — outstanding file tickets minted under
it stop working immediately, because they are re-checked against the share on every request.
If several leaked, rotate `FILE_TOKEN_SECRET` and restart: every URL in circulation dies.

**An account is compromised.** Admin → People → suspend. Every access token, every refresh
session and every file ticket bound to that account stops working on the next request. Then
reset the password (Admin → Reset password), which puts the account back into the handover
state. Read its rows in the activity log — filter by person — paying attention to
`ASSET_PURGE`, `SHARE_CREATE` and `ASSET_DOWNLOAD`.


**"A sign-in token was used twice."** The refresh token was replayed by someone other than
the browser it was issued to. Every session on that account has already been ended
automatically. Treat it as a confirmed theft: reset the password, check the activity log.

**A file was purged by mistake.** It is gone — `files.delete` skips the bin and takes every
revision. The catalogue row is recoverable from a MongoDB backup; the bytes are not.

**The library looks wrong / files moved.** Admin → Storage health → Run reconciliation. Most
drift is somebody rearranging things in Drive by hand, and each finding offers the specific
remedy.

---

## Known limits — deliberate, and worth knowing

1. **The Google credential is account-wide.** The OAuth scope is full Drive, because
   adopting files somebody dropped into the folder is a feature. Compromise of
   `GOOGLE_REFRESH_TOKEN` therefore reaches the whole connected Drive, not only this
   library. Mitigation: use a dedicated account with nothing else in it, or a Shared Drive
   on Workspace. Do not connect a personal account that holds anything else.
2. **No second factor.** A password is the only thing between an account and the library.
   This is the largest remaining gap, and the one to close next: an authenticator-app
   second factor (TOTP) is planned but not built. Until it exists, password quality, the
   lockout and the audit trail are what stand in for it.
3. **No per-object ACL.** Any account that can read, can read everything. The roles limit
   what can be *done*, not what can be *seen*.
4. **Malware scanning is opt-in and needs a daemon.** With `CLAMAV_ENABLED=false` — the
   default — content is checked for type but not for malware.
5. **Single process.** The catalogue is an in-memory working set written through to MongoDB.
   Rate-limit counters and upload-session registrations are per process, so running more
   than one task needs a shared store for both.

---

## Reporting

Security problems go to the repository owner directly, not into a public issue.
