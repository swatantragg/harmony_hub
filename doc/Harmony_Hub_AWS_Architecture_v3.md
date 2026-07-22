# Harmony Hub — AWS-Only Architecture & Technical Specification

**Version** 3.0 · **Supersedes** v1.0 (Google Drive), v2.0 (AWS + CDN) · **Stack** MERN on AWS · **Status** Draft for Review · **Date** July 2026

---

## Document Control

| Field | Value |
|---|---|
| Storage platform | Amazon S3 — exclusive |
| Delivery method | S3 presigned URLs, direct browser-to-S3 |
| Third-party cloud services | **None permitted** |
| Cost posture | Not a constraint; egress charges accepted |
| Mandatory capabilities | Store · Retrieve · **Rename** · **Verify availability in S3** |

> **Note on scope.** Amazon CloudFront, Amazon Cognito, and AWS Elemental MediaConvert are all AWS first-party services under the same account and bill. This document excludes them per project instruction, and uses only Amazon S3, Amazon EC2/ECS, Amazon EBS, Elastic Load Balancing, AWS Certificate Manager, Amazon Route 53, AWS IAM, AWS Secrets Manager, Amazon CloudWatch, and Amazon SQS. Every media operation resolves to a plain S3 API call.

---

## Contents

| | |
|---|---|
| 1. Executive Summary | 9. Backend Architecture |
| 2. Constraints & Governing Principles | 10. Core Workflows *(detailed)* |
| 3. Technology Stack | 11. API Contract |
| 4. System Architecture | 12. Security Model |
| 5. AWS Services Inventory | 13. Deployment & Operations |
| 6. S3 Storage Design | 14. Development Roadmap |
| 7. Data Model | 15. Risks & Mitigations |
| 8. Frontend Architecture | 16. Open Decisions |

---

## 1. Executive Summary

Harmony Hub is an internal web platform for a music company. It centralises every digital asset produced for a release — master audio, demos, cover art, music videos, social reels, banners, lyrics, and behind-the-scenes footage — into one searchable system with rich metadata, manual tagging, role-based access, version tracking, and controlled sharing.

**Storage is Amazon S3, exclusively.** The application is a management and search layer over S3: it decides what goes where, what it is called, who may see it, and how it is found. S3 holds the bytes. MongoDB holds every searchable attribute plus the S3 object key that links a metadata record to its file. The Express API brokers access but never carries file bytes — uploads go from the browser straight into S3, and downloads come from S3 straight to the browser, both through short-lived presigned URLs signed by the backend.

### 1.1 The Four Mandatory Capabilities

| # | Capability | How it is delivered | Section |
|---|---|---|---|
| 1 | **Store** data in AWS | Browser-direct S3 multipart upload via presigned URLs | §10.1 |
| 2 | **Retrieve** data from AWS | Presigned `GET` with Range support for streaming | §10.2, §10.3 |
| 3 | **Rename** files when required | Logical rename (instant) + optional physical re-key (`CopyObject` + `DeleteObject`) | §10.4 |
| 4 | **Verify availability** in S3 | `HeadObject` live probe + nightly `ListObjectsV2` reconciliation + drift report | §10.5, §10.11 |

Capabilities 3 and 4 drive two of the most important design decisions in this document, because **S3 has no native rename operation and no native "does the database still match the bucket" guarantee**. Both are solved in the application layer, and both are specified in full.

---

## 2. Constraints & Governing Principles

### 2.1 Hard Constraints

1. All object storage is Amazon S3. No Google Drive, no Cloudflare R2, no Backblaze, no Dropbox, no external CDN.
2. No third-party SaaS in the data path — including managed database vendors outside AWS.
3. Cost is not a design constraint. Correctness, control, and clarity take precedence.
4. Every file must be renameable through the platform.
5. The platform must be able to answer, authoritatively, "is this file actually present in S3 right now?"

### 2.2 Governing Principles

**P1 — S3 is the source of truth for bytes; MongoDB is the source of truth for meaning.**
A file exists if S3 says it exists. A file is *findable* because MongoDB describes it. When the two disagree, S3 wins and the drift is reported (§10.11).

**P2 — File bytes never pass through the application server.**
Not because of cost, but because it is architecturally wrong: a 5 GB upload through Express consumes server memory, holds a connection for minutes, and fails atomically on a dropped packet. Browser↔S3 direct transfer is resumable, parallel, and keeps the API tier small and stateless.

**P3 — S3 object keys are immutable.**
Once written, a key is never changed by normal operation. Human-facing names live in MongoDB and in S3 object metadata. This makes rename instant and safe (§6.3, §10.4). A physical re-key remains available as an explicit, audited operation.

**P4 — Every S3 mutation is recorded.**
Upload, rename, delete, restore, and share are written to `activityLog` with actor, timestamp, IP, and before/after state. The audit trail is the platform's, not AWS's.

**P5 — All S3 access is presigned and short-lived.**
No bucket is public. No object is public. No permanent URL exists anywhere in the system.

---

## 3. Technology Stack

### 3.1 Frontend

| Concern | Choice | Why |
|---|---|---|
| Framework | **React 18** | Specified in v1.0; component model suits a media-card grid |
| Language | **TypeScript** | Asset type catalogue is a 21-value union — the compiler enforces it end to end |
| Build tool | **Vite** | Fast dev server, small production bundle, first-class TS |
| Styling | **Tailwind CSS** | Specified in v1.0; rapid iteration on a dense dashboard UI |
| Routing | **React Router v6** | Nested routes map cleanly to Artist → Song → Asset |
| Server state | **TanStack Query** | Caching, background refetch, and optimistic updates — critical for rename and availability polling |
| UI state | **Zustand** | Small, unopinionated; holds upload queue, filters, selection |
| Forms | **React Hook Form + Zod** | One Zod schema validates on the client and again on the server |
| Uploads | **Custom hook over `fetch` + S3 multipart** | Per-part progress, retry, pause/resume, concurrency control |
| Audio | **WaveSurfer.js** | Waveform scrubbing for master audio and snippets |
| Video | **Native `<video>` + HTTP Range** | S3 serves Range requests, so seeking works without any streaming service |
| Tables/virtualisation | **TanStack Virtual** | 10,000-asset lists render without jank |
| Icons | **Lucide React** | Consistent iconography per asset family |

### 3.2 Backend

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node.js 20 LTS** | Specified in v1.0; excellent AWS SDK support |
| Framework | **Express.js** | Specified in v1.0; minimal, well-understood middleware model |
| Language | **TypeScript** | Shared Zod schemas and asset-type unions with the frontend |
| AWS access | **AWS SDK v3 for JavaScript** (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) | Modular, tree-shakeable, native presigning |
| ODM | **Mongoose** | Specified in v1.0; schema validation and middleware hooks |
| Database | **MongoDB 7 on EC2** (3-node replica set) | Preserves the v1.0 document model *and* `$text` indexes; see §3.3 |
| Auth | **JWT** (`jsonwebtoken` + `bcrypt`) | Specified in v1.0; stateless, no external identity provider |
| Validation | **Zod** | Single schema source shared with the frontend |
| Background jobs | **Amazon SQS + Node worker** | Reconciliation, physical rename, bulk operations |
| Scheduling | **`node-cron` in a dedicated worker** | Nightly reconciliation, share expiry sweep |
| Logging | **Pino → CloudWatch Logs** | Structured JSON, queryable in Logs Insights |
| Testing | **Vitest + Supertest + `@aws-sdk/client-s3-mock`** | S3 calls mocked in unit tests, real bucket in integration tests |

### 3.3 Database Decision

MongoDB must stay inside AWS with no third-party vendor. Three options were evaluated.

| Option | `$text` search | Mongoose | Ops burden | Verdict |
|---|---|---|---|---|
| **MongoDB 7 on EC2, 3-node replica set** | ✅ Native | ✅ Full | Medium — we patch and back up | **Recommended** |
| Amazon DocumentDB | ❌ **No text indexes** | ⚠️ Partial API compat | Low — fully managed | Rejected — forces a search rewrite |
| DocumentDB + Amazon OpenSearch | ✅ Via OpenSearch | ⚠️ Partial | High — dual-write, index sync, eventual consistency | Fallback at scale only |

**Recommendation: MongoDB 7 on EC2.** It preserves the v1.0 data model, embedded `assets[]` array, Mongoose schemas, and `$text` index without a single line of rework. Deployed as a three-node replica set across three Availability Zones, with EBS gp3 volumes, automated EBS snapshots to S3, and `mongodump` backups to a dedicated S3 bucket. This is a well-trodden pattern with mature tooling.

