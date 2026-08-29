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
| Passwords | bcrypt, cost 12. Minimum `MIN_PASSWORD_LENGTH` — 8 is allowed in development, **production refuses to start below 12** — checked against the known handover values, the account's own name, the last `PASSWORD_HISTORY_DEPTH` (3) hashes used on the account, and the public breach corpus (`PASSWORD_BREACH_CHECK`, k-anonymity — the password never leaves the process) |
| **Daily passcode** | One emailed six-digit code per calendar day, in `OTP_TIMEZONE`. HMAC-stored, 10-minute life, 5 attempts, one live challenge per person per purpose. See "The day boundary" below |
| Sign-in | Timing-equalised against unknown accounts, generic failure message, every failure recorded. A correct password alone produces **no session** — only a passcode ticket |
| Brute force | 10 attempts per address **and** per account per 15 minutes, then an 8-failure account lockout for 15 minutes. Counters are shared across tasks (`RATE_LIMIT_STORE=mongo`) |
| Access token | 15 minutes, HS256, `iss`/`aud`/`jti` pinned, carries the day it was verified for, held **in memory in the browser** — never in `localStorage` |
| Refresh token | 14 days, HttpOnly + Secure + SameSite=Strict cookie scoped to `/api/auth`, rotated on every use, with **reuse detection**: presenting a spent token destroys the whole family and tells the account owner |
| Session caps | 30-day absolute, 12-hour idle, **and the day boundary**, all enforced server-side |
| Revocation | `tokenVersion` on the account invalidates every access token at once. Individual sessions can be ended one at a time — `DELETE /api/me/sessions/:familyId`, or the button beside each device in Your profile |
| Unknown devices | The first time an address-and-browser pair is seen on an account, the holder gets a notification and an email. It warns; it does not block |
| Step-up | Purging a file, emptying the Drive bin and resetting somebody's password re-ask for the operator's own password (5-minute ticket) |
| CSRF | SameSite=Strict is the primary defence. A double-submit token (`gcloud.csrf` cookie + `x-csrf-token` header, constant-time compared) is required on the four routes authorised by the refresh cookie |

### The day boundary

The rule: sign in once in the morning, stay signed in until midnight, prove yourself
again the next day. Two mechanisms carry it, and both are server-side.

- Every session family is stamped with the day it was passcode-verified for, and every
  access token minted from it carries the same stamp. `authenticate` compares that stamp
  with today on **every request**, so a 15-minute token issued at 23:58 stops answering
  at 00:00 — not at 00:13.
- A refresh cookie that is valid in every way *except* its day stamp is not thrown away.
  It is worth exactly one thing: the right to be asked for a passcode instead of a
  password. That is what makes the next morning one field rather than two.

Delivery is Brevo's HTTP API (`BREVO_API_KEY`, `BREVO_SENDER_EMAIL`). **With `OTP_ENABLED=true`
and no key, production refuses to start** — a passcode that cannot be delivered is a
locked door with no handle. In development the code is printed to the console instead.

Google sign-in satisfies the day on its own: it is a live interactive authentication with
Google, and an emailed code on top of it adds friction without adding a factor. Those
sessions carry the same stamp and expire at the same midnight.

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
recipients), an optional **passcode** (bcrypt-hashed, constant-time compared, minimum
`SHARE_PASSCODE_MIN_LENGTH` = 8), and a notification to the creator the first time a link
is opened, with the address it came from.
The Drive file's own sharing settings are never touched, so revoking here genuinely revokes.

**Guessing a passcode is metered twice.** Ten attempts per address per 15 minutes stops one
machine; a second counter on the link itself — counting failures wherever they come from —
is what a distributed guess runs into. At `SHARE_PASSCODE_FREEZE_AT` (20) the link **freezes
itself**: it stops answering for everybody, the creator is told, and administrators are
alerted. A correct passcode resets the count, so somebody who mistyped twice this morning
does not find the link dead a fortnight later.

**Every download raises a notification addressed to the person who created the link**, and
to administrators — and to nobody else. Whoever shared a folder needs to know it was taken;
the rest of the library has no business knowing which external partner opened whose link.

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
tickets, wrong share passcodes, passcode failures and refresh-token reuse are all recorded.
Purges, trash emptying, account changes and token reuse also raise a notification rather
than waiting to be found in a log.

`LOG_FORMAT=json` additionally emits one line of JSON per mutation on stdout, for a log
collector. That copy has left the machine by the time anybody with database access could
think about editing the Mongo one. `ALERT_WEBHOOK_URL` POSTs every alertable event to
Slack, PagerDuty or anything else that takes a webhook.

Retention: `AUDIT_RETENTION_DAYS` (default 400), swept nightly at 03:00 alongside spent
sessions, expired passcodes and stale rate-limit buckets.

### Notifications

A notification has two dimensions, and conflating them was a real leak: every row without a
`userId` used to go to everybody, so an ordinary account read *"Deleted the account for X
(their email)"* along with every lockout, purge and quarantine alert.

