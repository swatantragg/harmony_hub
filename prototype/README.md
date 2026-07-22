# Maestro — working prototype

A running implementation of the Harmony Hub architecture, rebranded as **Maestro** per
`doc/Maestro_Brand_Book_02_Studio.html`. It runs on a laptop with no AWS account, no
MongoDB install, and no configuration.

```bash
cd server && npm install && npm start     # http://localhost:4000
```

Open <http://localhost:4000> and press any role card to sign in.
Accounts: `admin@` · `editor@` · `marketing@` · `viewer@maestro.app` — password `maestro`.

For front-end development with hot reload, run both halves:

```bash
cd server && APP_ORIGIN=http://localhost:5173 npm run dev
cd client && npm run dev                  # http://localhost:5173
```

---

## What is real

Everything below runs the genuine code path, not a mock.

| Capability | How to see it |
|---|---|
| **Store** — browser-direct multipart upload | Upload a file over 8 MB; watch parts land one square at a time, and pause/resume mid-flight |
| **Retrieve** — presigned GET with Range | Play any master audio; the scrubber seeks with HTTP Range and returns `206 Partial Content` |
| **Rename** — logical, instant, safe | Rename anything; the object key on the Storage tab is unchanged and existing share links keep working |
| **Verify availability** — live `HeadObject` | Press *Verify now* on any file, or *Verify these N* over a whole page of search results |
| Drift reconciliation | Admin → Storage health → *Run the check now* |
| External sharing | Share any file, then open the returned link in a private window |
| **Folders over a flat store** | Upload → *Upload a whole folder*; the files land as separate objects, grouped only in the catalogue |
| **Custom asset types** | Upload → type dropdown → *Add a new type*; try adding a near-duplicate to see the guard |
| **Tag consistency** | Type `RajuSingh` into a custom tag field next to the seeded `Raju Singh` |
| **Files without a song** | Leave *Which song?* as “Not tied to a song” — press kits and contracts are seeded this way |

The seeded library carries deliberate drift so the health dashboard has something true to
report on first run: one file missing from storage, one overwritten out of band, one in
archive, one mid-restore, one untracked object, and several never verified.

## Folders, without folders in storage

Amazon S3 has no directories, and this prototype does not pretend otherwise. A folder is a
document in the catalogue; membership is a single `folderId` on the asset. Every file still
lands as its own object under `assets/{uuid}/original.ext`.

The payoff is the same one that makes rename safe (§6.2): renaming a folder, moving files
between folders, and deleting a folder are all single-field updates that touch **zero**
objects. Deleting a folder releases its files back to the library rather than deleting
anything, so losing a grouping can never cost you a master.

Uploading a directory uses the browser's `webkitdirectory`, reads each file's
`webkitRelativePath`, creates one folder named after the dropped directory, and queues
every file into it — again as individual objects.

## Keeping the vocabulary clean

Two places let people extend the shared vocabulary, and both check for near-duplicates
before anything is created (`server/src/services/vocabulary.js`):

- **Asset types** — the built-in 21 cover a release; a team can add “Press Kit” or
  “Sync Licence” rather than filing a contract under “Lyrics”.
- **Tags** — the single biggest lever on search quality.

Names are normalised (case, spacing, punctuation and accents all collapse) and compared by
edit distance with a length-scaled tolerance. `RajuSingh` and `raju-singh` resolve to an
existing `Raju Singh` outright; `Raju Singhh` is offered as a suggestion the author can
override deliberately. Without this, one idea quietly becomes three tags and every future
search for it returns a third of the library.

## How the two halves map to AWS

```
/api/*    control plane   →  ECS Fargate, Express, JSON only. Never carries a file byte.
/s3/*     storage endpoint →  Amazon S3. Presigned-signature auth only; no JWT accepted.
```

`server/src/s3/localS3.js` implements the S3 verbs the platform uses — `PutObject`,
`HeadObject`, `GetObject` with Range, `CopyObject`, `DeleteObject`, `ListObjectsV2`, the
multipart family, and `RestoreObject` — against the local filesystem. Every caller reaches
it through `services/storage.js`, so swapping in `@aws-sdk/client-s3` is a one-file change.

Presigned URLs are HMAC-signed and expire: 5 minutes for downloads, 1 hour for previews
and upload parts. A tampered or expired signature returns `403`, which you can confirm
by editing any preview URL in the address bar.

`server/src/db.js` stands in for MongoDB 7 with the same collection names and document
shapes as §7 of the architecture, persisted to `server/data/db.json`.

## Layout