If the library later outgrows `$text` relevance quality, Amazon OpenSearch Service is the documented upgrade path — an additive index alongside MongoDB, not a replacement.

---

## 4. System Architecture

Three tiers, with all media storage and media transfer offloaded to S3. The application tier is stateless and handles only JSON and URL signing.

```
┌────────────────────────────────────────────────────────────────────────┐
│  USERS                                                                 │
│  Admin  ·  Editor  ·  Viewer  ·  Marketing  ·  External Partner        │
└─────────────────────────────────┬──────────────────────────────────────┘
                                  │ HTTPS (TLS 1.2+)
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Amazon Route 53  →  Application Load Balancer  →  ACM certificate     │
└─────────────────────────────────┬──────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│  PRESENTATION TIER — React 18 + TypeScript + Tailwind (Vite build)     │
│  Static bundle served by Express `static` middleware from the same     │
│  ECS task. Search-first dashboard · media-card grid · upload manager   │
└─────────────────────────────────┬──────────────────────────────────────┘
                                  │  JSON only — never file bytes
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│  APPLICATION TIER — Amazon ECS Fargate (2+ tasks, private subnets)     │
│  Node.js 20 · Express · TypeScript                                     │
│                                                                        │
│   routes/ ─► controllers/ ─► services/ ─► repositories/ ─► adapters/   │
│                                    │                          │        │
│              ┌─────────────────────┴──────────┐               │        │
│              │ AuthService    · JWT + bcrypt  │               │        │
│              │ AssetService   · CRUD, rename  │               │        │
│              │ StorageService · presign, head │───────────────┤        │
│              │ SearchService  · $text + facet │               │        │
│              │ ShareService   · tokens        │               │        │
│              │ AuditService   · activityLog   │               │        │
│              │ ReconcileSvc   · S3 ↔ DB drift │               │        │
│              └────────────────────────────────┘               │        │
└──────────────────┬──────────────────────────────┬─────────────┼────────┘
                   │                              │             │
                   ▼                              ▼             │
┌──────────────────────────────┐  ┌──────────────────────┐      │
│  DATA TIER                   │  │  JOB TIER            │      │
│  MongoDB 7 replica set       │  │  Amazon SQS          │      │
│  3 × EC2 across 3 AZs        │  │  + Fargate worker    │      │
│  EBS gp3 · snapshots → S3    │  │  · reconciliation    │      │
│                              │  │  · physical rename   │      │
│  users · artists · songs     │  │  · bulk delete       │      │
│  tags · shares · activityLog │  │  · restore polling   │      │
│  reconciliationRuns          │  └──────────┬───────────┘      │
└──────────────────────────────┘             │                  │
                                             ▼                  ▼
        ┌───────────────────────────────────────────────────────────────┐
        │  STORAGE TIER — Amazon S3   (S3 Gateway VPC Endpoint)         │
        │                                                               │
        │   harmonyhub-assets-prod     originals, versioning ON         │
        │   harmonyhub-uploads-prod    multipart landing zone           │
        │   harmonyhub-backups-prod    mongodump + EBS snapshots        │
        │   harmonyhub-logs-prod       S3 + ALB access logs             │
        │                                                               │
        │   Block Public Access: ON at bucket AND account level         │
        │   Access: IAM role + presigned URLs only                      │
        └───────────────────────────────────────────────────────────────┘
                          ▲                            │
                          │  presigned PUT             │  presigned GET
                          │  (browser → S3)            │  (S3 → browser)
                          └────────── BROWSER ─────────┘
                                 bytes bypass the API entirely

┌────────────────────────────────────────────────────────────────────────┐
│  OBSERVABILITY — Amazon CloudWatch (logs, metrics, alarms, dashboards) │
│  AWS CloudTrail (API audit) · AWS Secrets Manager (JWT + DB secrets)   │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Responsibility Split

| Amazon S3 (bytes) | Harmony Hub (meaning) |
|---|---|
| Durable object storage, 11 nines | Metadata, tags, and searchable index |
| Versioning and lifecycle | Semantic version lineage (V1 / V2 / Final) |
| Range-request streaming | Preview and playback orchestration |
| Server-side encryption | Role-based authorisation |
| Object existence and integrity | **Availability verification and drift reporting** |
| Immutable key namespace | **Human-facing names and rename operations** |
| Storage class tiering | Artist / song / release management, analytics |

---

## 5. AWS Services Inventory

The complete list. Nothing outside it is used.

| Service | Role in Harmony Hub |
|---|---|
| **Amazon S3** | All object storage: assets, upload staging, backups, logs |
| **Amazon ECS on AWS Fargate** | Runs the Express API and the background worker as containers |
| **Amazon ECR** | Stores the API and worker container images |
| **Amazon EC2** | Hosts the MongoDB replica set (3 nodes, 3 AZs) |
| **Amazon EBS** | gp3 volumes for MongoDB data, with scheduled snapshots |
| **Elastic Load Balancing (ALB)** | TLS termination, health checks, routing to Fargate tasks |
| **AWS Certificate Manager** | TLS certificate for the ALB |
| **Amazon Route 53** | DNS for the application hostname |
| **Amazon VPC** | Private subnets, security groups, S3 gateway endpoint |
| **AWS IAM** | Task roles, instance roles, least-privilege S3 policies |
| **AWS Secrets Manager** | JWT signing secret, MongoDB credentials |
| **Amazon SQS** | Job queue for reconciliation, physical rename, bulk operations |
| **Amazon CloudWatch** | Logs, metrics, alarms, dashboards |
| **AWS CloudTrail** | AWS-level API audit trail |
| **AWS Backup** *(optional)* | Centralised EBS snapshot policy |

---

## 6. S3 Storage Design

### 6.1 Bucket Layout

| Bucket | Contents | Versioning | Lifecycle |
|---|---|---|---|
| `harmonyhub-assets-{env}` | All uploaded assets — the irreplaceable originals | **ON** | Noncurrent versions expire at 180 days |
| `harmonyhub-uploads-{env}` | Multipart staging, transient | Off | Abort incomplete MPU after 1 day; expire objects after 7 |
| `harmonyhub-backups-{env}` | `mongodump` archives, EBS snapshot exports | ON | Transition to Glacier at 30 days, expire at 365 |
| `harmonyhub-logs-{env}` | S3 server access logs, ALB access logs | Off | Expire at 365 days |

All four have **Block Public Access enabled at both bucket and account level**. No bucket policy grants `Principal: "*"`. Access is exclusively through IAM roles and presigned URLs.

### 6.2 Key Schema — Immutable and UUID-Rooted

This is the most consequential decision in the document, because it is what makes rename safe.

```
assets/{assetId}/original{ext}