| `audience` | Who can see it |
|---|---|
| `all` | Everybody signed in — library activity, such as an upload |
| `admin` | Only accounts with `admin:activity` |
| `private` | Only the named `userId` |

A row can be both: a share-download notice is addressed to the link's creator **and**
visible to administrators. `category` (`activity` / `shares` / `security` / `storage`) is
presentation only — it drives the tabs in the notification panel. `visibleTo()` in
`services/audit.js` is the single place that decides who may read a row; every route goes
through it.

The Security tab exists for everybody, because a member has security notices of their own —
a new device, a password reset, a link of theirs being hammered. What is *in* it is filtered
per person, which is a different thing from hiding the tab.

### Spreadsheet exports

Both the master log and the audit trail export as `.csv` and `.xlsx`. Every cell is passed
through `util/spreadsheet.js` first: a value beginning `=`, `+`, `-`, `@`, tab or carriage
return is prefixed with an apostrophe, because Excel, LibreOffice and Sheets parse those as
**formulas** and quoting does not stop it. Asset names, folder names, tags and audit labels
are all user-controlled, so `=HYPERLINK("http://…"&A1,"Open")` in a file name would
otherwise become a live exfiltration link in somebody's downloaded report.

### Continuous checks

`.github/workflows/ci.yml` blocks a merge on: high or critical advisories in the runtime
tree, TypeScript, the security regression suite in `server/test/` (ticket forgery, expired
and cross-account tickets, `alg=none`, stale day stamps, refresh reuse, role escalation on
every admin route, notification leakage, CSRF, passcode replay, rate-limit keying, share
freeze, CSV formula injection), gitleaks, `scripts/audit.sh`, CodeQL and a Trivy scan of
the image. The dependency audit re-runs weekly, because advisories are published against
code that has not changed.

```bash
npm test          # the regression suite, serially — each file boots a real server
npm run audit:security
```

---

## Operational rules

### TLS is not optional, and it is not somebody else's job

The app listens on plain HTTP, bound to loopback. Everything it issues — the refresh
cookie, access tokens, file tickets — is a bearer credential in the clear over that. There
is now a proxy in the compose file rather than an assumption that somebody will add one:

```bash
PROXY_DOMAIN=library.example.com docker compose --profile tls up -d
```

Caddy obtains and renews the certificate itself. Then, in `.env`:

```ini
PUBLIC_ORIGIN=https://library.example.com
APP_ORIGIN=https://library.example.com
TRUST_PROXY=1
```

`TRUST_PROXY=1` — exactly one hop, never `true`. See below.

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

**Rotating `FILE_TOKEN_SECRET` outright invalidates every outstanding download, preview and
share URL immediately.** That is the emergency stop if a link leaks, and the wrong tool for
routine rotation, where it also breaks every open preview and in-flight download.

#### Routine rotation, quarterly

File tickets carry the version of the key that signed them, so a rotation can drain instead
of cutting:

```ini
FILE_TOKEN_KEY_VERSION=2                 # was 1
FILE_TOKEN_SECRET=<the new value>
FILE_TOKEN_SECRET_PREVIOUS=<the old one>
FILE_TOKEN_GRACE_SEC=86400               # how long the old key keeps verifying
```

Restart. New tickets are signed with version 2; tickets already in circulation keep working
for the grace window, then stop. Remove `FILE_TOKEN_SECRET_PREVIOUS` at the next rotation.
Leave it unset and the behaviour is the old one — immediate, total invalidation — which is
what an emergency wants.

Rotate `JWT_SECRET` the same quarter. It has no grace window by design: everybody signs in
again, which is a minor inconvenience once a quarter and the entire point of rotating a
session-signing key.

#### Where secrets live

`.env` at `chmod 600` is adequate for one machine and nothing more. It survives in backups,
in shell history, and in whatever copied the directory. **Keep no `.env.bak.*` files** —
they hold live credentials at full strength and are trivially missed when the real one is
rotated.

For anything beyond one machine, move to Docker secrets, AWS Secrets Manager or a Vault
agent, and inject at start rather than storing on disk.

### Backups

The library is two halves. Drive protects its own: 30-day trash, per-file revisions.
MongoDB holds everything that makes those bytes *a library* — which file is which, its
song, artist, type, tags, version, who uploaded it, every share, and the whole audit trail.
Lose that half and you have files in Drive that nobody can identify. Tags and titles could
be re-entered over a painful week; attribution and audit history cannot be recovered at all.

```bash
npm run backup            # → ./backups, 14-day window
npm run backup:verify     # restore the newest into a scratch DB and prove it works
npm run backup:schedule   # install both on cron (--apply to write it)
```

**Set `BACKUP_REMOTE`.** A copy on the same disk as the database dies with the disk, and
one mistyped `rm` takes both at once.

#### Why the verification exists

`mongodump` exits 0 in several situations that leave an archive you cannot restore:

- the connection drops partway — **a partial archive still exits 0**, and restores several
  collections cleanly before it hits the tear
- credentials that could read some collections and not others — missing data, exit 0
- a disk that filled while writing — truncated archive
- a tool-and-server version mismatch

