# GCloud

> **Security:** [`SECURITY.md`](SECURITY.md) sets out what protects the library, the two
> configuration switches that matter most (`TRUST_PROXY` and the destructive-operation
> flags), and what to do when a link leaks or an account is compromised. Before a deploy:
> `npm run audit:security`. Back the catalogue up with `npm run backup` — Drive protects
> the bytes, nothing but this protects everything that makes them a library.

Music asset management on **Google Drive** and **MongoDB**.

Every screen, the folder model, the three share audiences, the preview panel, the
vocabulary guard and the light/dark tokens, over a Google Drive.

---

## Contents

1. [Set up Google Drive — the full walkthrough](#1-set-up-google-drive)
2. [Run it](#2-run-it)
3. [How storage behaves](#3-how-storage-behaves)
4. [De-duplication](#4-de-duplication)
5. [Installing it as an app](#5-installing-it-as-an-app)
6. [Commands](#6-commands)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Set up Google Drive

There are two ways to connect. **Use OAuth to test.** Read the comparison before choosing —
picking the wrong one is the single most common way to lose an afternoon here.

| | **OAuth** (recommended) | **Service account** |
|---|---|---|
| Whose Drive | Yours | A robot's |
| Storage quota | Your 15 GB (or your Google One plan) | **None of its own** — must use a Shared Drive |
| Setup | One consent flow, 5 minutes | Key file + Shared Drive membership |
| Files visible at drive.google.com | Yes, in your Drive | Only inside the Shared Drive |
| Needs Google Workspace | No | Effectively yes |
| Good for | Testing, a solo operator, a small label | A team on Workspace |

> **The trap with service accounts.** A service account is not a user and has no Drive
> storage allowance. Files it creates in "its own" Drive fail with `storageQuotaExceeded`,
> and even when they do not, no human can see them. It only works when it is a member of a
> **Shared Drive**, whose storage belongs to a Google Workspace plan. If you do not have
> Workspace, use OAuth.

### Option A — OAuth (start here)

**1. Create a Google Cloud project**

Go to [console.cloud.google.com](https://console.cloud.google.com). Create a project, or
pick an existing one. The project is free; it is just a container for the API credential.

**2. Enable the Drive API**

**APIs & Services → Library** → search "Google Drive API" → **Enable**.

Nothing works without this, and the error it produces if you skip it
(`accessNotConfigured`) does not say so clearly.

**3. Configure the consent screen**

**APIs & Services → OAuth consent screen**

- User type: **External** (unless you have Workspace, in which case Internal is simpler)
- App name, your email for support and developer contact — that is all that is required
- **Scopes:** you can leave this empty; the scope is requested at runtime
- **Test users:** add the Google account whose Drive you want to use

> **Read this before you skip it.** While the consent screen is in **Testing** status,
> Google expires refresh tokens after **7 days**. Your app will work perfectly and then
> stop a week later with `invalid_grant`. That is fine while you are trying things out.
> Before anyone relies on it, click **Publish app** on this screen. The token then lasts
> until it is revoked or goes six months unused. For an app only your own accounts sign in
> to, publishing needs no Google review or verification — it is one click.

**4. Create the OAuth client**

**APIs & Services → Credentials → Create credentials → OAuth client ID**

- Application type: **Web application**
- Name: anything, e.g. `GCloud`
- **Authorised redirect URIs** → Add URI:
  ```
  http://localhost:8107/oauth2callback
  ```
  This must match exactly — same scheme, same port, same path. `localhost` is deliberate;
  Google allows plain HTTP only for loopback addresses.

Copy the **Client ID** and **Client secret**.

**5. Mint a refresh token**

```bash
cd harmony_hub/app
npm install
npm run drive:auth
```

It asks for the client ID and secret, opens your browser, catches the redirect, does the
code exchange, and prints the four lines to paste into `app/.env`. Nothing has to be copied
out of a browser address bar.

> On the consent screen Google will warn "Google hasn't verified this app". That is
> expected for an unpublished app you wrote. Click **Advanced → Go to GCloud (unsafe)**.
> It is your own client id, requesting access to your own Drive.

**6. Fill in `.env`**

```bash
cp .env.example .env
```

Then set:

```ini
JWT_SECRET=<node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))">
MONGODB_URI=mongodb://127.0.0.1:27017

GOOGLE_AUTH_MODE=oauth
GOOGLE_CLIENT_ID=<from step 4>
GOOGLE_CLIENT_SECRET=<from step 4>
GOOGLE_REFRESH_TOKEN=<from step 5>
```

**7. Create the folder tree and prove it works**

```bash
npm run bootstrap:drive   # creates "GCloud" and Assets/Quarantine/Backups/Logs
npm run drive:check       # writes, reads, ranges, renames, moves and deletes a real file
```

`drive:check` is the one that matters. Everything else can pass while uploads still fail —
a read-only scope, a full Drive, a Shared Drive where the account is only a Viewer. This
exercises the actual code paths and tells you which one broke.

Then pin the root folder id it prints, so the app never has to search for it:

```ini
DRIVE_ROOT_FOLDER_ID=1AbC...
```

### Option B — Service account + Shared Drive

**1–2.** Same as above: create a project, enable the Drive API.

**3. Create the service account**

**IAM & Admin → Service Accounts → Create service account.** No roles are needed — Drive
access comes from Shared Drive membership, not from IAM.

**4. Create a key**

Open the service account → **Keys → Add key → Create new key → JSON**. It downloads once.

**5. Create a Shared Drive and add the robot to it**

At [drive.google.com](https://drive.google.com) → **Shared drives → New**. Open it →
**Manage members** → paste the service account's email (`...@....iam.gserviceaccount.com`)
→ role **Content manager**.

Copy the Shared Drive id from the URL: `drive.google.com/drive/folders/`**`0AB1cd...`**

**6. Fill in `.env`**

```ini
GOOGLE_AUTH_MODE=service_account
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./secrets/gcloud-drive.json
DRIVE_ID=0AB1cd...
```

Or paste the two fields instead of using the file — note the quotes and the literal `\n`:

```ini
GOOGLE_SERVICE_ACCOUNT_EMAIL=gcloud@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
```

**7.** `npm run bootstrap:drive && npm run drive:check` — same as Option A.

---

## 2. Run it

```bash
docker compose --profile local up -d mongo   # or point MONGODB_URI at Atlas
npm install
npm run build
npm start
```

Open **http://localhost:8100**. The library seeds itself on first boot: 5 artists,
12 songs, ~120 real files, plus deliberate drift so Storage health has something true to
report and deliberate duplicates so the Duplicates page does too. Total upload is a few
megabytes.

Sign in with the founding administrator — `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`.
That account is created on an empty database and repaired on every boot if it goes missing,
gets suspended or stops being an Admin, so there is always a way in.

The other seeded accounts are colleagues on the **User** role. They hold `SEED_PASSWORD`,
which is a handover value rather than a credential: it opens the sign-in screen once and
nothing else, and every route stays closed until the person sets a password of their own.
The boot banner names any account still in that state.

There are two roles, and the line between them is drawn at what cannot be undone:

| | User | Admin |
|---|:-:|:-:|
| Search, preview, download | ✅ | ✅ |
| Upload, edit, rename, move, share | ✅ | ✅ |
| Delete — to the Drive bin, recoverable for 30 days | ✅ | ✅ |
| Storage health and drift remediation | ✅ | ✅ |
| **Purge permanently** (no bin, no revisions, no undo) | ❌ | ✅ |
| **Empty the Drive bin** (the whole account's, not just ours) | ❌ | ✅ |
| Activity log, add and manage accounts | ❌ | ✅ |

The two rows in bold destroy data nothing can bring back, so they also re-ask for the
operator's own password — a signed-in tab is not evidence that the person at the keyboard
meant it. Everything a User can do has a way back.

The last active Admin cannot be demoted or suspended — including by themselves — because a
library with no administrator has no route back.

For front-end work, run the API and the Vite dev server side by side:

```bash
npm run dev       # API on :8100
npm run dev:web   # UI on :8101, proxying /api
```

---

## 3. How storage behaves

| | Google Drive |
|---|---|
| Address | Immutable **file id**; the name is ordinary mutable metadata |
| Folders | **Real folders**, mirrored by the catalogue, and they nest |
| Rename | **One PATCH.** Renames the catalogue and the file together, no bytes moved |
| Move between folders | **Re-parent.** No bytes read, at any size |
| Upload | **Resumable session**, chunks in order, browser → Google directly |
| Download | **Streamed through the API** against a short-lived signed ticket |
| Checksums | **Always** — Google computes sha256 and md5 on arrival |
| Versions | **Revisions**, 100 or 30 days, pinnable to keep forever |
| Delete | **Trash** (recoverable, 30 days) or **delete** (final, all revisions) |
| Space remaining | **`about.get`** — the number everything depends on |

### The three that matter

**Uploads never touch the API.** The browser is handed a Drive resumable session URI and
sends the bytes straight to Google. Each chunk is answered with a 308 saying how much
Google now holds, so a dropped connection resumes from Google's own byte count in a single
round trip — no client-side bookkeeping that can drift out of step.

**Downloads pass through this process, and that is a deliberate trade.** Drive offers no
self-authorising expiring link for a file held under a server credential. The only
alternative is granting `anyone: reader`, which is *permanent public exposure* rather than
a five-minute grant — so this build does not do it. Instead `/api/files/:token` streams
from Drive against a short-lived HMAC ticket. Nothing is buffered, `Range` is forwarded
verbatim so video scrubbing works, and aborts propagate. The reasoning is written out at
the top of [`server/src/services/signing.js`](server/src/services/signing.js).

**A Drive is a place people can open.** Somebody will rename a file, drag it between
folders, or bin it without telling the app. None of that is corruption, so reconciliation
reports it as `NAME_DRIFT`, `PARENT_DRIFT` and `TRASHED_IN_DRIVE` — findings with two
defensible answers each (believe Drive, or push the catalogue's version back), and neither
is preselected.

---

## 4. De-duplication

**The problem.** The same music video is in *Reels*, in *Client delivery* and in *Final
exports* under three different names. Nobody can tell whether they are the same file or
three different edits, so nobody deletes any of them, and the Drive fills up.

Four tiers, cheapest and most certain first. **Nothing is ever deleted automatically.**

| Tier | Finds | Certainty | Cost |
|---|---|---|---|
| **Identical** | Byte-for-byte the same file | **Fact** — Google's own sha256 | Free |
| **Perceptual** | Same footage, different resolution or bitrate | Very likely | ffmpeg + reads every file |
| **Same media** | Same duration, dimensions and size, different bytes | Likely | Free |
| **Same name** | Names rhyme once copy suffixes are stripped | Unconfirmed | Free |

The first tier is free and cannot be wrong, because Google computes a sha256 for every file
on arrival — nothing here has to read a byte or trust a client to have hashed honestly. It is the tier that catches
the case above, and it runs over the in-memory catalogue in about a millisecond, which is
why `/dedupe` is a live page rather than a nightly job.

### Three ways to resolve a group, and deleting is not the first

**Link** — keep every catalogue entry exactly where it is, point them all at one Drive file,
bin the redundant copies. The video still appears in all three folders, because it genuinely
belongs in all three; only the duplicated bytes go. Every share link keeps working. This is
usually what somebody actually wants, and it is offered **only for byte-identical files** —
linking two files that merely look alike would silently replace one edit with another.

**Version** — not duplicates at all, but takes of one thing. Folds them into one version
history. Deletes nothing.

**Trash** — keep one, bin the rest. Recoverable for 30 days from either side.

### Getting the space back

Trashed files still count against Drive quota until Google clears them 30 days later. The
Duplicates page has an **Empty the Drive bin** action for when the Drive is full *today* —
it asks for a typed confirmation, because it empties the whole account bin, including files
GCloud never touched.

### Perceptual matching

No checksum can tell you a 1080p master and its 720p re-encode are the same video; every
byte differs. Perceptual hashing can. It samples 8 evenly-spaced frames per file, reduces
each to a 32×32 greyscale image, takes a 2-D DCT and keeps the top-left 8×8 block — the
broad light-and-dark structure. Resolution, bitrate and compression artefacts live in the
high frequencies it discards, which is exactly why it survives a re-encode. Files are
compared by matching each frame to its nearest counterpart in the other and taking the
median Hamming distance, so a different lead-in shifts the alignment without wrecking the
score.

It reads every video back out of Drive and decodes it, so it is opt-in:

```ini
DEDUPE_PERCEPTUAL=true
DEDUPE_PERCEPTUAL_FRAMES=8
DEDUPE_PERCEPTUAL_MAX_DISTANCE=10   # out of 64 bits; lower is stricter
```

Needs `ffmpeg` on `PATH` (the Docker image includes it). Results are cached per file until
that file changes. The other three tiers work without it.

---

## 5. Installing it as an app

GCloud is a PWA. On a phone or a desktop it installs to the home screen or the dock, opens
without browser chrome, and starts from cache instead of from the network.

**Installing.** Chrome and Edge offer it themselves — the app also shows an install card at
the bottom of the screen, which is dismissible and does not come back for a month. On iOS
there is no prompt to offer: Safari installs from **Share → Add to Home Screen**.

**It requires HTTPS**, with one exception: `localhost` is treated as secure, so the whole
thing can be tested locally with `npm start`. Served over plain HTTP from any other
hostname, the service worker will not register and none of this happens.

### What works offline, and what does not

The **shell** is cached: the bundle, the stylesheet, the icons, the typeface. The app opens
offline and tells you it is offline.

The **library is not cached** — not the catalogue, not the files. Two reasons, and the
first is the one that decided it: every `/api` response is somebody's private library
behind a session, and a copy of it on disk outlives signing out, on a device that may be
shared or lost. The second is that it could not work anyway — `/api/files` streams byte
ranges for video scrubbing, and a cache that answered a range request with the whole file
would break seeking.

So: an installed GCloud with no network opens instantly and shows you an offline notice.
It does not show you a stale catalogue, which is the failure mode worth avoiding in a
product whose entire job is telling you whether a file is really there.

### Updating

A deploy is picked up on the next visit. The new version installs in the background and
waits — it never swaps the bundle out from under an upload in progress. The reader gets a
"new version is ready" card and reloads when it suits them.

The mechanism is `dist/sw.js`, generated at build time by the `gcloud-pwa` plugin in
`client/vite.config.ts` from the template in `client/service-worker.js`. Its revision is a
hash of the precached bytes, so it changes when the build changes and stays put when it
does not. Two server-side headers make it work, both in `server/src/index.js`: `sw.js` is
served `no-cache`, and `/assets/*` is served `immutable`.

### Icons

`client/public/icons/` is generated, and committed. `npm run --workspace client icons`
redraws it from the geometry in `scripts/gen-icons.mjs` — the mark is five bars in a
rounded square, so it is drawn from the brand tokens rather than stored as artwork, and
the script has no dependencies.

---

## 6. Commands

```bash
npm run drive:auth        # mint a refresh token, interactively
npm run drive:plan        # dry run — show what bootstrap would do
npm run bootstrap:drive   # create the folder tree
npm run drive:check       # full write/read/range/rename/move/delete round trip

npm start                 # API + built client on :8100
npm run dev               # API with --watch
npm run dev:web           # Vite dev server on :8101

npm run seed              # fill an empty library
npm run reseed            # wipe MongoDB and the Drive folder, then seed
npm run reconcile         # one reconciliation pass, from the CLI
npm run dedupe            # duplicate report in the terminal
npm run dedupe -- --level exact --family Video --json

npm run smoke             # end-to-end against a running instance and a real Drive
```

---

## 7. Troubleshooting

**`invalid_grant` on boot**
The refresh token is dead. Three causes, in order of likelihood: the consent screen is still
in **Testing** (7-day expiry — publish it), the account password changed, or the token went
six months unused. `npm run drive:auth` mints a new one.

**`storageQuotaExceeded` on upload**
Either the Drive is full, or you are using a service account without a Shared Drive. Check
`npm run drive:check` — it reports the quota and warns about the second case explicitly.
Remember that trashed files still count; empty the bin from the Duplicates page.

**`accessNotConfigured` / `Google Drive API has not been used`**
The Drive API is not enabled on the Cloud project. **APIs & Services → Library → Google
Drive API → Enable.** It takes a minute to propagate.

**`redirect_uri_mismatch` during `drive:auth`**
The redirect URI on the OAuth client must be exactly
`http://localhost:8107/oauth2callback` — no trailing slash, no `127.0.0.1`, no `https`.

**Uploads fail in the browser with a CORS error**
The API passes the browser's `Origin` to Google when it opens the session, and Google mirrors
it into that session's CORS policy. If `CORS_ORIGINS` does not include the origin the browser
is actually using, the upload is refused before it starts.

**Video will not scrub**
Check that `/api/files/:token` returns `206` to a `Range` request — `npm run drive:check`
tests this explicitly. If it returns `200`, something between the browser and this process is
stripping the header.

**Files uploaded outside the app do not appear**
They have no catalogue record. Run the check on **Storage health**; they show as
`UNTRACKED_IN_DRIVE` with an **Adopt** action. `GET /api/search/drive?q=...` searches the
Drive directly and marks which results are catalogued.

---

## Architecture notes

- **`server/src/storage/drive.js`** — the only file that knows what a Drive HTTP request
  looks like. No Google SDK; the surface needed is eleven endpoints, and hand-rolling keeps
  the field masks, the `supportsAllDrives` flags and the resumable protocol visible.
- **`server/src/services/storage.js`** — the only importer of the above. Everything else
  talks to this, which is what keeps the storage tier swappable.
- **`server/src/services/signing.js`** — why downloads are a ticket, in full.
- **`server/src/services/dedupe.js`** — the four tiers, and what each one is allowed to
  claim.
- **`server/src/db/store.js`** — the catalogue is held in memory and written through to
  MongoDB. Search facets, health roll-ups and the entire duplicate scan are O(n) passes over
  it, which is why they cost nothing.