assets/1c9de4a7-8b02-4f31-9a55-2d7e6f0b1c33/original.mp4
assets/7b2f1088-3c41-4e90-8a12-9f5d0c2b7e44/original.jpg
assets/8f3a2bc5-0d19-4a67-b3e2-1c8f4d9a6e02/original.wav
```

The key contains **no artist name, no song name, no version label, and no user-supplied filename**. It is derived from a UUID generated at upload and is never changed.

**Why not the human-readable hierarchy of v1.0?**

| Human-readable key (`masters/raju-singh/dil-se/...`) | UUID key (`assets/{uuid}/original.ext`) |
|---|---|
| Renaming an artist orphans thousands of keys | Rename touches zero S3 objects |
| Renaming a file requires copy + delete | Rename is a MongoDB field update |
| Filename collisions between editors | Collision-free by construction |
| Special characters, spaces, Unicode break keys | Key charset fully controlled |
| Moving a song between artists rewrites keys | Reassignment is a metadata change |

Organisation, hierarchy, and human names are **MongoDB's job**. The bucket is a content-addressed store; the database is the filing system. This inverts v1.0's Drive-folder thinking and is what turns "rename" from a risky data migration into a single `updateOne`.

### 6.3 S3 Object Metadata

Although the key is opaque, every object carries user-defined metadata so that the bucket remains self-describing when inspected directly in the S3 console or by an AWS CLI operator:

```
x-amz-meta-asset-id       1c9de4a7-8b02-4f31-9a55-2d7e6f0b1c33
x-amz-meta-display-name   dilse_bts_reel_v2.mp4
x-amz-meta-song-id        song_1042
x-amz-meta-song-title     Dil Se
x-amz-meta-artist         Raju Singh
x-amz-meta-asset-type     Reel - BTS/MV
x-amz-meta-family         Video
x-amz-meta-version        V2
x-amz-meta-uploaded-by    user_12
Content-Type              video/mp4
Content-Disposition       attachment; filename="dilse_bts_reel_v2.mp4"
```

`x-amz-meta-display-name` and `Content-Disposition` are refreshed whenever a logical rename occurs (§10.4), keeping the object self-describing without moving a byte.

### 6.4 Storage Classes

Cost is not a constraint, so the tiering exists for retrieval-latency reasons rather than economy.

| Tier | Asset types | Class | Retrieval |
|---|---|---|---|
| Standard | Everything by default | S3 Standard | Immediate |
| Archive *(optional)* | BTS — Unedited Footage older than 1 year | S3 Glacier Flexible Retrieval | 1–5 min expedited / 3–5 h standard |

Archived assets appear in the UI with an **"Archived — restore required"** state, and the restore workflow is specified in §10.9. If the content team prefers all assets to remain instantly available, the lifecycle rule is simply omitted — the application handles both cases.

### 6.5 Versioning

S3 Object Versioning is enabled on the assets bucket. It serves two purposes:

1. **Safety net** — an accidental overwrite or delete is recoverable; deletes create a delete marker rather than destroying data.
2. **Rename rollback** — a physical re-key that fails midway can be reversed because the source version still exists.

Semantic versions that users see (`V1`, `V2`, `Final`, `Final Master`) are **separate assets with separate `assetId` values**, linked by a shared `versionGroupId`. This keeps lineage explicit and every version independently addressable.

---

## 7. Data Model

MongoDB, document-oriented. A song embeds its metadata and an array of asset sub-documents, so loading a song with all its assets is a single read.

### 7.1 Collections

| Collection | Key fields | Purpose |
|---|---|---|
| `users` | `_id, name, email, passwordHash, role, status, lastLoginAt` | Accounts and roles |
| `artists` | `_id, name, slug, label, genre, contact, imageAssetId, socials[], deletedAt` | Artist profiles |
| `songs` | `_id, title, artistId, featuring[], language, mood, isrc, releaseDate, tags[], assets[], deletedAt` | Songs with embedded assets |
| `tags` | `_id, name, type ("controlled"\|"custom"), usageCount` | Manual tagging vocabulary |
| `shares` | `_id, assetId, token, createdBy, expiresAt, canDownload, maxDownloads, downloadCount, revokedAt` | External share links |
| `restoreRequests` | `_id, assetId, requestedBy, tier, status, requestedAt, availableUntil` | Glacier restore tracking |
| `reconciliationRuns` | `_id, startedAt, finishedAt, objectsScanned, missingInS3[], untrackedInS3[], mismatched[]` | S3 ↔ DB drift reports |
| `activityLog` | `_id, userId, action, entity, entityId, before, after, ip, userAgent, timestamp` | Full audit trail |

### 7.2 Asset Sub-Document

```jsonc
{
  "assetId": "1c9de4a7-8b02-4f31-9a55-2d7e6f0b1c33",

  // ── Human-facing identity — freely renameable ──────────────
  "displayName": "dilse_bts_reel_v2.mp4",
  "originalName": "BTS REEL FINAL edit 3 (1).mp4",   // as uploaded, never changed
  "description": "BTS reel cut for Instagram launch",

  // ── Catalogue classification (v1.0 Section 8) ──────────────
  "type": "Reel - BTS/MV",
  "family": "Video",
  "format": "9:16",

  // ── S3 binding — immutable ────────────────────────────────
  "s3": {
    "bucket": "harmonyhub-assets-prod",
    "key": "assets/1c9de4a7-8b02-4f31-9a55-2d7e6f0b1c33/original.mp4",
    "versionId": "3sL0zXqAe9Kk1PmR",
    "region": "ap-south-1",
    "storageClass": "STANDARD",
    "sizeBytes": 48210432,
    "etag": "\"9f8e7d6c5b4a3210fedcba9876543210-6\"",
    "checksumSHA256": "e3b0c44298fc1c149afbf4c8996fb924...",
    "contentType": "video/mp4",
    "uploadedAt": "2026-02-10T11:38:02Z"
  },

  // ── Availability verification (§10.5) ─────────────────────
  "availability": {
    "status": "AVAILABLE",           // AVAILABLE | MISSING | ARCHIVED | RESTORING | MISMATCH | UNVERIFIED
    "lastCheckedAt": "2026-07-21T02:00:14Z",
    "lastVerifiedAt": "2026-07-21T02:00:14Z",
    "checkMethod": "HEAD_OBJECT",    // HEAD_OBJECT | LIST_RECONCILE
    "detail": null
  },

  // ── Version lineage ───────────────────────────────────────
  "versionGroupId": "vg_88fa21c0",
  "version": "V2",
  "isCurrent": true,
  "supersedes": "0a4b12de-...",

  // ── Descriptive metadata ──────────────────────────────────
  "mimeType": "video/mp4",
  "durationSec": 28,
  "dimensions": null,
  "tags": ["Reel", "BTS", "Viral"],

  // ── Provenance ────────────────────────────────────────────
  "uploadedBy": "user_12",
  "createdAt": "2026-02-10T11:38:02Z",
  "updatedAt": "2026-06-04T09:12:44Z",
  "renamedAt": "2026-06-04T09:12:44Z",
  "deletedAt": null
}
```

**The three-name model** is deliberate and central to §10.4:

| Field | Mutable | Meaning |
|---|---|---|
| `s3.key` | Never | Where the bytes physically are |
| `displayName` | Freely | What every user sees and downloads as |
| `originalName` | Never | What the file was called when first uploaded — forensic record |

### 7.3 Indexes

```js
songs.createIndex({ title: "text", tags: "text", "assets.displayName": "text" })
songs.createIndex({ artistId: 1, releaseDate: -1 })
songs.createIndex({ language: 1 })
songs.createIndex({ mood: 1 })
songs.createIndex({ "assets.type": 1 })
songs.createIndex({ "assets.assetId": 1 }, { unique: true, sparse: true })
songs.createIndex({ "assets.s3.key": 1 }, { unique: true, sparse: true })   // drift detection
songs.createIndex({ "assets.s3.checksumSHA256": 1 })                        // deduplication
songs.createIndex({ "assets.availability.status": 1 })                      // health dashboard
songs.createIndex({ "assets.availability.lastCheckedAt": 1 })               // stale-check sweep
songs.createIndex({ "assets.versionGroupId": 1, "assets.isCurrent": 1 })
shares.createIndex({ token: 1 }, { unique: true })
shares.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
activityLog.createIndex({ timestamp: -1 })
activityLog.createIndex({ entityId: 1, timestamp: -1 })
```

---

## 8. Frontend Architecture

### 8.1 Application Structure

```
src/
├── app/
│   ├── router.tsx              route tree, lazy boundaries
│   ├── providers.tsx           QueryClient, auth, toasts, theme
│   └── guards.tsx              <RequireAuth>, <RequireRole role="Editor">
├── features/
│   ├── auth/                   login, token refresh, session store
│   ├── artists/                list, detail, form, gallery
│   ├── songs/                  list, detail, form, asset tray
│   ├── assets/
│   │   ├── AssetCard.tsx           grid card, availability badge
│   │   ├── AssetDetailPanel.tsx    metadata, versions, actions
│   │   ├── RenameDialog.tsx        §10.4 UI
│   │   ├── AvailabilityBadge.tsx   §10.5 UI
│   │   ├── VersionTimeline.tsx     lineage view
│   │   └── DownloadButton.tsx      presign → browser download
│   ├── upload/
│   │   ├── UploadDropzone.tsx
│   │   ├── UploadQueue.tsx         concurrent, pausable, resumable
│   │   ├── MetadataForm.tsx        type picker + tag chips
│   │   └── useMultipartUpload.ts   core S3 multipart hook
│   ├── search/
│   │   ├── SearchBar.tsx           universal query input
│   │   ├── FacetPanel.tsx          type, family, language, mood, year
│   │   └── ResultsGrid.tsx         virtualised media-card grid
│   ├── shares/                 create, list, revoke share links
│   └── admin/
│       ├── StorageHealth.tsx       drift dashboard (§10.11)
│       ├── ReconcileRuns.tsx       run history and reports
│       ├── ActivityLog.tsx         audit viewer
│       └── UserManagement.tsx
├── components/                 Button, Modal, Table, Toast, EmptyState…
├── lib/
│   ├── api.ts                  typed fetch client, auth header, retry
│   ├── s3Upload.ts             PUT part with progress + retry
│   ├── schemas.ts              Zod schemas shared with backend
│   └── assetTypes.ts           the 21-type catalogue as a const union
└── hooks/
    ├── useAssetAvailability.ts polling + on-demand verification
    └── useDebounced.ts