None of them announce themselves. You find out at the one moment you cannot afford to. An
untested backup is a hypothesis.

`scripts/verify-restore.sh` settles it. It restores the newest archive into a throwaway
database — **never touching the live one** — then:

1. compares every collection against production. Slow-changing ones (`users`, `artists`,
   `songs`, `folders`, `unfiled`, `tags`, `customTypes`) must be within `VERIFY_TOLERANCE`
   of live; fast-churning ones need only be non-empty, or a busy day would cry wolf.
2. refuses outright if `users` is empty — a catalogue nobody can sign in to is not a
   recovery, and a password hash cannot be reconstructed.
3. takes one restored asset, reads its `drive.fileId`, and does a **live `files.get`
   against Drive**.
4. drops the scratch database, on every exit path including a failed restore.

Step 3 is the point. It proves the two halves still line up — that a restored row leads to
a file that actually exists — rather than merely proving an archive can be unzipped. Skip
it with `--no-drive` only where there is no Google credential, such as CI.

Set `VERIFY_TARGET_URI` to a local `mongod` to keep the restore off the production cluster
entirely. Left blank it uses `MONGODB_URI`, in a scratch database it drops afterwards.

Failures are loud: non-zero exit, and a POST to `ALERT_WEBHOOK_URL` if set. Successes write
`backups/.last-verified`, which `npm run audit:security` reads — so *"when was this last
actually tested?"* has an answer, and a stalled backup or an untested one shows up in the
routine audit rather than being noticed in an emergency.

CI runs the whole dump-and-restore round-trip against a seeded scratch database on every
push, so a schema change that breaks recovery is caught immediately rather than at the next
quarterly run.

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

**The catalogue is gone — wrong database dropped, cluster lost, account lapsed.** Do not
restore over the top of anything. Restore the newest archive into a *scratch* database
first and look at it:

```bash
npm run backup:verify                         # proves the archive is usable at all
mongorestore --uri "$MONGODB_URI" --gzip \
  --archive=backups/gcloud-<stamp>.archive.gz \
  --nsFrom='gcloud.*' --nsTo='gcloud_recovered.*'
```

Check the counts, point `MONGODB_DB` at `gcloud_recovered`, and start the app against it
before renaming anything. The Drive side is untouched throughout — file ids are immutable,
so a restored catalogue reconnects to the same bytes. Run Admin → Storage health →
reconciliation afterwards to catch anything uploaded between the backup and the loss: those
files are in Drive with no catalogue row, and reconciliation offers "adopt" for each.

**Somebody cannot sign in and says they never got a passcode.** Check `GET /api/admin/health`
and the boot banner for whether mail is configured, then Admin → Activity filtered to
`AUTH_OTP_SENT` — the row records whether Brevo accepted the send. A passcode that was sent
but not received is a mailbox problem; one that was never sent is a Brevo problem. As a
last resort, `OTP_ENABLED=false` and a restart takes the day boundary off entirely while
you fix it — everybody is then back to password-only, so treat it as an incident, not a
setting.

**A share link froze itself.** Twenty wrong passcodes were tried against it. That is either
somebody guessing or a recipient who was given the wrong code. Revoke it and issue a new
one; do not unfreeze it, because you cannot tell the two cases apart from here.

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
2. **The second factor is email, not an authenticator app.** The daily passcode is a real
   second factor, but its strength is the strength of the mailbox it goes to: somebody who
   controls the address controls the code. That is a large improvement on a password alone
   and weaker than TOTP, which needs no delivery channel at all. TOTP remains the thing to
   add next, alongside the passcode rather than instead of it.
3. **No per-object ACL.** Any account that can read, can read everything. The roles limit
   what can be *done*, not what can be *seen*. This is now the largest remaining gap.
4. **Malware scanning needs a daemon.** `CLAMAV_ENABLED=true` is the shipped default, but it
   does nothing until `docker compose --profile av up -d clamav` is actually running.
   Check `GET /api/admin/health` — with `CLAMAV_FAIL_CLOSED=true` an unreachable scanner
   stops uploads rather than waving them through.
5. **The catalogue is still a single-process working set.** Rate-limit counters and
   upload-session registrations now live in MongoDB and are shared correctly across tasks,
   but the in-memory catalogue written through to Mongo is not; two tasks would each hold
   their own copy. Run one task until that changes.
6. **The daily passcode depends on Brevo.** If mail delivery stops, nobody can start a new
   day. Sessions already stamped for today keep working until midnight, which is the
   warning window. `GET /api/admin/health` and the boot banner both say whether mail is
   configured.
7. **The backup is only as good as its schedule.** The scripts, the verification and the
   cron entries all exist, but `npm run backup:schedule --apply` has to be run on the
   machine that will hold the job, and `BACKUP_REMOTE` has to point somewhere off it.
   Until both are done there is a working backup *tool* and no backup. `npm run
   audit:security` reports the state of both every time it runs.

---

## Reporting

Security problems go to the repository owner directly, not into a public issue.
