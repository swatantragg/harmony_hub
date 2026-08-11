# GCloud

An internal platform for a music company: every digital asset produced for a release —
master audio, demos, cover art, music videos, social reels, banners, lyrics, behind-the-scenes
footage — in one searchable system, with rich metadata, manual tagging, role-based access,
version tracking and controlled sharing.

Storage is **Google Drive, exclusively**. The application is a management and search layer
over it: it decides what goes where, what it is called, who may see it, and how it is found.
Drive holds the bytes; MongoDB holds every searchable attribute plus the file id that links a
record to its file.

```
harmony_hub/
├── doc/   the specification, the project plan, and the brand books
└── app/   the application   ← start here
```

## Where to go

| I want to… | Go to |
|---|---|
| Connect a Google Drive, step by step | [`app/README.md`](app/README.md#1-set-up-google-drive) |
| Run the real thing | [`app/README.md`](app/README.md#2-run-it) |
| Understand duplicate detection | [`app/README.md`](app/README.md#4-de-duplication) |
| Understand how storage behaves | [`app/README.md`](app/README.md#3-how-storage-behaves) |
| Read the specification | [`doc/Harmony_Hub_Architecture_v3.md`](doc/Harmony_Hub_Architecture_v3.md) |

## Does a free Google account work?

**Yes, completely.** A personal Google account comes with 15 GB, shared across Drive, Gmail
and Photos. The seeded library is about **8 MB**, and there is no per-request billing, no
egress charge and no credit clock.

The one thing to know: while your OAuth consent screen sits in **Testing** status, Google
expires refresh tokens after 7 days. Click **Publish app** on the consent screen before
anyone relies on it. That needs no Google review for an app only your own accounts sign in
to. The setup guide covers this.

For a team, put the library in a **Shared Drive** on Google Workspace instead — storage comes
from the Workspace pool, and everyone sees the same folder tree.

## The four mandatory capabilities

| # | Capability | How it is delivered |
|---|---|---|
| 1 | **Store** | Browser-direct upload to a Drive **resumable session URI** — the bytes go straight to Google and never touch the API. A dropped connection resumes from Google's own byte count in one round trip |
| 2 | **Retrieve** | A short-lived signed ticket redeemed at `/api/files/:token`, streamed with `Range` forwarded so audio and video seek; [the reasoning is written out in full](app/server/src/services/signing.js) |
| 3 | **Rename** | One metadata `PATCH`. Drive addresses a file by an immutable id and treats its name as ordinary metadata, so the catalogue and the file are renamed together, no bytes move, and every share link keeps resolving |
| 4 | **Verify availability** | Live `files.get` on demand, plus a nightly recursive walk reporting every way the catalogue and the Drive have drifted apart |

Capability 4 is the interesting one: a Drive is a place people can open and rearrange by
hand, so reconciliation has to tell "somebody dragged this into another folder" apart from
"this file is gone", and offer a sensible remedy for each.

## Beyond the four

- **Real folders.** The library is laid out in the Drive exactly as it appears in the app,
  nesting included, so it stays legible to somebody who never signs in here.
- **Space remaining.** One request, and the number that decides whether anybody can upload
  tomorrow — so it is on the home screen, segmented by what is actually consuming it.
- **[De-duplication](app/README.md#4-de-duplication).** Google computes a sha256 for every
  file on arrival, which makes exact duplicate detection free and certain. Four tiers, from
  "this is a fact" to "worth a look", and three ways to resolve a group — of which deleting
  is not the first.

## Quick start

```bash
cd app
npm install
npm run drive:auth              # opens Google, prints the four GOOGLE_* lines
cp .env.example .env            # paste them in, plus JWT_SECRET and MONGODB_URI
docker compose --profile local up -d mongo
npm run bootstrap:drive         # creates the folder tree in your Drive
npm run drive:check             # proves upload, download, range, rename, move, delete
npm run build && npm start      # http://localhost:8100
npm run smoke                   # end-to-end against the real Drive
```

Or in Docker — one image serving the API and the client on the same port:

```bash
cd app && npm run docker:up      # http://localhost:8100
```

Ports on this machine: 80 and 8000 are cuesync, 8001 and 8090 are JGC3.
GCloud uses **8100** (app) and **8101** (Vite dev server). `drive:auth` briefly uses
**8107** for the OAuth redirect.