```

### 8.2 Key Screens

| Screen | Purpose |
|---|---|
| **Search-first home** | Prominent universal search bar, quick filter chips, recent uploads, storage health summary |
| **Search results** | Virtualised media-card grid; each card shows thumbnail placeholder, type badge, version chip, availability badge |
| **Artist detail** | Profile, image gallery, discography, aggregate asset counts by family |
| **Song detail** | Metadata panel + asset tray grouped by family; per-asset actions (preview, rename, download, version, share, verify) |
| **Asset detail panel** | Full metadata, S3 binding (key, size, ETag, storage class), version timeline, availability history, audit entries |
| **Upload manager** | Dropzone, per-file metadata form with required tag step, live per-part progress, pause/resume/retry |
| **Rename dialog** | Live validation, extension guard, preview of the resulting download name, physical re-key opt-in for Admins |
| **Admin — storage health** | Drift dashboard: missing in S3, untracked in S3, checksum mismatches, last reconciliation run |
| **Share manager** | Active links, expiry countdown, download counts, one-click revoke |

### 8.3 The Multipart Upload Hook

`useMultipartUpload` is the most complex piece of frontend logic. Behaviour:

1. Accepts a `File`, computes SHA-256 in a Web Worker (non-blocking).
2. Calls `POST /api/uploads/initiate` with filename, size, MIME type, checksum, asset type.
3. Receives an `uploadId` and an array of presigned part URLs (8 MB parts).
4. Uploads up to **4 parts concurrently**, tracking bytes-sent per part via `XMLHttpRequest.upload.onprogress`.
5. Retries a failed part up to 3 times with exponential backoff — only that part, never the whole file.
6. Supports pause (halt dispatch, keep completed ETags) and resume (request fresh presigned URLs for remaining parts).
7. On completion, posts the ordered `{ PartNumber, ETag }` list to `POST /api/uploads/complete`.
8. Surfaces per-file state: `HASHING → READY → UPLOADING → FINALISING → DONE | FAILED | PAUSED`.

### 8.4 Availability in the UI

Every asset card and detail panel renders an `<AvailabilityBadge>` driven by `asset.availability.status`:

| Status | Badge | Behaviour |
|---|---|---|
| `AVAILABLE` | 🟢 Available | Download and preview enabled |
| `UNVERIFIED` | ⚪ Not checked | Shown when `lastCheckedAt` is older than 24 h; "Verify now" button |
| `ARCHIVED` | 🔵 Archived | Download replaced by "Request restore" |
| `RESTORING` | 🟡 Restoring | Progress note with expected availability time |
| `MISSING` | 🔴 Missing in S3 | Download disabled, banner shown, Admin alerted |
| `MISMATCH` | 🟠 Integrity mismatch | Download allowed with warning; flagged for Admin review |

A "Verify now" action calls `POST /api/assets/{id}/verify`, which performs a live `HeadObject` and returns the fresh status — the user gets a definitive answer about S3 in under a second.

---

## 9. Backend Architecture

### 9.1 Layered Structure

```
src/
├── server.ts                   Express bootstrap, middleware chain
├── config/                     env schema (Zod), AWS clients, Mongoose connection
├── routes/                     thin — path → controller binding only
│   ├── auth.routes.ts      ├── songs.routes.ts     ├── shares.routes.ts
│   ├── artists.routes.ts   ├── assets.routes.ts    ├── search.routes.ts
│   └── uploads.routes.ts   └── admin.routes.ts
├── controllers/                HTTP concerns: parse, validate, status codes
├── services/                   ALL business logic
│   ├── auth.service.ts             login, JWT issue/verify, password hashing
│   ├── artist.service.ts
│   ├── song.service.ts
│   ├── asset.service.ts            create, rename, version, soft-delete
│   ├── storage.service.ts          ◄── the only module that touches S3
│   ├── search.service.ts           $text + facet aggregation
│   ├── share.service.ts            token issue, validate, revoke
│   ├── reconcile.service.ts        S3 ↔ DB drift detection
│   └── audit.service.ts            activityLog writer
├── repositories/               Mongoose queries; no business rules
├── adapters/
│   └── s3.adapter.ts           AWS SDK v3 wrapper — swappable, testable
├── middleware/
│   ├── authenticate.ts         verify JWT → req.user
│   ├── authorize.ts            role gate: authorize('Admin','Editor')
│   ├── validate.ts             Zod schema per route
│   ├── rateLimit.ts            per-user and per-route buckets
│   └── errorHandler.ts         RFC 7807 problem+json
├── workers/
│   ├── reconcile.worker.ts     nightly full-bucket scan
│   ├── rename.worker.ts        physical re-key (copy → verify → delete)
│   └── restore.worker.ts       polls Glacier restore completion
└── shared/
    ├── schemas.ts              Zod — shared with frontend
    ├── assetTypes.ts           the 21-type catalogue
    └── errors.ts               typed application errors
```

### 9.2 `StorageService` — the S3 Surface

Every S3 interaction in the entire platform passes through this one module. Nothing else imports the AWS SDK.

| Method | S3 API | Used by |
|---|---|---|
| `initiateUpload(meta)` | `CreateMultipartUpload` + `getSignedUrl` × N | §10.1 |
| `completeUpload(uploadId, parts)` | `CompleteMultipartUpload` | §10.1 |
| `abortUpload(uploadId)` | `AbortMultipartUpload` | §10.1 |
| `presignDownload(key, filename, ttl)` | `getSignedUrl(GetObjectCommand)` with `ResponseContentDisposition` | §10.2 |
| `presignPreview(key, ttl)` | `getSignedUrl(GetObjectCommand)` with `ResponseContentDisposition: inline` | §10.3 |
| `headObject(key)` | `HeadObject` | §10.5 |
| `updateObjectMetadata(key, meta)` | `CopyObject` self-copy, `MetadataDirective: REPLACE` | §10.4 |
| `copyObject(srcKey, dstKey)` | `CopyObject` / `UploadPartCopy` for >5 GB | §10.4 |
| `deleteObject(key)` | `DeleteObject` | §10.8 |
| `listObjects(prefix, token)` | `ListObjectsV2` paginated | §10.11 |
| `restoreObject(key, tier)` | `RestoreObject` | §10.9 |
| `listVersions(key)` | `ListObjectVersions` | §6.5 |

Because `s3.adapter.ts` sits beneath it, `StorageService` is fully unit-testable against a mocked S3 client, and the platform retains a clean seam should storage ever need to change.

### 9.3 Middleware Chain

```
helmet → cors → requestId → pinoHttp → express.json({ limit: '1mb' })
      → rateLimit → authenticate → authorize → validate(zodSchema)
      → controller → errorHandler
```

The 1 MB JSON body limit is deliberate: the API is structurally incapable of accepting a file upload, which enforces principle **P2** at the framework level.

---

## 10. Core Workflows

### 10.1 Upload — Storing Data in AWS

```
BROWSER                      EXPRESS API                    AMAZON S3
   │                              │                              │
   │ 1. select file + metadata    │                              │
   │    + required tag step       │                              │
   │                              │                              │
   │ 2. SHA-256 in Web Worker     │                              │
   │                              │                              │
   │ 3. POST /uploads/initiate ──►│                              │
   │    {name,size,mime,sha256,   │ 4. verify JWT + role         │
   │     type,songId}             │ 5. validate against          │
   │                              │    asset-type catalogue      │
   │                              │ 6. dedup: sha256 already     │
   │                              │    in DB? → offer link       │
   │                              │ 7. assetId = uuidv4()        │
   │                              │    key = assets/{id}/orig.ext│
   │                              │ 8. CreateMultipartUpload ───►│
   │                              │◄─── uploadId ────────────────│
   │                              │ 9. presign N part URLs       │
   │◄── {assetId,uploadId,parts[]}│                              │
   │                              │                              │
   │ 10. PUT part 1..N  ═══════════════ 4 concurrent ═══════════►│
   │     (bytes bypass the API entirely)                         │
   │◄══════════════ ETag per part ═══════════════════════════════│
   │     retry failed parts individually, up to 3×               │
   │                              │                              │
   │ 11. POST /uploads/complete ─►│                              │
   │     {uploadId, parts[]}      │ 12. CompleteMultipartUpload ►│
   │                              │◄── final ETag + VersionId ───│
   │                              │ 13. HeadObject (verify) ────►│
   │                              │◄── size, checksum, class ────│
   │                              │ 14. size + checksum match?   │
   │                              │     no → abort + 409         │
   │                              │ 15. write asset sub-document │
   │                              │     availability = AVAILABLE │
   │                              │ 16. activityLog: ASSET_UPLOAD│
   │◄── 201 { asset } ────────────│                              │
   │                              │                              │
   │ 17. card appears in grid     │                              │