```
server/src/
├── index.js              two surfaces: /api (control) and /s3 (storage)
├── catalogue.js          21 built-in asset types, 4 families, tag vocabulary, role→permission matrix
├── seed.js               5 artists · 12 songs · 4 folders · 110 assets, with real bytes and real drift
├── s3/                   localS3.js · presign.js · routes.js
├── services/             storage (availability decision table) · reconcile · assets · audit
│                         vocabulary (tag + type similarity)
└── routes/               auth · dashboard · catalogue · assets · uploads · folders · search · shares · admin

client/src/
├── styles/tokens.css     the brand book as tokens — light + dark; nothing downstream hard-codes a colour
├── app/theme.ts          light / dark / system preference, resolved onto <html data-theme>
├── components/           Shell · CommandPalette · Tour · ui.tsx (badges, modals, toasts, ThemeToggle)
├── features/
│   ├── assets/           AssetDrawer · RenameDialog · AssetPreview · EditMetadataDialog
│   ├── upload/           UploadCenter · useUploadQueue.ts (the multipart engine)
│   │                     TypePicker (custom types) · TagPicker (similarity guard)
│   ├── folders/          FolderList · FolderDetail · FolderPicker
│   ├── search/           facets, live verification, grid and list views
│   ├── admin/            StorageHealth (drift + remediation) · ActivityLog · Users
│   └── help/             "How Maestro works" — the whole product in five minutes
└── lib/                  api · types · format · assetTypes (status copy) · vocabulary
```

## Light and dark

The control sits in the top bar and cycles **light → dark → match my system**, defaulting
to the system setting so nobody has to make a decision they already made at the OS level.
An explicit choice persists and survives reload and sign-in; in system mode the app tracks
the OS live, so flipping your machine to dark at dusk changes the page without a reload.
The sign-in and public share pages carry the same control, since neither has a top bar.

Dark is the **Studio identity after dark, not the Nocturne direction**. A theme toggle that
changed the typeface and swapped indigo for brass would be a different product, not a
different theme. So the typography and the brand accent hold, and what changes is:

- neutrals invert onto a layered dark ramp, borrowed from Nocturne's `surface-1/2/3`
  structure so the darks stay inside the brand family;
- indigo and spark lighten — the Studio values are tuned for contrast against white and go
  muddy against near-black;
- the six status colours switch to Nocturne's dark-tuned set, which is already built to
  stay legible on dark surfaces.

All of it lives in `client/src/styles/tokens.css`. There is exactly one selector for dark
(`:root[data-theme="dark"]`); when the preference is "system" the app resolves the OS
setting and writes the attribute itself, so the automatic and explicit paths cannot drift.
The resolved theme is painted before React mounts, so a dark reload never flashes light.

Measured contrast in dark: body text 17.4:1, muted 5.0:1, status badges 9.6:1, primary
button 5.6:1 — all clear WCAG AA.

## Design decisions worth knowing

**Spark is rationed.** The brand book allows one warm accent per screen. The top-bar
Upload button is therefore indigo, and each page spends its single spark on its own most
important action — *Run the check now* on Storage health, *Restore now* on an archived file.

**Status copy lives in one place.** `client/src/lib/assetTypes.ts` holds, for each of the
six availability states, what it means and what to do about it. The badge tooltip, the
drawer banner and the help page all read from that table, so the product never explains
the same state two different ways.

**A song is optional; a type is not.** Only the asset type and one tag gate an upload,
because those are what make a file findable. Forcing a song on a contract would only teach
people to file things under the wrong release.

**Nothing hard-codes a colour.** Every value resolves to a token, which is what made a
second theme a token swap rather than a rewrite — including the per-family card washes and
the six status triplets.

**Permissions are checked twice.** The server resolves them per request from the role;
the client reads the same matrix from `GET /api/me` and hides what a role cannot do — so
nobody discovers a boundary by being refused.

## Learning curve

The brief asked for under two days. The measures aimed at that:

- A five-step first-run tour, skippable and never repeated, replayable from Help.
- `⌘K` command palette where every destination carries a plain-language description.
- Plain-language status copy everywhere; no AWS vocabulary in the interface.
- The rename dialog states the before and after download name, and shows the stored key
  as unchanged — teaching the product's central idea at the moment it matters.
- Empty states that name the next action rather than describing the absence.
- Inline `?` tips on any term that could be unfamiliar.
- A Help page that explains the entire product, including the four tasks worth trying first.

## Known limits of the prototype

- Seeded video assets carry placeholder payloads, so the video player has nothing to
  decode. The preview panel says so rather than failing silently. Audio, images and
  documents are real files and genuinely play, render and open.
- Reconciliation runs on a long interval and on demand, rather than nightly via cron.
- Physical re-key runs inline on a short delay instead of through SQS, but preserves every
  safety invariant: copy, verify the destination independently, update the catalogue, and
  only then delete the source.
- Passwords use `scrypt` from the Node standard library rather than `bcrypt`, and JWTs are
  signed with `node:crypto` rather than `jsonwebtoken`, to keep the install to two packages.

**Re-seeding is guarded.** Each seed stamps the store with a generation id, and a process
only writes back over the generation it loaded. A server left running from an earlier
session therefore cannot overwrite a freshly seeded library with its stale in-memory copy —
it logs a warning and refuses. Restart it to pick up the new library.

Reset the demo library at any time: `cd server && npm run reseed`.
