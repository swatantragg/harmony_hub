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

0. [What this is, in one page](#0-what-this-is-in-one-page)
1. [Set up Google Drive — the full walkthrough](#1-set-up-google-drive)
2. [Run it](#2-run-it)
3. [How storage behaves](#3-how-storage-behaves)
4. [De-duplication](#4-de-duplication)
4a. [Finding and sharing things](#4a-finding-and-sharing-things)
5. [Installing it as an app](#5-installing-it-as-an-app)
6. [Commands](#6-commands)
7. [Troubleshooting](#7-troubleshooting)
7a. [Fitting the screen](#7a-fitting-the-screen)
8. [Scale — what the catalogue costs, and where it stops](#8-scale)

---

## 0. What this is, in one page

**A search layer over a Google Drive.** Drive holds the bytes. MongoDB holds everything
that makes those bytes findable — the name people gave a file, its tags, its type, its
folder, its language, who uploaded it and when. Neither is a copy of the other, and that
split is the whole design:

| | Google Drive | MongoDB |
|---|---|---|
| Holds | The file itself, all 39 GB of it if need be | ~2 KB of metadata about that file |
| Addresses it by | Immutable `fileId` | `assetId`, plus the `fileId` as the join |
| Names it | `IMG_1234.zip`, whatever the camera said | `Mumbai Legal Documents` — what a person typed |
| Knows about tags | Nothing | Everything |
| Survives if the other is lost | Yes — files stay openable in Drive | Yes — `npm run import:drive` rebuilds from Drive |

A Drive rename never deletes a tag. A tag edit never touches Drive bytes. The two are
reconciled, not merged.

### How a file gets in

**Through the app.** The browser asks the API to open an upload, and gets back a Google
**resumable session URI** and a chunk size. It then sends the bytes *straight to Google*,
8 MB at a time — the API never sees them. Above about 8 GB the chunk grows to keep a file
near 1,000 round trips, up to 128 MB, so a 150 GB file is ~1,200 chunks rather than 19,200.
Each chunk is answered with a `308` naming the byte Google now holds, so a dropped
connection resumes from Google's own count rather than from zero. A 39 GB file costs this
server a few hundred bytes of bookkeeping.

**Nothing heavy runs on the page.** The SHA-256 that warns "this file is already in the
library" is worked out in a Web Worker (`client/src/features/upload/hash.worker.ts`):
crypto.subtle for files up to 64 MB, an incremental hasher in 8 MB slices above that. It
fills in while somebody chooses a type and tags, and pressing Upload stops it — the upload
never waits for it, and Google's own SHA-256, computed on arrival, is what duplicate
detection uses afterwards. Before SK-V5.3.0 that hash ran on the page itself — measured in
Chrome, a 1 GB file held the tab for 51 seconds without a single repaint, so 10 GB was eight
minutes — and restarted for every file still hashing whenever anything in the queue
changed: the "page unresponsive" prompt. In the worker the same 1 GB takes ~13 s and the
page never stalls for more than a frame. Upload progress is written to the screen at most
every 400 ms, however many files are moving.

The session URI is a bearer credential, so the server records every one it opens
(`uploadSessions`, with a TTL index) and refuses to resume or cancel one it did not.

**Straight into Drive, bypassing the app entirely.** Somebody drags a folder into
drive.google.com, or their desktop client syncs one. Nothing tells the app. So the app
asks: a **mirror** runs every `DRIVE_SYNC_INTERVAL_SEC` (120s) and calls Drive's
**Changes API** with a stored page token, which returns only what moved since last time —
not the whole Drive. New files are adopted with a catalogue record, renames and moves are
followed, a trashed file is flagged rather than dropped. The page token is saved after
each successful pass, so a failure resumes from the last good page instead of rescanning
1.4 TB.

Nothing in the mirror invents a tag or a category. An adopted file arrives with a name and
a family inferred from its MIME type, and waits for a person.

It waits visibly. Every file and folder the mirror adopts is stamped `origin: 'DRIVE'`,
`reviewedAt: null`, and carries a **New** badge everywhere it is listed until somebody edits
its details (that counts as reviewing it) or presses **Looks right — mark reviewed**
(`POST /api/assets/review`, `POST /api/folders/:id/review` with `files: true` for a folder and
its contents). Home counts them; `?review=pending` narrows search and the folder list to them.
Rows adopted before SK-V5.1.0 carry no stamp and are left alone, so the badge means *new*
rather than *everything the sync ever touched*.

The Folders page has a **New** button beside its heading: lit, with a count, while folders
adopted from Drive wait for review; grey otherwise, with the explanation on hover or tap.
Pressed, it opens the one new folder, or lists them all (`/folders?review=pending`). A folder
row also says how many files inside it are still new from Drive (`newFileCount`).

**What the mirror will not do is delete.** A file that vanished from Drive is marked
`MISSING` and handed to reconciliation, because silently dropping the row would take its
tags, its version history and its live share links with it.

### How a file gets out

Downloads *do* pass through this process, deliberately. Drive has no expiring
self-authorising link for a file held under a server credential — the only alternative is
`anyone: reader`, which is permanent public exposure, not a five-minute grant. So
`/api/files/:token` streams from Drive against a short-lived HMAC ticket. Nothing is
buffered, `Range` is forwarded so video scrubs, and aborts propagate.

### How search works

**Every search is answered from MongoDB's data, never from Drive.** A Drive round trip per
keystroke would be unusable, and Drive cannot answer "everything tagged Mumbai and Legal,
newest first" at all.

The catalogue is read into process memory once at boot and written back through on change
(`server/src/db/store.js`). A search is then a pass over that working set:

1. **Score** — if there is a search term, each asset is scored across eleven fields with
   different weights. An exact tag match is worth 24; a display-name match 6; a hit in the
   description, 1. Prefix matches score double, exact matches triple.
2. **Filter** — family, type, language, mood, tags, availability, version, artist, year,
   folder and placement. All independent, all combinable.
3. **Facet** — every filter reports its counts *with itself relaxed*, which is what makes
   "Audio (1,991)" still visible while you are looking at Video.
4. **Sort** — relevance, newest, oldest, recently updated, name, largest, smallest.
5. **Page** — `?page=` or `?cursor=`. The cursor is a keyset, and is the one to use while
   a sync is running: offsets repeat and skip rows when the catalogue shifts underneath.

`GET /api/search/drive?q=` is the exception — it queries Drive directly, and exists only
to find files that have no catalogue record yet.

### Where tags come from

Five sections, and the split between them is what is bundled versus what is served:

| Section | Names | Source |
|---|--:|---|
| Mood / theme | 7 | Bundled in the client and the server |
| Format / use | 7 | Bundled in the client and the server |
| **Song** | 133 | `doc/Goongoonalo_Content_Mgt_Songs_*.xlsx`, column *Song Name* |
| **Artist** | 98 | `doc/Total Goongoonalo Artist.xlsx`, column *Artist Name* |
| **Event** | 12 | `doc/Goongoonalo_Content_Mgt_Events_*.xlsx`, column *Event Name* |

The three from the sheets are **generated**, not transcribed — `npm run tags:build` reads
the workbooks and writes `server/src/tag-vocabulary.js`; `npm run tags:check` fails if the
two have drifted. Transcribing them by hand is what produced six song titles with a comma
baked into the string and ten more carrying an invisible U+2060, each of which looked
correct on screen and matched nothing in a search.

They are **served**, not bundled, because a name filed into one of them through the
**Custom tag** box has to appear for everybody without a redeploy. The box has an optional
section dropdown beside it: leave it blank and the tag is a one-off, or choose Song, Artist
or Event and it joins that list — `POST /api/tags` with `group`, recorded in the activity
log either way. A section over 14 names gets a filter box instead of a wall of chips, and
whatever is already on the file stays pinned at the front of its section, so nothing a
person chose can be hidden behind a search term.

### A folder's tags, and its files

A folder's tags used to stay on the folder: tagging a folder dropped into Drive left every
file in it untagged. **Edit folder** now asks where the tags go — `tagScope` on
`PATCH /api/folders/:id`:

| `tagScope` | What changes |
|---|---|
| `folder` (default) | The folder only. Its files keep exactly the tags they have. |
| `files` | The folder, and every file directly inside it. |
| `tree` | The folder, and every file in it and in every folder below it. |

For `files` and `tree`, each file gets every tag the folder now has, and loses every tag this
edit took off the folder; tags a file has of its own are left alone, and two spellings of one
tag never end up side by side. Files tagged this way count as reviewed, and their Drive
`appProperties` are updated in the background, as a tag rename does.

### Renaming and deleting a tag

**Administration → Manage tags.** Every tag by section, with the number of files carrying it
beside it; click one to see those files.

A tag is a string copied onto every file that carries it — there is no join — so editing one
is a bulk rewrite of the whole catalogue rather than a row update:

| | What happens |
|---|---|
| **Rename** | The new name replaces the old on every asset *and every folder*, in one pass. Order within each file's tag list is preserved. |
| **Rename onto a name already in use** | A merge, and it is refused with a `409` until confirmed. A file that carried both ends up with one, and there is no way back. |
| **Delete** | The tag comes off everything. **No file is deleted, moved or re-uploaded** — a tag is metadata. |
| **Drive** | `appProperties` on each affected file is updated afterwards, in the background, with bounded concurrency. The catalogue is already correct before that starts. |

Matching is case- and punctuation-insensitive, using the same `normalise` that decides two
tags are the same everywhere else. So renaming `Demo` also rewrites `demo` and `DEMO` —
which is usually the point, since search already treats those three as one tag and the
picker already refuses to create the second one. Where a tag has more than one spelling in
circulation, Manage tags says so on the row.

The count beside each tag is recomputed from the files on every request rather than read
from the stored `usageCount`, which is incremented on upload and has no way of noticing an
edit that took a tag off a file. A number that disagrees with what clicking it shows would
be worse than no number.

Deleting a tag that is on 25 files or more asks for the tag name to be typed first.

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
| Manage tags — rename or delete a tag across every file | ✅ | ✅ |
| **Purge permanently** (no bin, no revisions, no undo) | ❌ | ✅ |
| **Empty the Drive bin** (the whole account's, not just ours) | ❌ | ✅ |
| Activity log, add and manage accounts | ❌ | ✅ |

The two rows in bold destroy data nothing can bring back, so they also re-ask for the
operator's own password — a signed-in tab is not evidence that the person at the keyboard
meant it. Everything a User can do has a way back.

The last active Admin cannot be demoted or suspended — including by themselves — because a
library with no administrator has no route back.

### Signing in with Google

Every account can also be opened with **Continue with Google**, against the same email
address the administrator typed when they created it. It is a second way through the same
door, not a second account: `user01@gmail.com` signs in with the password *or* with Google,
and the session, the role and the audit trail are identical either way. Using one never
switches the other off, and there is nothing to enable per person — the link forms itself
the first time somebody uses it, and the People screen then says so.

It never creates accounts. Google settles *who this is*; GCloud still decides whether that
address has access, so an address nobody has been added is refused and told to ask an
administrator.

It reuses the OAuth client `npm run drive:auth` already set up, so the only step is to
authorise the callback address on it:

> Google Cloud console → **APIs & Services → Credentials** → your OAuth client →
> **Authorised redirect URIs** → add `http://localhost:8100/api/auth/google/callback`
> (that is `PUBLIC_ORIGIN` + `/api/auth/google/callback`, so add the deployed https one too)

Until it is listed, Google answers `redirect_uri_mismatch` and the sign-in screen says
exactly that. Set `GOOGLE_SIGNIN_ENABLED=false` to remove the button, or
`GOOGLE_SIGNIN_HOSTED_DOMAIN=yourdomain.com` to accept one Workspace only. A separate
client can be used instead through `GOOGLE_SIGNIN_CLIENT_ID` / `_SECRET`.

Somebody added by an administrator who signs in with Google before ever using the handover
password is still asked to choose a password — but is not asked for the one they were never
sent, because Google has just proved who they are. That exemption lasts a few minutes,
covers exactly one password, and never applies to an account that has already set one.

### Where a file's language comes from

Language began as a property of the **song**, which is right for the common case: the six
files that make up one release share a language, and recording it once on the release is
the only thing that keeps them in step. But most of the library is not attached to a song —
a loose reel, a BTS clip, an artist photo, a lyric sheet filed in a folder — and those had
nowhere to put a language at all. They came out blank on every screen, and a language
filter silently excluded them rather than saying so.

So a file may now carry a language of its own. It is asked for at upload, beside the type
and the tags, and it is editable afterwards from **Edit details**. Both places offer the
controlled list and still accept anything typed, because a library that refuses an unlisted
language is a library somebody works around; a typed value is snapped to a list entry when
it differs only by case.

**The field is offered on audio and video only.** A cover, a banner or a credits sheet has
no language of its own, and a field that insists otherwise collects a guess. This governs
the field rather than the value: artwork attached to a Hindi release still reports Hindi,
inherited from the release, which is what keeps *"every asset for the Hindi catalogue"* a
filter that returns the artwork too. Re-typing a reel as a cover clears the
file-level language in the same save — leaving it behind would strand a value no screen
could show or remove. The server enforces the rule as well as the form.

The order of resolution is: **the file's own language, then its release's.** A file-level
value exists only because somebody stated it about *that file*, which is a stronger claim
than the release's default — an English-subtitled cut of a Hindi single is exactly the case
that needs it. A file's details panel says which of the two answered, so a value is never
shown without saying where it came from.

Nothing is guessed. A file with no language of its own and no release behind it reports no
language, and search's language filter offers **—** so *"which files have no language
recorded?"* is an answerable question rather than a gap in a dropdown. Creating a
song no longer fills in `Hindi` when the field is left alone, for the same reason.

### Taking the activity log out

**Admin → Activity log** exports to `.xlsx`. The button carries whatever the screen is
filtered to — the search, the action, the date range, the order — so what lands in the file
is what was on screen, and a second **Export everything** appears whenever a filter is
active in case the wider view was wanted.

The export reads the full audit archive rather than the 2,000 most recent entries the
screen holds, so *"everything that happened in March"* is answerable months later. It
carries the columns a table has no room for — the socket address, the forwarded-for header
when it disagreed with it, the device, and the complete before/after payloads — and a
second sheet records who exported it, when, and precisely which filters were applied. An
audit extract with no note of what it left out is not worth much.

Taking a copy is itself an entry in the log, with the filters that were used.

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

## 4a. Finding and sharing things

**Search is sorted into categories.** One title usually exists four times over — the master,
the video, the artwork, the lyric sheet — and a single ranked list interleaves all of them.
Searching a name therefore opens with a section per kind: songs and audio, then videos,
then images, then documents, then a catch-all. Each header carries that category's real
total, not the number on screen, and **See all** opens one category in full as an ordinary
family filter — which means it is also a URL somebody can be sent. **One list** in the
toolbar returns to a single ranked list, and that choice lives in the URL too (`view=list`).

Grouping applies only where it earns its place: there has to be a search term, and no
family may already be chosen, because a single-family search would be one section.

**A link can be given no expiry at all.** Beside the hour / day / week / month choices there
is **Never expires**, stored as a null `expiresAt` rather than a date far in the future so
that every screen and every counter can say *never* honestly. Such a link ends when somebody
revokes it, which is instant and applies everywhere — including to a page already open. The
download cap, the passcode and the access log all work exactly as they do on a dated link,
and **Share links** has a *Never expires* filter and a count of how many are open-ended, so
they cannot quietly accumulate.

**Every long list pages.** Folders, songs, artists, share links, duplicate groups, people,
the files inside a folder and the files on a release all carry the same control: a
rows-per-page picker, numbered pages, first/last, and a *go to page* box. **All rows** is
one of the choices where scrolling really is what you want.

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

A deploy is noticed without waiting for the next visit. Every open copy — installed app,
browser tab, phone home screen — polls `/version.json` every five minutes and whenever it
comes back to the front. A different revision there means a deploy has landed, and the card
that appears names the version and lists what went into it before offering **Reload**.

Nothing reloads underneath anybody. The new version installs in the background and waits;
the button is what swaps it in, so an upload in progress is never interrupted. After the
reload the app says once what changed, keyed on the build tag, and does not mention it
again.

The mechanism is `dist/sw.js` and `dist/version.json`, both generated at build time by the
`gcloud-pwa` plugin in `client/vite.config.ts` — the worker from the template in
`client/service-worker.js`, the manifest from `BUILD_TAG` and the top entry of
`client/src/lib/releaseNotes.ts`. **Editing `releaseNotes.ts` is how the update card gets
its text**: the top entry is the release being built.

The revision in both is a hash of the precached bytes, so it changes when the build changes
and stays put when it does not. `version.json` is deliberately excluded from the precache
and served network-only by the worker — a cached copy of it would answer the one question
it exists to ask. Two server-side headers make the rest work, both in `server/src/index.js`:
`sw.js` is served `no-cache`, and `/assets/*` is served `immutable`.

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
npm run measure           # catalogue size, memory and search latency — read-only
npm run measure -- --json # the same, as JSON, for trending it over time
npm run tags:build        # rebuild the Song/Artist/Event tag lists from doc/*.xlsx
npm run tags:check        # fail if those lists and the sheets disagree
npm test                  # server suite — needs a MongoDB at TEST_MONGODB_URI; never touches Drive
npm run dedupe            # duplicate report in the terminal
npm run dedupe -- --level exact --family Video --json

npm run smoke             # end-to-end against a running instance and a real Drive
npm run smoke:ui          # every page mounts, in jsdom
npm run smoke:responsive  # layout measured in headless Chrome at 7 real widths
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

**Empty folders called “Harness folder 1790…” or “Harness tags one 1790…” in Drive**
Left by `npm test` before SK-V5.1.0. The test harness started its server with the live
`app/.env`, so `POST /api/folders` in `shares.test.mjs` and `tags.test.mjs` made real Drive
folders (the number is `Date.now()` at the moment of the run), the scratch database was
dropped afterwards, and the live Drive sync adopted each folder into the library. The harness
now sets `GCLOUD_SKIP_DOTENV=1`, blanks every Google credential, seeds its folders straight into
the scratch database, and refuses to run if its server reports a working Drive. The leftovers
show on **Storage health** with a **Remove** button: only empty folders whose name matches
exactly and whose creation time matches the number in it, moved to the Drive bin (recoverable
for 30 days) and off the lists here.

---

## 7a. Fitting the screen

The app is a PWA, so "the screen" runs from a 320px phone to a desktop, and the reader may
have set their own default font size on top of that.

**Type is fluid, not stepped.** Every size is a `clamp()` on a `rem` base — the `--fs-*`
tokens in `styles/tokens.css`. Two things follow. A `rem` base means the default font size
somebody has chosen in their browser or their OS is respected rather than overridden, which
a fixed `px` size cannot do; that is why the same build read as too large on one device and
too small on the next. And fluid means no cliff at a breakpoint: the scale used to jump once
at 720px and then sit flat, so a 719px tablet and a 320px phone got identical text.

The ceiling of each clamp is the size this app has always used on a wide screen, so nothing
changes there:

| | 320px | 390px | 768px | 1440px |
|---|--:|--:|--:|--:|
| Body | 15.5 | 15.5 | 16.6 | 18.0 |
| Heading | 27.5 | 28.6 | 34.7 | 36.0 |
| Text input | 16.0 | 16.0 | 16.6 | 18.0 |

**Text inputs never go below 16px.** `font-size: max(16px, var(--fs-body))`. Below 16px iOS
Safari zooms the page when a field takes focus and leaves it zoomed, which is where most
reports of "it needs horizontal scrolling" on an iPhone actually come from.

**Nothing scrolls sideways.** `overflow-x: clip` on `html` — `clip` rather than `hidden`,
because `hidden` makes the element a scroll container and silently breaks the sticky top bar.
That is a backstop, not the fix: replaced elements are capped at `max-width: 100%`, headings
and notes break long unbroken tokens (a Drive file id has no spaces in it), and `.spread`
wraps rather than pushing its buttons off the right edge.

### Checking it

```bash
npm run build && npm run smoke:responsive
```

It renders representative markup into the real built stylesheet and measures it in headless
Chrome at 320, 360, 390, 430, 768, 1024 and 1440px: whether the document scrolls sideways,
whether any element reaches past the viewport, whether any input is under 16px, and whether
the type scale actually moves between the narrowest and widest.

Each width is measured **inside an iframe**, not in a browser window. Chrome will not open a
window narrower than about 490px, so a 320px window silently measures 490px and reports a
pass that means nothing. The check fails loudly if the width it measured is not the width it
asked for.

---

## 8. Scale

> Measured on the live catalogue, 2026-09-28, with `npm run measure`. Re-run it before
> trusting any of these numbers — they are a snapshot, not a property of the code.

| | Measured | Headroom |
|---|---|---|
| Assets | **17,941** | warn at 20,000, act at 75,000 |
| Bytes in Drive | **1.37 TB** across those assets | Drive's problem, not this process's |
| Largest single file | **38.9 GB** | streamed and chunked, never resident |
| Folders | 2,179 | |
| Working set | 34.8 MB as JSON | |
| RSS after load | **512 MB** | container cap is **1 GB** — this is the tight one |
| Boot `load()` | 3.3 s | before the first request is served |

**The number that matters is the asset count, not the terabytes.** 1.37 TB is Drive's
concern; it costs this process nothing, because bytes never pass through it on upload and
are streamed on download. What costs this process is *rows* — every one of them is resident
in RAM and walked by every search.

### What was slow, and what it cost

A search was three things at once: `allAssets()` rebuilding the joined row set, eleven
filtered passes to count the facets, and the scoring pass. Two of those were doing far more
work than they needed to.

`allAssets()` resolved each asset's folder with `Array.find` over the folder list — a linear
scan **per asset**. At 17,941 assets across 2,179 folders that is ~39M comparisons to answer
one search. It now indexes the joins once per call. Separately, the facet counter ran a full
filtered pass for each of eleven filters; passes that skip a filter nobody set are all the
same pass, so it computes that one once and shares it.

| Search, p50 / p95 | Before | After |
|---|---|---|
| Unfiltered first page | 334.6 / 404.5 ms | **73.2 / 88.2 ms** |
| One filter applied | 305.0 / 326.0 ms | **17.6 / 23.5 ms** |
| Typed term | 258.6 / 278.3 ms | **18.8 / 24.3 ms** |

This matters more than the ratio suggests: Node runs one thread, so 400 ms in a search was
400 ms during which nothing else was answered. Two people searching at once queued.

A page load also used to *block* on the Drive sync it triggered, for up to 6 s, putting a
Drive round trip in front of a read MongoDB could already answer. `DRIVE_SYNC_PAGE_WAIT_MS`
now defaults to `0`: the sync still starts, the screen is served immediately from the
catalogue, and the result arrives on the next poll. Set it back to `6000` for the old
behaviour.

### Where this design ends

The catalogue is resident in one process, and one process owns the write. That holds fine
at 18k assets. It ends at two specific places, neither of which is reached yet:

1. **RAM.** 512 MB resident against a 1 GB container. Roughly linear in asset count, so
   ~35k assets is where the cap starts to bite. Raising `mem_limit` buys time, not a fix.
2. **Concurrency.** Nothing else may write to these collections — see the architecture note
   on `flushCollection`. So there can be no second container, and no background worker
   process, until this changes.

**When either one binds, the move is the same one:** assets get their own MongoDB
collection with indexes on the fields that are actually filtered, and search becomes a query
instead of a scan. Everything else — a job queue, a worker, horizontal scale — waits on
that, because all of it needs a second writer. `?cursor=` on the search API is already the
keyset shape that move needs, so the wire format will not change when it happens.

Until then: `npm run measure`. `/api/admin/health` reports the same verdict (`HOLD`,
`WARN`, `REWRITE`) on every call, so the threshold gets noticed when it is crossed rather
than when a page starts timing out.

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
  it, which is why they cost nothing *at this size*. [Section 8](#8-scale) has the
  measurements and the point where that stops being true.
- **`server/src/cli/measure.js`** — read-only. The numbers section 8 is argued from.
- **One process owns the catalogue.** `flushCollection` deletes any MongoDB row absent from
  this process's working set, which is correct for a single writer and destructive for two.
  A second process writing to these collections — a worker, a second container, a script
  holding its own `load()` — will have its rows deleted on the next flush. Anything
  concurrent has to wait on the move described in section 8.