```

**Notes.** Part size is 8 MB, giving up to 10,000 parts and a ~78 GB ceiling — far beyond any real asset. Presigned part URLs expire in 60 minutes; the frontend requests fresh ones on resume. An abandoned upload is cleaned up by both the explicit `abort` call and the bucket's incomplete-MPU lifecycle rule.

### 10.2 Download — Retrieving Data from AWS

```
BROWSER                      EXPRESS API                    AMAZON S3
   │                              │                              │
   │ 1. click "Download" ────────►│                              │
   │    POST /assets/{id}/download│ 2. verify JWT                │
   │                              │ 3. authorize role for this   │
   │                              │    asset type                │
   │                              │ 4. load asset from MongoDB   │
   │                              │ 5. HeadObject (live check) ─►│
   │                              │◄── 200 | 404 | Glacier ──────│
   │                              │                              │
   │                              │  404      → 410 Gone,        │
   │                              │             mark MISSING     │
   │                              │  Glacier  → 409, offer       │
   │                              │             restore (§10.9)  │
   │                              │  200      → continue         │
   │                              │                              │
   │                              │ 6. presign GetObject         │
   │                              │    TTL 300 s                 │
   │                              │    ResponseContentDisposition│
   │                              │      = attachment;           │
   │                              │        filename="{display}"  │
   │                              │ 7. activityLog: ASSET_DOWNLOAD│
   │◄── { url, expiresAt } ───────│                              │
   │                              │                              │
   │ 8. window.location = url ══════════════════════════════════►│
   │◄══════════ file streams S3 → browser ═══════════════════════│
   │    saved as displayName, not the S3 key                     │
```

**The `ResponseContentDisposition` parameter is what makes the UUID key invisible to users.** The object is stored at `assets/1c9de4a7.../original.mp4`, but the browser saves it as `dilse_bts_reel_v2.mp4` — whatever `displayName` currently says. Rename therefore takes effect on the very next download with no S3 operation at all.

### 10.3 Preview & Streaming

S3 natively supports **HTTP Range requests**, so a presigned `GET` URL placed in a `<video src>` or `<audio src>` gives full seek-and-scrub playback with no streaming service involved.

```
   <video src={presignedUrl} controls />
             │
             ├─ browser issues: Range: bytes=0-1048575
             │  S3 responds:    206 Partial Content
             │
             └─ user drags scrubber to 02:30
                browser issues: Range: bytes=41943040-43008000
                S3 responds:    206 Partial Content
```

Preview URLs are signed with `ResponseContentDisposition: inline` and a 1-hour TTL, and are refreshed transparently by TanStack Query before expiry. Large source files stream progressively rather than downloading in full, so playback starts immediately.

### 10.4 Rename — Mandatory Capability

**S3 has no rename operation.** Keys are immutable; the only physical equivalent is copy-then-delete. Harmony Hub therefore offers two rename modes, and defaults to the one that is instant and risk-free.

#### 10.4.1 Mode A — Logical Rename *(default, recommended)*

```
BROWSER                      EXPRESS API                    AMAZON S3
   │                              │                              │
   │ 1. open Rename dialog        │                              │
   │    new name: "dilse_reel_    │                              │
   │    final.mp4"                │                              │
   │                              │                              │
   │ 2. PATCH /assets/{id}/rename ►                              │
   │    { displayName }           │ 3. verify JWT + Editor role  │
   │                              │ 4. validate:                 │
   │                              │    · 1–255 chars             │
   │                              │    · no / \ : * ? " < > |    │
   │                              │    · extension preserved     │
   │                              │      (or explicit override)  │
   │                              │    · unique within the song  │
   │                              │ 5. capture `before` state    │
   │                              │ 6. MongoDB updateOne:        │
   │                              │      displayName             │
   │                              │      renamedAt, updatedAt    │
   │                              │ 7. refresh S3 object metadata│
   │                              │    CopyObject onto itself,  ►│
   │                              │    MetadataDirective=REPLACE │
   │                              │    x-amz-meta-display-name   │
   │                              │    Content-Disposition       │
   │                              │◄── 200 (no bytes moved) ─────│
   │                              │ 8. activityLog: ASSET_RENAME │
   │                              │    { before, after }         │
   │◄── 200 { asset } ────────────│                              │
   │                              │                              │
   │ 9. UI updates instantly      │                              │
   │    next download uses new    │                              │
   │    name via Content-Disposition                             │
```

**Properties:** completes in milliseconds; the object key never changes so no link, share, or cached URL breaks; there is no window in which the file is missing; it works identically for a 2 KB lyric sheet and a 40 GB raw video; and it is fully reversible from the audit log.

Step 7 is optional — the rename is already correct without it, since `ResponseContentDisposition` on the presigned URL overrides stored headers. It runs so that an operator inspecting the bucket directly with the AWS CLI or console sees the current name.

#### 10.4.2 Mode B — Physical Re-key *(explicit, Admin-only, asynchronous)*

Required only when an external process reads the bucket directly and depends on key naming. Executed as a queued job so a multi-gigabyte copy never blocks a request.

```
API                        SQS + WORKER                     AMAZON S3
 │                              │                              │
 │ POST /assets/{id}/rekey      │                              │
 │  { newKey }                  │                              │
 │  · Admin role required       │                              │
 │  · asset.rekeyStatus=QUEUED  │                              │
 │  · enqueue job ─────────────►│                              │
 │◄─ 202 Accepted               │                              │
                                │ 1. HeadObject(source) ──────►│
                                │◄── size, checksum ───────────│
                                │                              │
                                │ 2. size > 5 GB ?             │
                                │    no  → CopyObject ────────►│
                                │    yes → multipart           │
                                │          UploadPartCopy ────►│
                                │◄── new object created ───────│
                                │                              │
                                │ 3. HeadObject(destination) ─►│
                                │◄── verify size + checksum ───│
                                │                              │
                                │ 4. mismatch → delete dest,   │
                                │    fail job, alert Admin,    │
                                │    SOURCE UNTOUCHED          │
                                │                              │
                                │ 5. match → MongoDB txn:      │
                                │    s3.key = newKey           │
                                │    s3.versionId = new        │
                                │                              │
                                │ 6. DeleteObject(source) ────►│
                                │    (old version retained by  │
                                │     bucket versioning)       │
                                │                              │
                                │ 7. activityLog: ASSET_REKEY  │
                                │    rekeyStatus = COMPLETE    │
```

**Safety invariants.** The source object is deleted only after the destination is independently verified by `HeadObject`. If any step fails, the source remains authoritative and MongoDB is never updated — the system fails closed. Bucket versioning means even the final `DeleteObject` is recoverable. The asset is locked (`rekeyStatus = IN_PROGRESS`) for the duration, blocking concurrent renames, downloads, and deletes.

#### 10.4.3 Bulk and Cascading Renames

| Operation | Effect on S3 | Effect on MongoDB |
|---|---|---|
| Rename an **artist** | **None** | `artists.name` updated; every song and asset reflects it immediately |
| Rename a **song** | **None** | `songs.title` updated |
| Rename **one asset** | Metadata refresh only | `displayName` updated |
| Rename **many assets** (pattern) | Metadata refresh, queued | Bulk `updateMany`, one audit entry per asset |
| Move a song to a different artist | **None** | `songs.artistId` reassigned |

This table is the payoff of the UUID key schema (§6.2). Under the v1.0 human-readable hierarchy, renaming one artist would have required copying and deleting every object beneath that prefix — potentially thousands of multi-gigabyte operations. Here it is a single field update.

### 10.5 Availability Check — Mandatory Capability

Answering "is this file actually in S3?" at three levels of scope.

#### 10.5.1 Level 1 — Single Asset, On Demand

```
BROWSER                      EXPRESS API                    AMAZON S3
   │                              │                              │
   │ POST /assets/{id}/verify ───►│                              │
   │                              │ 1. load asset from MongoDB   │
   │                              │ 2. HeadObject(bucket,key) ──►│
   │                              │                              │
   │                              │◄─────────────────────────────│
   │                              │                              │
   │                              │  Response interpretation:    │
   │                              │  ┌────────────────────────┐  │
   │                              │  │ 404 NotFound           │  │
   │                              │  │   → MISSING            │  │
   │                              │  ├────────────────────────┤  │
   │                              │  │ 403 Forbidden          │  │
   │                              │  │   → UNVERIFIED         │  │
   │                              │  │     (IAM issue, alert) │  │
   │                              │  ├────────────────────────┤  │
   │                              │  │ 200 + StorageClass     │  │
   │                              │  │   GLACIER/DEEP_ARCHIVE │  │
   │                              │  │   and no Restore hdr   │  │
   │                              │  │   → ARCHIVED           │  │
   │                              │  ├────────────────────────┤  │
   │                              │  │ 200 + Restore:         │  │
   │                              │  │   ongoing-request="true"│ │
   │                              │  │   → RESTORING          │  │
   │                              │  ├────────────────────────┤  │
   │                              │  │ 200, ContentLength or  │  │
   │                              │  │   ETag ≠ stored value  │  │
   │                              │  │   → MISMATCH           │  │
   │                              │  ├────────────────────────┤  │
   │                              │  │ 200, all values match  │  │
   │                              │  │   → AVAILABLE          │  │
   │                              │  └────────────────────────┘  │
   │                              │                              │
   │                              │ 3. persist availability{}    │
   │                              │ 4. MISSING → alert Admin,    │
   │                              │    CloudWatch metric,        │
   │                              │    activityLog entry         │
   │◄── { status, checkedAt,      │                              │
   │      s3: {size, etag,        │                              │
   │      storageClass,           │                              │
   │      lastModified} } ────────│                              │
```

`HeadObject` is the correct primitive: it returns full object metadata with **no data transfer**, so verification is fast regardless of whether the object is 2 KB or 40 GB.

#### 10.5.2 Level 2 — Search Filtered by Availability

The universal search accepts availability as a first-class facet, making "which files are actually in S3?" a normal query rather than an admin task.

```
GET /api/search?q=dil+se&availability=MISSING
GET /api/search?availability=ARCHIVED&family=Video
GET /api/search?availability=UNVERIFIED&checkedBefore=2026-07-01
```

Results carry the stored `availability` snapshot. Adding `&verify=live` forces a real `HeadObject` for every result in the page (capped at 100) and returns fresh, authoritative status — slower, but definitive.

#### 10.5.3 Level 3 — Bulk Existence Probe

```
POST /api/assets/verify-batch
{ "assetIds": ["1c9de4a7-…", "7b2f1088-…", "8f3a2bc5-…"] }

→ 200
{
  "checkedAt": "2026-07-21T14:22:08Z",
  "summary": { "available": 2, "missing": 1, "archived": 0, "mismatch": 0 },
  "results": [
    { "assetId": "1c9de4a7-…", "status": "AVAILABLE", "sizeBytes": 48210432 },
    { "assetId": "7b2f1088-…", "status": "AVAILABLE", "sizeBytes": 3145728  },
    { "assetId": "8f3a2bc5-…", "status": "MISSING",
      "detail": "NoSuchKey — object not found in harmonyhub-assets-prod" }
  ]
}
```

`HeadObject` calls are issued with a concurrency limit of 20 and a batch ceiling of 500 assets per request.

### 10.6 Search & Discovery

```
BROWSER                              EXPRESS API                    MONGODB
   │                                      │                            │
   │ "Raju Singh reels"                   │                            │
   │ + filters: Video, Punjabi, Viral     │                            │
   │                                      │                            │
   │ GET /api/search?q=…&family=Video ───►│                            │
   │   &language=Punjabi&tags=Viral       │ 1. parse + validate params │
   │   &availability=AVAILABLE&page=1     │ 2. build aggregation:      │
   │                                      │                            │
   │                                      │  $match { $text: {…} }  ──►│
   │                                      │  $match { language, mood } │
   │                                      │  $unwind "$assets"         │
   │                                      │  $match { assets.type,     │
   │                                      │           assets.tags,     │
   │                                      │           assets.family,   │
   │                                      │    assets.availability     │
   │                                      │      .status }             │
   │                                      │  $sort  { score, date }    │
   │                                      │  $facet { results, counts }│
   │                                      │◄───────────────────────────│
   │                                      │                            │
   │                                      │ 3. presign a preview URL   │
   │                                      │    per result (batch)      │
   │◄── { results[], facets{}, total } ───│                            │
   │                                      │                            │
   │ 4. virtualised media-card grid       │                            │
   │    each card: type badge, version    │                            │
   │    chip, availability badge          │                            │
```

The `$unwind` + `$match` stage is what delivers **asset-granular results** — a query for "9:16 reels tagged Viral" returns individual assets carrying their parent song context, rather than whole song documents. This was an unresolved gap in v1.0.

**Facets returned:** asset type, family, language, mood, release year, tags, version label, availability status — each with a live count.

### 10.7 Metadata Update

A straightforward `PATCH /api/assets/{id}`, touching MongoDB only. Editable fields: `displayName`, `description`, `type`, `tags[]`, `version`. Immutable fields (`s3.*`, `assetId`, `originalName`, `createdAt`) are stripped by the Zod schema before the update reaches the service layer. Every change writes a `before`/`after` pair to `activityLog`.

Changing `type` may change the asset's storage tier; if so, a lifecycle transition is queued rather than applied inline.

### 10.8 Delete

Three levels, deliberately separated so that no single action is unrecoverable.

| Level | Trigger | MongoDB | S3 |
|---|---|---|---|
| **Soft delete** | Editor removes an asset | `deletedAt` set; hidden from all queries | Untouched |
| **Restore** | Admin undoes within 30 days | `deletedAt` cleared | Untouched |
| **Hard delete** | Admin purge, or 30-day sweep | Sub-document removed | `DeleteObject` → delete marker |
| **Permanent purge** | Admin, with typed confirmation | Removed | `DeleteObject` with `VersionId` on every version |

Only the final level destroys data, and it requires an Admin to type the asset's display name to confirm. Bulk deletes are queued through SQS and processed with `DeleteObjects` in batches of 1,000.

### 10.9 Archive & Restore

```
Asset in Glacier
   │
   │ user clicks "Request restore"
   ▼
POST /api/assets/{id}/restore  { tier: "Standard" | "Expedited" | "Bulk" }
   │
   ├─ create restoreRequests document, status = REQUESTED
   ├─ S3 RestoreObject { Days: 7, GlacierJobParameters: { Tier } }
   ├─ asset.availability.status = RESTORING
   └─ 202 Accepted, with expected availability window
        │
        │  restore.worker polls every 5 minutes
        ▼
   HeadObject → Restore: ongoing-request="false", expiry-date="..."
        │
        ├─ availability.status = AVAILABLE
        ├─ restoreRequests.status = COMPLETE, availableUntil set
        └─ in-app notification to the requester
```

Retrieval tiers and typical times: Expedited 1–5 minutes, Standard 3–5 hours, Bulk 5–12 hours. The dialog states the expected wait for each tier before the user confirms.

### 10.10 External Sharing

```
Marketing user
   │ POST /api/shares { assetId, expiresIn: "7d", canDownload: true, maxDownloads: 10 }
   ▼
shares document created — 32-byte cryptographically random token
   │
   │ https://hub.company.com/s/{token}   →   sent to the partner
   ▼
Partner opens the link
   │ GET /api/shares/{token}     (no authentication required)
   ▼
Validation gate:
   ├─ token exists?            no → 404
   ├─ revokedAt is null?       no → 410 Gone
   ├─ expiresAt in future?     no → 410 Gone
   ├─ downloadCount < max?     no → 429 Too Many Requests
   └─ HeadObject confirms the file is present?   no → 503, Admin alerted
   ▼
Presigned GET issued — TTL = min(remaining share lifetime, 1 hour)
   ├─ downloadCount incremented atomically
   └─ activityLog: SHARE_ACCESS { token, ip, userAgent, timestamp }
   ▼
Partner downloads directly from S3
```

Capabilities beyond a plain link: hard expiry, download caps, instant revocation, per-link download-versus-preview permission, and a complete access trail including IP address. The `HeadObject` check in the validation gate means a partner never receives a URL to a file that has gone missing.

### 10.11 Nightly Reconciliation — S3 ↔ Database Drift

The authoritative answer to "does our database still match the bucket?", run every night at 02:00 IST by the reconciliation worker.

```
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 1 — Build the S3 inventory                                 │
│   ListObjectsV2 paginated over prefix "assets/", 1000 per page   │
│   Collect: key → { size, etag, storageClass, lastModified }      │
│   Streamed into a temporary collection to bound memory           │
├──────────────────────────────────────────────────────────────────┤
│ PHASE 2 — Build the database inventory                           │
│   Aggregate every non-deleted asset across all songs             │
│   Collect: s3.key → { assetId, sizeBytes, etag, songId }         │
├──────────────────────────────────────────────────────────────────┤
│ PHASE 3 — Compare                                                │
│                                                                  │
│   in DB, not in S3     → MISSING_IN_S3       🔴 critical         │
│   in S3, not in DB     → UNTRACKED_IN_S3     🟠 orphan file      │
│   in both, size differs→ SIZE_MISMATCH       🟠 integrity        │
│   in both, ETag differs→ ETAG_MISMATCH       🟠 integrity        │
│   storageClass changed → CLASS_DRIFT         🔵 informational    │
│   in both, all match   → OK                  🟢                  │
├──────────────────────────────────────────────────────────────────┤
│ PHASE 4 — Act                                                    │
│   · Write a reconciliationRuns document with full findings       │
│   · Update every asset's availability{} block                    │
│   · Emit CloudWatch metrics: MissingInS3, UntrackedInS3,         │
│     Mismatched, ObjectsScanned                                   │
│   · CloudWatch alarm if MissingInS3 > 0 → notify Admin           │
│   · Surface everything on the Admin → Storage Health dashboard   │
└──────────────────────────────────────────────────────────────────┘
```

**Remediation actions available to an Admin from the dashboard:**

| Finding | Available actions |
|---|---|
| `MISSING_IN_S3` | Recover from a previous S3 version · re-upload · mark the asset permanently lost |
| `UNTRACKED_IN_S3` | Adopt into the catalogue (create an asset record) · move to a quarantine prefix · delete |
| `SIZE_MISMATCH` / `ETAG_MISMATCH` | Accept S3 as truth and update MongoDB · investigate · restore a prior version |
| `CLASS_DRIFT` | Accept (expected after a lifecycle transition) |

For very large buckets, **S3 Inventory** can replace Phase 1 — it delivers a daily CSV or Parquet manifest of the entire bucket to a designated prefix, removing the need to paginate `ListObjectsV2` at all. This is a configuration change to the worker, not a redesign.

---

## 11. API Contract

REST over HTTPS. All routes require a valid JWT except `/api/auth/*`, `/api/shares/{token}`, and `/healthz`. Responses are `application/json`. **No endpoint ever returns or accepts file bytes.**

### 11.1 Endpoints

| Method | Route | Role | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/login` | — | Email + password → access and refresh tokens |
| `POST` | `/api/auth/refresh` | — | Rotate access token |
| `POST` | `/api/auth/logout` | any | Invalidate refresh token |
| `GET` | `/api/me` | any | Current user, role, effective permissions |
| `GET` | `/api/artists` | any | List, paginate, filter |
| `POST` | `/api/artists` | Editor+ | Create |
| `GET` | `/api/artists/{id}` | any | Profile, discography, gallery |
| `PATCH` | `/api/artists/{id}` | Editor+ | Update — **includes rename; no S3 impact** |
| `DELETE` | `/api/artists/{id}` | Admin | Soft delete |
| `GET` | `/api/songs` | any | List, paginate, filter |
| `POST` | `/api/songs` | Editor+ | Create |
| `GET` | `/api/songs/{id}` | any | Song plus all embedded assets |
| `PATCH` | `/api/songs/{id}` | Editor+ | Update — **includes rename; no S3 impact** |
| `DELETE` | `/api/songs/{id}` | Admin | Soft delete |
| `POST` | `/api/uploads/initiate` | Editor+ | Validate, dedup-check, create MPU, return presigned parts |
| `POST` | `/api/uploads/complete` | Editor+ | Complete MPU, verify via HeadObject, create asset |
| `POST` | `/api/uploads/abort` | Editor+ | Abort MPU and clean up |
| `GET` | `/api/assets/{id}` | any | Asset detail with S3 binding and availability |
| `PATCH` | `/api/assets/{id}` | Editor+ | Update metadata and tags |
| **`PATCH`** | **`/api/assets/{id}/rename`** | **Editor+** | **Logical rename — §10.4.1** |
| **`POST`** | **`/api/assets/{id}/rekey`** | **Admin** | **Physical re-key, queued — §10.4.2** |
| **`POST`** | **`/api/assets/{id}/verify`** | **any** | **Live HeadObject availability check — §10.5.1** |
| **`POST`** | **`/api/assets/verify-batch`** | **any** | **Bulk existence probe, ≤500 — §10.5.3** |
| `POST` | `/api/assets/{id}/download` | role-gated | Presigned GET, 5-min TTL, audited |
| `POST` | `/api/assets/{id}/preview` | any | Presigned GET inline, 1-hour TTL |
| `POST` | `/api/assets/{id}/restore` | Editor+ | Request Glacier restore |
| `GET` | `/api/assets/{id}/versions` | any | Semantic version lineage |
| `GET` | `/api/assets/{id}/s3-versions` | Admin | S3 object version history |
| `DELETE` | `/api/assets/{id}` | Editor+ | Soft delete |
| `DELETE` | `/api/assets/{id}/purge` | Admin | Permanent — all S3 versions destroyed |
| `GET` | `/api/search` | any | Universal search with facets, incl. `availability` |
| `GET` | `/api/search/facets` | any | Facet values and counts for the current query |
| `GET` | `/api/tags` | any | Controlled and custom tag list |
| `POST` | `/api/tags` | Editor+ | Create a custom tag |
| `PATCH` | `/api/tags/{id}/promote` | Admin | Promote a custom tag to controlled |
| `POST` | `/api/shares` | Marketing+ | Create a share link |
| `GET` | `/api/shares` | Marketing+ | List active shares |
| `GET` | `/api/shares/{token}` | public | Resolve a share to a presigned URL |
| `DELETE` | `/api/shares/{id}` | Marketing+ | Revoke immediately |
| `GET` | `/api/activity` | Admin | Audit log, filterable |
| **`GET`** | **`/api/admin/storage/health`** | **Admin** | **Drift summary — §10.11** |
| **`POST`** | **`/api/admin/storage/reconcile`** | **Admin** | **Trigger reconciliation on demand** |
| **`GET`** | **`/api/admin/storage/runs`** | **Admin** | **Reconciliation run history and reports** |
| `GET` | `/api/admin/users` | Admin | User management |
| `GET` | `/healthz` | — | ALB health check |

### 11.2 Conventions

- **Pagination** — `?page=1&limit=24`; responses carry `{ data, page, limit, total, hasMore }`.
- **Errors** — RFC 7807 `application/problem+json`: `{ type, title, status, detail, instance }`.
- **Idempotency** — `Idempotency-Key` header honoured on every creating `POST`.
- **Rate limits** — 100 req/min per user; 10 req/min on `/download`, `/rekey`, `/purge`, `/restore`.
- **Soft deletes** — `deletedAt` throughout; S3 objects retained until an explicit purge.
- **Optimistic concurrency** — `If-Match` with the document `__v` on all `PATCH` routes, preventing two editors from silently overwriting each other's rename.

---

## 12. Security Model

### 12.1 Authentication

Email and password, hashed with bcrypt at cost factor 12. Login issues a 15-minute access token and a 7-day refresh token; refresh tokens are rotated on use and stored hashed, so a stolen refresh token is single-use. The JWT signing secret lives in AWS Secrets Manager and is rotated quarterly. Tokens carry `sub`, `role`, and `iat`/`exp` only — never permissions, which are resolved server-side on every request.

### 12.2 Authorisation

| Role | Permissions |
|---|---|
| **Admin** | Everything: user management, purge, re-key, reconciliation, audit log |
| **Editor** | Upload, edit metadata, rename, tag, soft-delete, request restore |
| **Viewer** | Search, preview, download (rate-limited); no mutation |
| **Marketing** | Viewer permissions plus create and revoke external share links |

Enforcement is layered: the `authorize()` middleware gates every route; the service layer re-checks ownership and asset-type rules; and the Fargate task IAM role is scoped to the `assets/` prefix of exactly one bucket, so even a fully compromised API process cannot reach backups or logs.

### 12.3 S3 Security

- Block Public Access is enabled at the **account** level and on every bucket.
- No bucket policy contains `"Principal": "*"`.
- The task role permits only `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:AbortMultipartUpload`, and `s3:RestoreObject`, scoped by prefix.
- A bucket policy denies any request where `aws:SecureTransport` is false.
- Presigned URLs are short-lived by role: 5 minutes for original downloads, 1 hour for previews, 60 minutes for upload parts.
- Server-side encryption is SSE-S3 (AES-256) by default, upgradeable to SSE-KMS with a customer-managed key.
- S3 server access logging is enabled and delivered to `harmonyhub-logs-{env}`.

### 12.4 Network

Fargate tasks and MongoDB nodes sit in private subnets with no public IP. Only the ALB is internet-facing. An **S3 gateway VPC endpoint** keeps all S3 traffic on the AWS network rather than traversing a NAT gateway. Security groups permit only ALB→task on port 8080 and task→MongoDB on port 27017.

### 12.5 Audit

Three independent trails: `activityLog` in MongoDB for business events (who renamed, downloaded, shared, deleted what, with before/after state and IP); S3 server access logs for every object-level request; and AWS CloudTrail for every AWS control-plane call. Together these answer any question about who did what to which file, and when.

---

## 13. Deployment & Operations

### 13.1 Environments

| Environment | API | MongoDB | S3 buckets |
|---|---|---|---|
| `dev` | 1 Fargate task | Single EC2 `t3.medium` | `harmonyhub-*-dev` |
| `staging` | 2 Fargate tasks | Single EC2 `t3.medium` | `harmonyhub-*-staging` |
| `prod` | 2–6 Fargate tasks, auto-scaled | 3-node replica set, `m6i.large`, 3 AZs | `harmonyhub-*-prod` |

### 13.2 Infrastructure as Code

The entire stack is defined in **AWS CDK (TypeScript)** — same language as the application, with typed constructs for VPC, ECS, ALB, S3, IAM, SQS, and CloudWatch. No resource is created by hand in the console. Every resource is tagged `Project=HarmonyHub`, `Env=`, `Owner=`.

### 13.3 CI/CD

Build → test → container image → ECR → ECS rolling deployment, with automatic rollback on failed ALB health checks. Database migrations run as a one-off ECS task before the service update.

### 13.4 Monitoring

| Metric | Alarm threshold |
|---|---|
| API 5xx rate | > 1% over 5 minutes |
| API p99 latency | > 2 s over 5 minutes |
| Upload failure rate | > 5% over 15 minutes |
| **`MissingInS3`** | **> 0 — immediate Admin notification** |
| **`Mismatched`** | **> 0 — daily digest** |
| SQS DLQ depth | > 0 |
| MongoDB replica lag | > 10 s |
| MongoDB disk usage | > 80% |
| Fargate CPU / memory | > 80% sustained |

A CloudWatch dashboard presents upload throughput, search latency, storage growth by asset family, and the current drift summary on one screen.

### 13.5 Backup & Recovery

| Asset | Mechanism | Retention | RPO / RTO |
|---|---|---|---|
| S3 objects | Versioning + optional Cross-Region Replication | 180 days for noncurrent versions | ~0 / minutes |
| MongoDB | Hourly `mongodump` → `harmonyhub-backups`, plus daily EBS snapshots | 30 days | 1 h / 2 h |
| Configuration | CDK source in Git | Indefinite | — / 1 h |

A restore drill is performed quarterly against the staging environment.

---

## 14. Development Roadmap — 16 Weeks

| Phase | Focus | Key deliverables | Duration |
|---|---|---|---|
| **0** | **Infrastructure** | CDK project, VPC, S3 buckets and policies, ECS cluster, ALB, ACM, MongoDB replica set, CI/CD | 2 weeks |
| **1** | **Foundation** | Express skeleton, JWT auth, RBAC middleware, Mongoose schemas, `StorageService` with full S3 surface, `/healthz` | 3 weeks |
| **2** | **Upload & Retrieve** | Presigned multipart upload, resumable frontend uploader, dedup by checksum, presigned download and preview, Range streaming | 3 weeks |
| **3** | **Core Modules** | Artist, song, and asset CRUD; React UI shell; media-card grid; asset detail panel; version lineage | 3 weeks |
| **4** | **Rename & Availability** | Logical rename, physical re-key worker, `HeadObject` verification, batch probe, nightly reconciliation, Storage Health dashboard | 2 weeks |
| **5** | **Search & Tags** | `$text` index, faceted aggregation, asset-granular results, controlled and custom tags, search-first home | 2 weeks |
| **6** | **Collaboration & Launch** | Share tokens with expiry and caps, activity log viewer, admin screens, load testing, data migration, production cutover | 1 week |

### 14.1 Milestones

- **M0** — Infrastructure deployed from CDK; empty application answers `/healthz` over HTTPS.
- **M1** — A file uploads from the browser directly into S3 with metadata persisted to MongoDB.
- **M2** — That file downloads back under its display name and streams with working seek.
- **M3** — Full CRUD across artists, songs, and assets in the React UI.
- **M4** — **Rename works instantly; availability verification and drift reporting are live.**
- **M5** — Universal search returns asset-granular results with facets.
- **M6** — Sharing, audit, and admin tooling complete; production cutover done.

---

## 15. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **S3 has no rename** | Naïve copy+delete risks data loss on large files | UUID-immutable keys make rename a metadata update (§10.4.1); physical re-key is verify-before-delete and fully reversible via versioning (§10.4.2) |
| **DB and bucket drift apart** | Broken links, phantom assets | `HeadObject` before every download and share resolution; nightly full reconciliation; CloudWatch alarm on `MissingInS3 > 0` (§10.11) |
| **Presigned URL leakage** | Unauthorised access to an original | 5-minute TTL on originals, single-object scope, every issuance logged with actor and IP, instant share revocation |
| **Large upload failure** | Editor frustration, wasted hours | S3 multipart with per-part retry, pause, and resume; incomplete-MPU lifecycle cleanup |
| **Self-managed MongoDB operations** | Patching, backup, and failover are ours | 3-node replica set across 3 AZs, automated snapshots, hourly `mongodump` to S3, quarterly restore drills; DocumentDB documented as a fallback |
| **No CDN** | Higher latency for geographically distant users | Accepted per project constraint; S3 Transfer Acceleration remains available as an S3-native option if latency becomes a complaint |
| **Egress cost on bulk download** | Large bills on mass retrieval | Accepted — cost is explicitly not a constraint; downloads remain audited so spend is at least attributable |
| **Accidental permanent deletion** | Irrecoverable data loss | Four-level delete ladder (§10.8), typed confirmation for purge, bucket versioning, delete markers rather than destruction |
| **Inconsistent manual tags** | Degraded search quality | Controlled vocabulary, required tag step at upload, Admin promotion queue for custom tags |
| **Concurrent rename conflict** | Silent overwrite between editors | Optimistic concurrency via `If-Match` on document version; asset locked during re-key |

---

## 16. Open Decisions

| # | Decision | Why it matters | Owner |
|---|---|---|---|
| 1 | **Self-managed MongoDB on EC2 vs Amazon DocumentDB** | DocumentDB is managed but lacks `$text` indexes, forcing an OpenSearch dependency. Recommendation: EC2 replica set | Architecture |
| 2 | **Is physical re-key (§10.4.2) actually required?** | If no external process reads the bucket directly, Mode B can be dropped entirely, removing a whole worker | Content + Ops |
| 3 | **Reconciliation frequency and scope** | Nightly full scan vs S3 Inventory manifest — depends on final object count | Architecture |
| 4 | **Glacier archiving for BTS raw footage** | Determines whether the `ARCHIVED`/`RESTORING` states are ever exercised in production | Content team |
| 5 | **Cross-Region Replication for the assets bucket** | Disaster-recovery posture; cost is not a constraint, so this is a policy call | Project owner |

---

> **Final vision.** Harmony Hub becomes the centralised digital music asset ecosystem where the company manages every song, artist media item, promotional file, and release asset from one intelligent dashboard — built entirely on AWS, with Amazon S3 as the single durable home for every byte, and a platform that always knows exactly what it has stored, what each file is called, and whether it is truly there.

---

*Harmony Hub · Project Planning & Technical Specification · Version 3.0 (AWS-Only) · Confidential — Internal Use*
