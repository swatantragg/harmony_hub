# Harmony Hub — AWS Architecture & Technical Specification

**Version** 2.0 · **Supersedes** v1.0 (Google Drive edition) · **Stack** MERN + AWS · **Status** Draft for Review · **Date** July 2026

> **Change note.** v1.0 specified Google Drive as the storage layer. Drive access is unavailable; AWS is mandated. This document re-architects the entire storage, delivery, processing, and security model on AWS while preserving the product intent, data model philosophy, asset catalogue, tagging system, and role model of v1.0.

---

## Contents

| | | | |
|---|---|---|---|
| 1. Executive Summary | 5. Storage Architecture | 9. Data Model | 13. Cost Model & Governance |
| 2. Why the Re-architecture | 6. Media Processing Pipeline | 10. API Contract | 14. Security & Compliance |
| 3. Design Decisions | 7. Upload Flow | 11. Search & Tagging | 15. Development Roadmap |
| 4. System Architecture | 8. Delivery & Sharing Flow | 12. Functional Modules | 16. Risks & Mitigations |

---

## 1. Executive Summary

Music companies produce a large volume of digital assets for every release — master audio, demos, cover art, music videos, social reels, posters, lyrics, contracts, and metadata. In most teams these files are scattered across personal drives, chat threads, and email. The result is duplicate uploads, lost files, slow retrieval, version confusion, and friction whenever teams or partners collaborate.

**Harmony Hub solves this.** It is an internal web platform that acts as an intelligent management and search layer over Amazon S3. S3 handles durable object storage; CloudFront handles global streaming, preview, and download delivery; MongoDB holds all searchable metadata and the S3 object keys that link the two; a serverless media pipeline generates the lightweight proxies that make browsing cheap.

The outcome is a single source of truth for all music assets: faster retrieval, cleaner organisation, predictable storage cost, and smoother collaboration across A&R, marketing, production, and partner teams.

### 1.1 Problem Statement

- Assets are fragmented across many locations with no single index.
- The same file is uploaded multiple times, wasting storage and creating ambiguity.
- Finding a specific asset (e.g. the final master of a song, or a Punjabi promo reel) takes too long.
- There is no reliable version control, so teams accidentally use outdated files.
- Sharing with external partners is manual, insecure, and untracked.

### 1.2 Proposed Solution

A web application (the management layer) connected to Amazon S3 (the storage layer) through the AWS SDK, with Amazon CloudFront as the delivery layer. Every file uploaded through the platform is written directly from the browser into a structured S3 key hierarchy; its object key plus rich metadata are stored in MongoDB, which powers fast search, manual tagging, and access control. All read traffic is served through CloudFront, never through the application server.

### 1.3 The Governing Constraint

A previous bulk download of ~800 songs from S3 incurred approximately ₹20,000 in charges. Diagnosis: roughly 2.1 TB of original-quality media pulled directly out of S3 to the internet at the standard ap-south-1 egress rate (~₹9/GB). This was an architecture failure, not an AWS pricing problem.

**Three rules follow, and they are non-negotiable throughout this design:**

1. **Original media is never the browse path.** Every asset gets a lightweight derivative (thumbnail, 480p proxy, 128 kbps audio preview). Browsing 800 songs must move ~160 MB, not 2 TB.
2. **All delivery goes through CloudFront.** S3-to-CloudFront origin transfer is waived by AWS, and CloudFront pay-as-you-go carries a perpetual 1 TB/month free egress allowance. Direct S3 presigned download URLs are prohibited in the read path.
3. **File bytes never pass through the application server.** Uploads go browser→S3 directly; downloads go CloudFront→browser directly. The API moves only JSON.

Section 13 models the resulting cost at roughly **₹2,300/month** for the same 2.2 TB library.

---

## 2. Why the Re-architecture

### 2.1 Capability Mapping — Drive to AWS

The v1.0 design leaned on Google Drive for six capabilities. Each maps to a specific AWS service, and in every case the AWS equivalent gives more control.

| v1.0 (Google Drive) | v2.0 (AWS) | Gain |
|---|---|---|
| File storage & cloud backup | **Amazon S3** (+ Versioning, Cross-Region Replication) | 11 nines durability, per-object lifecycle policy, storage classes |
| Video streaming & image preview | **CloudFront** + generated HLS/proxy derivatives | Real adaptive streaming; CDN edge caching; 1 TB/mo free egress |
| Download handling | **CloudFront signed URLs** | Per-link expiry, IP/referrer restriction, full access logs |
| Native sharing infrastructure | **`shares` collection + CloudFront signed URLs/cookies** | Expiry, download caps, revocation, audit trail we own |
| Large-file reliability | **S3 Multipart Upload** (browser-direct, resumable) | Parallel parts, retry per part, no server memory pressure |
| Storage scalability | **S3 + Intelligent-Tiering + Glacier Deep Archive** | Cost falls automatically as assets go cold |
| *(not available in Drive)* | **MediaConvert / Lambda proxy pipeline** | The cost-control layer that Drive's built-in preview used to provide free |

### 2.2 What Carries Over Unchanged

- The product vision, objectives, and scope.
- The document-oriented data model: one song document embedding an `assets[]` array.
- The complete asset type catalogue (four families, 21 types).
- The manual tagging system — controlled vocabulary plus custom tags.
- The four-role permission model: Admin, Editor, Viewer, Marketing.
- The React + Tailwind, search-first UI concept.

---

## 3. Design Decisions

Five decisions shape v2.0.

### 3.1 Storage — Amazon S3 with a three-tier lifecycle

Not all assets are equal. A 3 MB cover image is browsed daily; a 5 GB unedited BTS reel is opened twice a year. A single storage class would either overpay for the cold data or make the hot data slow. Objects are therefore placed into one of three tiers at upload time, based on their asset `type`, and lifecycle rules move them further down over time.

### 3.2 Delivery — CloudFront is mandatory, not optional

CloudFront is the only public entry point to media. The S3 buckets have Block Public Access fully enabled and are reachable only via Origin Access Control. This is simultaneously the security boundary and the cost boundary — a design where a developer *can* hand out an S3 URL is a design where someone eventually will.

### 3.3 Derivatives — generate once, serve forever

Every uploaded asset triggers a pipeline that produces small derivatives. The UI is contractually forbidden from referencing an original in a grid, list, card, or preview. Originals are reachable only through an explicit, role-checked, logged "Download original" action.

### 3.4 Database — MongoDB Atlas on AWS

The v1.0 data model depends on MongoDB text indexes and Mongoose. Amazon DocumentDB, despite MongoDB API compatibility, **does not support `$text` indexes**, which would force an immediate rewrite of the search layer. MongoDB Atlas deployed into AWS — subscribed through AWS Marketplace, running in an AWS region, connected over AWS PrivateLink — keeps the data layer intact while remaining inside the AWS account and billing relationship.

*This is the one decision requiring stakeholder sign-off.* If procurement requires first-party AWS services only, the fallback is Amazon DocumentDB for documents plus Amazon OpenSearch Service for search — costed and compared in §3.4.1.

#### 3.4.1 Database Options Compared

| Option | Text search | Monthly (dev→prod) | Rewrite cost | Verdict |
|---|---|---|---|---|
| **Atlas on AWS (Marketplace)** | Native `$text`, Atlas Search upgrade path | M0 free → M10 ~$57 | None | **Recommended** |
| DocumentDB + OpenSearch | Requires OpenSearch + sync layer | ~$57 + ~$26 = ~$83 | High — dual-write, index sync, eventual consistency | Fallback only |
| Self-managed Mongo on EC2 | Native | ~$15 (t4g.small) | None | Rejected — backups, patching, HA are our problem |

### 3.5 Tagging — Manual, by people

Unchanged from v1.0. Editors apply tags from a controlled list plus optional custom tags. Accuracy over automation; no ML pipeline in v1. Rationale in §11.

---

## 4. System Architecture

Harmony Hub uses a three-tier application architecture with media storage and delivery fully offloaded to AWS managed services. The application servers stay lightweight and stateless; S3 provides durable storage; CloudFront provides streaming and download; MongoDB holds all searchable metadata and the S3 keys that link the two.

```
┌──────────────────────────────────────────────────────────────────────┐
│  USERS                                                               │
│  Admin  ·  Editor  ·  Viewer  ·  Marketing  ·  External Partner      │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │ HTTPS
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│  EDGE / DELIVERY LAYER                                               │
│  Amazon CloudFront   ·   AWS WAF   ·   ACM (TLS)   ·   Route 53      │
│                                                                      │
│   /            → S3 (React SPA static build)                         │
│   /api/*       → ALB → ECS Fargate  (JSON only, no media bytes)      │
│   /media/*     → S3 proxies bucket  (signed URL, cached at edge)     │
│   /original/*  → S3 masters bucket  (signed URL, short TTL, logged)  │
└──────┬────────────────────────────┬──────────────────────┬───────────┘
       │                            │                      │
       ▼                            ▼                      ▼
┌──────────────────┐   ┌────────────────────────┐   ┌──────────────────┐
│ PRESENTATION     │   │ APPLICATION LAYER      │   │ STORAGE LAYER    │
│ React + Tailwind │   │ ECS Fargate            │   │ Amazon S3        │
│ static build     │   │ Node.js + Express      │   │ ├ masters        │
│ served from S3   │   │ ├ Cognito JWT verify   │   │ ├ proxies        │
│ via CloudFront   │   │ ├ RBAC middleware      │   │ └ uploads-stage  │
│                  │   │ ├ search query builder │   │                  │
│                  │   │ ├ presign issuer       │   │ Block Public     │
│                  │   │ └ share token service  │   │ Access: ON       │
└──────────────────┘   └───────┬────────────────┘   │ Access via OAC   │
                               │                    └────────┬─────────┘
              ┌────────────────┼──────────────────┐          │
              ▼                ▼                  ▼          │ s3:ObjectCreated
   ┌──────────────────┐ ┌─────────────┐ ┌──────────────┐     ▼
   │ DATA LAYER       │ │ IDENTITY    │ │ SECRETS      │  ┌─────────────────┐
   │ MongoDB Atlas    │ │ Cognito     │ │ Secrets Mgr  │  │ EventBridge     │
   │ on AWS           │ │ User Pool   │ │ + SSM Param  │  └────────┬────────┘
   │ (PrivateLink)    │ │ 4 groups    │ │ Store        │           ▼
   │                  │ └─────────────┘ └──────────────┘  ┌─────────────────┐
   │ users · artists  │                                   │ SQS + DLQ       │
   │ songs · tags     │◄──────────── writes derivative ───┤                 │
   │ shares · logs    │              paths back           └────────┬────────┘
   └──────────────────┘                                            ▼
                                                    ┌──────────────────────────┐
                                                    │ MEDIA PROCESSING         │
                                                    │ Lambda (Sharp / ffmpeg)  │
                                                    │   → images, short clips  │
                                                    │ MediaConvert             │
                                                    │   → long-form video, HLS │
                                                    └──────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  OBSERVABILITY & GOVERNANCE                                          │
│  CloudWatch (logs/metrics/alarms) · AWS Budgets · Cost Anomaly       │
│  Detection · CloudTrail · S3 + CloudFront access logs                │
└──────────────────────────────────────────────────────────────────────┘

    The link between the two halves:  MongoDB stores the S3 object key
    (and its derivative keys) for each asset → metadata is searchable,
    bytes stay in S3, and delivery never touches the application server.
```

### 4.1 Responsibility Split

| AWS Platform (storage + delivery) | Harmony Hub (management) |
|---|---|
| Durable object storage & versioning (S3) | Content & metadata management |
| Global streaming, preview, edge caching (CloudFront) | Universal search & discovery |
| Download handling & signed access (CloudFront) | Manual tagging (controlled + custom) |
| Identity, MFA, token issuance (Cognito) | Roles, permissions & access control |
| Transcoding & thumbnailing (MediaConvert, Lambda) | Key-prefix organisation & version lineage |
| Storage tiering & cost decay (Lifecycle, Glacier) | Artist / song / release management, analytics |
| Durability, replication, backup | Sharing policy, expiry, revocation, audit |

### 4.2 Why This Split Matters

- Application servers stay **stateless** — any task can serve any request; horizontal scaling is trivial.
- **No media bytes traverse the application tier**, so API compute stays small and cheap regardless of library size.
- MongoDB never stores blobs, so the database stays small, fast, and cheap to back up.
- Storage cost decays automatically as assets age, without any application change.
- Swapping the storage layer later requires changing one adapter module, not the application (§14.6).

---

## 5. Storage Architecture

### 5.1 Bucket Layout

Three buckets, separated by lifecycle and blast radius rather than by content.

| Bucket | Purpose | Versioning | Public | Lifecycle |
|---|---|---|---|---|
| `harmonyhub-masters-{env}` | Original uploaded assets — the irreplaceable copy | **ON** | No (OAC only) | Tiered, see §5.3 |
| `harmonyhub-proxies-{env}` | Generated thumbnails, previews, HLS, waveforms, poster frames | Off | No (OAC only) | Standard; regenerable |
| `harmonyhub-uploads-{env}` | Transient landing zone for browser multipart uploads | Off | No | Auto-delete incomplete MPU after 1 day; objects after 7 days |
| `harmonyhub-web-{env}` | React SPA static build | Off | No (OAC only) | — |
| `harmonyhub-logs-{env}` | S3 + CloudFront + ALB access logs | Off | No | Glacier at 90 days, expire at 365 |

Derivatives live in a separate bucket because they are **regenerable**. If a proxy is lost, the pipeline rebuilds it; if a master is lost, the asset is gone. Different value, different protection, different lifecycle.

### 5.2 Key Schema

The v1.0 Drive folder hierarchy becomes an S3 key prefix. S3 has no real folders, but a disciplined key schema gives the same predictability plus prefix-scoped IAM policies and lifecycle rules.

```
masters/{artistSlug}/{songSlug}/{family}/{type}/{version}/{assetId}_{filename}

masters/raju-singh/dil-se/audio/master-audio/final/8f3a2b_dilse_master.wav
masters/raju-singh/dil-se/video/reel-bts-mv/v2/1c9de4_dilse_bts_reel.mp4
masters/raju-singh/dil-se/cover-graphic/song-cover/final/7b2f10_dilse_cover_3000.jpg
masters/raju-singh/dil-se/text-doc/lyrics/v1/44ac81_dilse_lyrics.pdf
```

Derivatives mirror the master key, rooted at `proxies/`:

```
proxies/raju-singh/dil-se/video/reel-bts-mv/v2/1c9de4/thumb_640.webp
proxies/raju-singh/dil-se/video/reel-bts-mv/v2/1c9de4/preview_480p.mp4
proxies/raju-singh/dil-se/video/reel-bts-mv/v2/1c9de4/hls/index.m3u8
proxies/raju-singh/dil-se/audio/master-audio/final/8f3a2b/preview_128k.mp3
proxies/raju-singh/dil-se/audio/master-audio/final/8f3a2b/waveform.json
```

**Rules.** Slugs are immutable once created — renaming an artist updates the display name in MongoDB, never the S3 key. The `assetId` (UUID) prefix on the filename guarantees uniqueness and prevents collisions when two editors upload the same filename. The original filename is preserved for human readability and restored on download via `Content-Disposition`.

### 5.3 Storage Tiering

Tier is assigned at upload from the asset `type`, then decays on a schedule.

| Tier | Asset types | Class at upload | Lifecycle transition | ~Cost/GB/mo |
|---|---|---|---|---|
| **Hot** | Song Cover, Banner Image, Post on Artist Page, Audio Snippet, Song Snippet, Lyrics, all derivatives | S3 Standard | none | ~$0.025 |
| **Warm** | Master Audio, Horizontal Video, Reels, Lyrics Video Reel, Square Covers, Artist/Investor Reel, Banner+Video | S3 Intelligent-Tiering | automatic (no retrieval fee) | $0.025 → $0.0138 |
| **Cold** | BTS — Unedited Footage, Event Video, Review Video, BTS of Song | S3 Standard → Glacier Flexible @ 30d → Deep Archive @ 180d | scheduled | ~$0.0036 → ~$0.002 |

**Intelligent-Tiering is the default for anything uncertain.** It carries a small monitoring fee per object but no retrieval charge, which removes the single most dangerous failure mode: an editor triggering a surprise bill by opening an archived file.

**Cold-tier assets are not directly downloadable.** The UI shows an "Archived — request restore" state. Restoring writes a `restoreRequests` record, calls `RestoreObject`, notifies the requester on completion, and — critically — shows the estimated retrieval cost before confirming. Deep Archive restore takes up to 12 hours (bulk) or 48 hours (standard).

### 5.4 Versioning Strategy

Two independent mechanisms, deliberately:

- **S3 Object Versioning** on the masters bucket is a *safety net*. It protects against accidental overwrite and deletion. Users never see it. A noncurrent-version lifecycle rule expires old versions after 90 days.
- **Semantic version labels** in MongoDB (`V1`, `V2`, `Final`, `Final Master`) are the *product feature* from v1.0 §7.10. Each labelled version is a distinct S3 object with its own key, so lineage is explicit and any version can be fetched directly.

### 5.5 Deduplication

Every upload computes a SHA-256 checksum client-side (and S3 verifies it via `ChecksumSHA256`). Before issuing a presigned URL, the API checks the checksum against existing assets. On a match, the editor is shown the existing asset and offered "link to this song instead of re-uploading". This directly addresses the v1.0 problem statement item *"the same file is uploaded multiple times"*.

---

## 6. Media Processing Pipeline

This pipeline is what makes the cost model work. It is not a nice-to-have.

```
S3 masters bucket
   │ s3:ObjectCreated:*
   ▼
EventBridge rule  ──►  SQS queue (visibility 15m)  ──►  DLQ after 3 attempts
                              │
                              ▼
                    Lambda — dispatcher
                    inspects family + size + duration
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  IMAGE                  SHORT MEDIA           LONG-FORM VIDEO
  Lambda + Sharp         Lambda + ffmpeg       AWS Elemental
  (<100 MB)              layer (<100 MB,       MediaConvert
                         <5 min)               (everything else)
        │                     │                     │
  thumb_320.webp        preview_480p.mp4      preview_480p.mp4
  thumb_640.webp        preview_128k.mp3      hls/ (240/480/720p)
  thumb_1280.webp       waveform.json         poster.webp
  blurhash              poster.webp           thumb_640.webp
        │                     │                     │
        └─────────────────────┴─────────────────────┘
                              ▼
              write to harmonyhub-proxies bucket
                              ▼
              Lambda — updater: PATCH asset document
              derivatives{}, processing.status = READY
                              ▼
              UI polls / receives update → card becomes live
```

### 6.1 Routing Rationale

MediaConvert bills per output minute; Lambda bills per GB-second. For a 28-second reel, Lambda with an ffmpeg layer costs a fraction of a cent and finishes in seconds. For a 45-minute event video, Lambda would hit the 15-minute timeout, so MediaConvert is correct. Routing on size and duration rather than sending everything to MediaConvert cuts pipeline cost by roughly 80% for a reel-heavy library.

### 6.2 Derivative Specifications

| Source family | Derivatives generated | Target size |
|---|---|---|
| Cover / Graphic | WebP at 320 / 640 / 1280 px, blurhash placeholder | 15–180 KB |
| Video (short, ≤5 min) | 480p H.264 MP4 preview, poster frame WebP, 640px thumb | 2–8 MB |
| Video (long-form) | HLS ladder 240p/480p/720p, poster frame, 640px thumb | streamed in chunks |
| Audio | 128 kbps MP3 preview, waveform peaks JSON, cover-art thumb | 1–4 MB |
| Text / Document | First-page PNG render → 640px WebP thumb | ~40 KB |

### 6.3 Processing States

`PENDING` → `PROCESSING` → `READY` | `FAILED`

Assets in `PENDING`/`PROCESSING` appear in the UI with a placeholder and are excluded from public share links. `FAILED` assets surface to Admins with the DLQ message, and are re-drivable from the admin panel. The original is always intact regardless of pipeline outcome — the pipeline only ever writes to the proxies bucket.

### 6.4 Backfill

Migrating the existing ~800-song library will process a large batch at once. Estimated one-time MediaConvert cost for long-form content is meaningful (order of $100–150, dependent on total video minutes). Recommendation: run the backfill in Reserved-queue-free On-Demand mode over several nights, use the Basic tier where quality permits, and process the cold-tier BTS raw footage *last* — or skip proxy generation for it entirely, since it is never browsed.

---

## 7. Upload Flow

How a file travels from an editor's browser into S3, with its metadata and tags saved to MongoDB. Note that at no point does the file pass through the application server.

| # | Step | Detail |
|---|---|---|
| 1 | Editor selects file + fills form | Asset type chosen from the fixed catalogue (§ v1.0 Section 8) |
| 2 | Adds metadata & manual tags | Title, artist, mood, language, controlled tags, optional custom tags |
| 3 | Client computes SHA-256 | Streamed hash in a Web Worker; no UI block |
| 4 | Validation | Required fields, type/format match, size ceiling. Fail → error, back to form |
| 5 | `POST /api/uploads/initiate` | Backend verifies Cognito JWT, checks role permits upload, checks checksum for duplicates |
| 6 | Backend returns presigned multipart URLs | Scoped to one exact key, with `content-length-range` and `content-type` conditions, 15-minute expiry |
| 7 | **Browser → S3 direct**, parallel parts | Resumable; failed parts retry individually; progress bar per part |
| 8 | `POST /api/uploads/complete` | Backend completes the multipart upload, verifies `ChecksumSHA256` matches step 3 |
| 9 | Write to MongoDB | Metadata + tags + `storage{}` + `version` + `processing.status = PENDING` |
| 10 | S3 event fires pipeline | EventBridge → SQS → Lambda/MediaConvert (§6) |
| 11 | Derivatives written, document patched | `processing.status = READY`, `derivatives{}` populated |
| 12 | Asset indexed and browsable | Appears in search with a real thumbnail |

**Why presigned multipart rather than posting to the API:** a 5 GB BTS upload through an Express server would consume server memory, hold a connection for minutes, count as inbound *and* outbound transfer, and fail entirely on a dropped connection. Browser-direct multipart is resumable, parallel, free (ingress is never charged), and keeps Fargate tasks at 0.25 vCPU.

---

## 8. Delivery & Sharing Flow

### 8.1 Search / Browse Read Path

| # | Step | Detail |
|---|---|---|
| 1 | User types query + filters | `"Raju Singh songs"`, filter: Reels, Punjabi, Viral |
| 2 | React → `GET /api/search?q=…&tags=…&type=…` | JSON only |
| 3 | Express builds MongoDB query | Text index on `title` + `tags`, plus faceted filters |
| 4 | MongoDB returns matches | Metadata + `derivatives{}` keys — **not** master keys |
| 5 | Backend signs derivative URLs | CloudFront signed URLs, 1-hour TTL, batch-signed |
| 6 | UI renders media cards | Thumbnails served from CloudFront edge cache |
| 7 | Click → inline preview | 480p proxy or HLS stream; still never the original |
| 8 | "Download original" (explicit) | Role check → `/original/*` signed URL, 5-min TTL, written to `activityLog` |

Steps 6 and 7 are where the ₹20,000 was lost in the old model and where it is saved in this one. A 100-card search result transfers roughly 6 MB of thumbnails, and on a warm edge cache costs nothing at all.

### 8.2 External Sharing

Replaces Drive's native sharing with a model the platform fully controls.

```
Marketing user  →  POST /api/shares { assetId, expiresIn, canDownload, maxDownloads }
                        │
                        ▼
        shares document created — random 32-byte token
                        │
        https://hub.example.com/s/{token}   →  sent to partner
                        │
        Partner opens link → GET /api/shares/{token}
                        │
        ┌───────────────┴────────────────┐
        │ Valid? Not expired?            │
        │ Under maxDownloads? Not revoked?│
        └───────────────┬────────────────┘
                 yes    │    no → 410 Gone
                        ▼
        CloudFront signed URL issued, TTL = min(remaining share life, 1 h)
        activityLog entry written: token, IP, user-agent, timestamp
                        ▼
        Partner streams / downloads directly from CloudFront edge
```

Capabilities beyond what Drive offered: hard expiry, download count caps, instant revocation, per-link download permission, and a complete access trail including IP. For high-volume partner distribution, a **Requester-Pays** bucket is available so the partner's own AWS account absorbs the egress.

---

## 9. Data Model

Document-oriented, unchanged in philosophy from v1.0: a song embeds its metadata and an array of asset references, so loading a song with all its assets is a single read with no joins.

### 9.1 Collections

| Collection | Key fields | Notes |
|---|---|---|
| `users` | `_id, cognitoSub, name, email, role, status, lastSeenAt` | Passwords live in Cognito, never here |
| `artists` | `_id, name, slug, label, genre, contact, imageAssetId, socials[]` | Referenced by songs |
| `songs` | `_id, title, slug, artistId, featuring[], language, mood, isrc, releaseDate, tags[], assets[]` | Embeds asset sub-documents |
| `tags` | `_id, name, type ("controlled" \| "custom"), usageCount, promotedAt` | Source list for manual tagging |
| `shares` | `_id, assetId, songId, token, createdBy, expiresAt, canDownload, maxDownloads, downloadCount, revokedAt` | Expiring share links |
| `restoreRequests` | `_id, assetId, requestedBy, tier, estimatedCost, status, requestedAt, availableUntil` | Glacier restore tracking — new in v2.0 |
| `activityLog` | `_id, userId, action, entity, entityId, ip, userAgent, meta, timestamp` | Audit trail |

### 9.2 Asset Sub-Document

The `driveFileId` string of v1.0 becomes a structured `storage` object plus a `derivatives` map. Everything else is preserved.

```jsonc
// VIDEO asset — song_1042 > assets[]
{
  "assetId": "1c9de4a7-…",
  "type": "Reel - BTS/MV",
  "family": "Video",
  "format": "9:16",

  "storage": {
    "bucket": "harmonyhub-masters-prod",
    "key": "masters/raju-singh/dil-se/video/reel-bts-mv/v2/1c9de4_dilse_bts_reel.mp4",
    "versionId": "3sL0zXqA…",
    "storageClass": "INTELLIGENT_TIERING",
    "sizeBytes": 48210432,
    "checksumSHA256": "e3b0c44298fc1c14…",
    "region": "ap-south-1"
  },

  "derivatives": {
    "thumbnail": "proxies/raju-singh/dil-se/video/reel-bts-mv/v2/1c9de4/thumb_640.webp",
    "preview":   "proxies/raju-singh/dil-se/video/reel-bts-mv/v2/1c9de4/preview_480p.mp4",
    "hls":       null,
    "poster":    "proxies/raju-singh/dil-se/video/reel-bts-mv/v2/1c9de4/poster.webp",
    "waveform":  null
  },

  "processing": {
    "status": "READY",
    "engine": "lambda-ffmpeg",
    "jobId": "job_88fa21",
    "completedAt": "2026-02-10T11:42:08Z"
  },

  "mimeType": "video/mp4",
  "version": "V2",
  "durationSec": 28,
  "tags": ["Reel", "BTS", "Viral"],
  "uploadedBy": "user_12",
  "createdAt": "2026-02-10"
}
```

```jsonc
// IMAGE asset — song_1042 > assets[]
{
  "assetId": "7b2f1088-…",
  "type": "Song Cover",
  "family": "Cover / Graphic",
  "format": "Image",

  "storage": {
    "bucket": "harmonyhub-masters-prod",
    "key": "masters/raju-singh/dil-se/cover-graphic/song-cover/final/7b2f10_dilse_cover_3000.jpg",
    "versionId": "9kQm2Pv…",
    "storageClass": "STANDARD",
    "sizeBytes": 3145728,
    "checksumSHA256": "a1d0c6e83f027327…",
    "region": "ap-south-1"
  },

  "derivatives": {
    "thumbnail": "proxies/raju-singh/dil-se/cover-graphic/song-cover/final/7b2f10/thumb_640.webp",
    "large":     "proxies/raju-singh/dil-se/cover-graphic/song-cover/final/7b2f10/thumb_1280.webp",
    "blurhash":  "LEHV6nWB2yk8pyo0adR*.7kCMdnj"
  },

  "processing": { "status": "READY", "engine": "lambda-sharp", "completedAt": "2026-02-08T09:15:44Z" },

  "mimeType": "image/jpeg",
  "dimensions": "3000 x 3000",
  "version": "Final",
  "tags": ["Romantic", "Cover"],
  "uploadedBy": "user_08",
  "createdAt": "2026-02-08"
}
```

### 9.3 Indexes

```js
songs.createIndex({ title: "text", tags: "text" })          // universal search
songs.createIndex({ artistId: 1, releaseDate: -1 })         // artist page
songs.createIndex({ language: 1 })                          // facet
songs.createIndex({ mood: 1 })                              // facet
songs.createIndex({ "assets.type": 1 })                     // type filter
songs.createIndex({ "assets.storage.checksumSHA256": 1 })   // dedup lookup
songs.createIndex({ "assets.processing.status": 1 })        // pipeline monitoring
shares.createIndex({ token: 1 }, { unique: true })
shares.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })  // TTL auto-cleanup
activityLog.createIndex({ timestamp: -1 })
activityLog.createIndex({ userId: 1, timestamp: -1 })
```

### 9.4 Asset-Granular Search

Because assets are embedded, a naive query returns whole song documents. Asset-level results (e.g. "show me every 9:16 reel tagged Viral") use `$elemMatch` in the filter with an aggregation `$unwind` + `$match` + `$project` stage to return flattened asset rows carrying their parent song context. This was an unresolved gap in v1.0 and is specified here.

---

## 10. API Contract

REST over HTTPS. All routes require a valid Cognito JWT except `/auth/*` and `/shares/{token}`. Responses are JSON; media never transits these endpoints.

### 10.1 Endpoints

| Method | Route | Role | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/login` | — | Exchange credentials for Cognito tokens |
| `POST` | `/api/auth/refresh` | — | Refresh access token |
| `GET` | `/api/me` | any | Current user + role + permissions |
| `GET` | `/api/artists` | any | List / paginate / filter artists |
| `POST` | `/api/artists` | Editor+ | Create artist |
| `GET` | `/api/artists/{id}` | any | Artist profile + songs + gallery |
| `PATCH` | `/api/artists/{id}` | Editor+ | Update artist |
| `DELETE` | `/api/artists/{id}` | Admin | Soft-delete artist |
| `GET` | `/api/songs` | any | List / paginate / filter songs |
| `POST` | `/api/songs` | Editor+ | Create song |
| `GET` | `/api/songs/{id}` | any | Song + all embedded assets (signed derivative URLs) |
| `PATCH` | `/api/songs/{id}` | Editor+ | Update song metadata / tags |
| `DELETE` | `/api/songs/{id}` | Admin | Soft-delete song |
| `POST` | `/api/uploads/initiate` | Editor+ | Validate, dedup-check, return presigned multipart URLs |
| `POST` | `/api/uploads/complete` | Editor+ | Complete MPU, verify checksum, create asset doc |
| `POST` | `/api/uploads/abort` | Editor+ | Abort MPU, clean up parts |
| `GET` | `/api/assets/{id}` | any | Asset detail + signed derivative URLs |
| `PATCH` | `/api/assets/{id}` | Editor+ | Edit asset metadata / tags / version label |
| `DELETE` | `/api/assets/{id}` | Admin | Soft-delete asset (S3 version retained) |
| `POST` | `/api/assets/{id}/download` | role-gated | Issue short-TTL signed URL for **original**; logged |
| `POST` | `/api/assets/{id}/restore` | Editor+ | Request Glacier restore; returns cost estimate |
| `GET` | `/api/search` | any | Universal search — `q`, `tags[]`, `type`, `family`, `language`, `mood`, `artistId`, `year`, `page` |
| `GET` | `/api/search/facets` | any | Available filter values + counts for current query |
| `GET` | `/api/tags` | any | Controlled + custom tag list |
| `POST` | `/api/tags` | Editor+ | Create custom tag |
| `PATCH` | `/api/tags/{id}/promote` | Admin | Promote custom tag → controlled |
| `POST` | `/api/shares` | Marketing+ | Create share link |
| `GET` | `/api/shares` | Marketing+ | List own / all active shares |
| `GET` | `/api/shares/{token}` | public | Resolve share → signed URL (validated, logged) |
| `DELETE` | `/api/shares/{id}` | Marketing+ | Revoke share immediately |
| `GET` | `/api/activity` | Admin | Audit log, filterable |
| `GET` | `/api/admin/pipeline` | Admin | Failed jobs, DLQ depth, re-drive |
| `GET` | `/api/admin/storage` | Admin | Storage by tier, cost estimate, top consumers |
| `GET` | `/healthz` | — | ALB health check |

### 10.2 Conventions

- Pagination: `?page=1&limit=24`, responses carry `{ data, page, limit, total, hasMore }`.
- Errors: RFC 7807 problem+json — `{ type, title, status, detail, instance }`.
- Idempotency: `Idempotency-Key` header honoured on all `POST` routes that create resources.
- Rate limits: 100 req/min per user standard; 10 req/min on `/download` and `/restore`.
- Soft deletes throughout — `deletedAt` timestamp; S3 objects retained per lifecycle policy.

---

## 11. Search & Tagging

### 11.1 Universal Search

Unchanged in behaviour from v1.0: a single search bar returning mixed-media results across the whole library — audio, video, images, documents, and artists. Backed by the MongoDB text index on `title` + `tags`, combined with faceted filters on `language`, `mood`, `artistId`, `assets.type`, `family`, and release year.

Upgrade path: if result quality outgrows basic text search (fuzzy matching, synonyms, relevance tuning), migrate to **Atlas Search** — a configuration change on the same cluster, no data migration.

### 11.2 Manual Tagging

Tagging is done by people, not algorithms. At upload — or later when editing — an Editor picks tags from a controlled list and may add custom tags.

**Controlled tags (mood / theme):** Romantic · Sad · Party · Acoustic · Viral · Festive · Devotional
**Controlled tags (format / use):** Promo · Reel · Teaser · BTS · Master · Demo · Lyric Video

**Custom tags** are free-form, stored with `type: "custom"`, and surface in an Admin review queue where a frequently-used custom tag can be promoted into the controlled list.

**Why manual:** accuracy (a person knows the song's intent), simplicity (no ML pipeline to build, train, or maintain in v1), and control (a fixed vocabulary keeps search reliable).

**UX rule:** good search depends on good tags. Tag selection is a required, friendly step in the upload form — controlled tags as clickable chips, with one optional "add custom tag" field.

---

## 12. Functional Modules

Ten cooperating modules, carried forward from v1.0 with AWS-specific behaviour noted.

| # | Module | v2.0 behaviour |
|---|---|---|
| 7.1 | **Artist Management** | Profiles, image galleries, genre, social links, collaborated songs. Artist images use the same pipeline as song assets. |
| 7.2 | **Song Management** | One document embedding metadata and an `assets[]` array; links each song to its assets and versions. |
| 7.3 | **Asset Management** | Core media engine. Every asset carries exactly one catalogue `type`, which drives filtering, S3 key placement, storage tier, and card icon. |
| 7.4 | **Search & Discovery** | Universal mixed-media search; see §11.1. |
| 7.5 | **Manual Tagging** | Controlled + custom vocabulary; see §11.2. |
| 7.6 | **AWS Storage Integration** | S3 via IAM roles (no static keys). Presigned multipart in, CloudFront signed URLs out. |
| 7.7 | **Key Prefix Organisation** | The Drive folder hierarchy realised as an S3 key schema; see §5.2. |
| 7.8 | **User Roles & Permissions** | Cognito groups → JWT claims → Express middleware; see §12.1. |
| 7.9 | **Sharing System** | Token-based, expiring, revocable, download-capped, fully audited; see §8.2. |
| 7.10 | **Version Management** | Semantic labels (V1, V2, Final, Final Master) plus S3 object versioning as a safety net; see §5.4. |

### 12.1 Roles

| Role | Cognito group | Access |
|---|---|---|
| **Admin** | `hh-admin` | Full access; user and content management; audit log; pipeline and storage admin |
| **Editor** | `hh-editor` | Upload content, edit metadata, manage tags, request restores |
| **Viewer** | `hh-viewer` | View and search content; preview freely; original downloads rate-limited |
| **Marketing** | `hh-marketing` | Access promotional assets; create and revoke external share links |

Enforcement is layered: Cognito group membership in the JWT, Express middleware per route, and — for the storage tier — IAM policies that scope the presign-issuing role to specific key prefixes. A compromised API token still cannot read outside its permitted prefixes.

---

## 13. Cost Model & Governance

### 13.1 Projected Monthly Cost

Assumptions: ~800 songs, ~2.2 TB total media, ~20 internal users, ap-south-1, tiering and proxies applied.

| Service | Configuration | Est. monthly (USD) | Est. monthly (INR) |
|---|---|---|---|
| S3 Standard — hot | ~150 GB (covers, snippets, all derivatives) | $3.75 | ~₹320 |
| S3 Intelligent-Tiering — warm | ~850 GB (masters, MVs, reels) | ~$19 | ~₹1,640 |
| S3 Glacier Deep Archive — cold | ~1.2 TB (BTS raw, event video) | ~$2.40 | ~₹210 |
| S3 requests | ~2M GET, ~50k PUT | ~$1 | ~₹85 |
| **CloudFront egress** | **under 1 TB/month — perpetual free tier** | **$0** | **₹0** |
| ECS Fargate | 2 × 0.25 vCPU / 0.5 GB, always on | ~$18 | ~₹1,550 |
| Application Load Balancer | 1 ALB, low LCU | ~$18 | ~₹1,550 |
| MongoDB Atlas | M10 on AWS | ~$57 | ~₹4,900 |
| Lambda + MediaConvert | steady-state (~40 new assets/mo) | ~$4 | ~₹345 |
| Cognito | 20 MAU — free tier | $0 | ₹0 |
| CloudWatch, Secrets Manager, misc. | | ~$6 | ~₹515 |
| **Total (production)** | | **~$129** | **~₹11,100** |

> Figures are estimates as of July 2026 and must be confirmed against the [AWS Pricing Calculator](https://calculator.aws/) for ap-south-1 before budget sign-off.

### 13.2 Reducing the Bill

The storage half of this bill is ~₹2,300/month; the compute and database half is ~₹8,800. Options, in order of savings-to-risk ratio:

| Lever | Saving | Trade-off |
|---|---|---|
| Atlas M10 → M0/M2 for dev+staging | ~₹4,900/mo per non-prod env | None for non-prod |
| ALB → CloudFront direct to Fargate via VPC Origin | ~₹1,550/mo | Slightly less flexible routing |
| Fargate → single EC2 `t4g.small` (Graviton) | ~₹500/mo | Loses managed scaling; fine below ~50 users |
| Compute Savings Plan, 1-year | ~30% of Fargate | Commitment |
| S3 gateway VPC endpoint (instead of NAT for S3 traffic) | ~₹2,700/mo if NAT would otherwise be needed | None — do this regardless |
| Delete BTS raw footage older than 2 years | ~₹150/mo | Policy decision |

**The single most important number remains egress, and this design holds it at ₹0** as long as monthly CloudFront transfer stays under 1 TB. At 20 internal users browsing proxies, realistic usage is 20–60 GB/month.

### 13.3 Cost Guardrails — Mandatory Before First Upload

Given the ₹20,000 incident, these are implemented in Phase 1, not deferred to Phase 5.

1. **AWS Budgets** — three alerts at ₹3,000 / ₹8,000 / ₹15,000 monthly, emailed to Admin and project owner.
2. **AWS Cost Anomaly Detection** — enabled with a ₹500 impact threshold, monitoring by service.
3. **CloudWatch alarm on `BytesDownloaded`** — fires if CloudFront egress exceeds 700 GB in a month (70% of the free tier).
4. **Bulk-download control** — no endpoint returns more than 20 original-asset URLs per request; anything larger requires Admin approval and is queued as an S3 Batch Operations job with a cost estimate shown first.
5. **Cost estimate before Glacier restore** — the restore dialog states the retrieval charge and requires explicit confirmation.
6. **Cost allocation tags** — every resource tagged `Project=HarmonyHub`, `Env=`, `Owner=` so Cost Explorer can attribute spend precisely.
7. **Requester-Pays for partner bulk distribution** — the partner's AWS account absorbs the egress.
8. **Weekly cost report** — `/api/admin/storage` surfaces storage by tier, month-to-date spend, and top consumers on the Admin dashboard.

---

## 14. Security & Compliance

### 14.1 Identity

Amazon Cognito User Pool with four groups mapping to the role model. MFA available and enforceable for Admin. Password policy, account recovery, and session management are Cognito's responsibility, removing credential handling from application code. The application validates tokens against the pool's JWKS endpoint — stateless, matching the v1.0 JWT design intent.

### 14.2 Storage Access

- **Block Public Access enabled on all buckets, at both bucket and account level.** No object is ever public.
- CloudFront reaches S3 through **Origin Access Control**; bucket policies accept only the CloudFront service principal for the specific distribution.
- Presigned upload URLs are scoped to a single key with `content-length-range` and `content-type` conditions, and expire in 15 minutes.
- CloudFront signed URLs for media carry a 1-hour TTL; signed URLs for **originals** carry 5 minutes and are logged individually.
- The signing key pair lives in **AWS Secrets Manager**, rotated on schedule; the private key never enters the application image.

### 14.3 Network

The API tasks and the Atlas PrivateLink endpoint sit in private subnets. An S3 **gateway VPC endpoint** keeps S3 traffic off the NAT path — both a security and a cost decision. Security groups are least-privilege; only the ALB may reach the Fargate tasks.

### 14.4 Encryption

At rest: SSE-S3 (AES-256) on all buckets by default; SSE-KMS with a customer-managed key on `harmonyhub-masters` if contractual requirements demand it. In transit: TLS 1.2+ everywhere, enforced by an `aws:SecureTransport` bucket policy condition.

### 14.5 Audit

CloudTrail records all API-level AWS activity. S3 server access logs and CloudFront standard logs land in `harmonyhub-logs`. The application writes its own `activityLog` for business-level events — who viewed, downloaded, shared, restored, or deleted what, and from which IP. Admins query this through `/api/activity`.

### 14.6 Vendor Lock-in

All S3 interaction is confined to a single `StorageAdapter` module exposing `put`, `presignUpload`, `presignRead`, `delete`, `copy`, and `restore`. MongoDB stores object keys, not URLs, so a future migration to a different S3-compatible provider is an adapter swap plus a data copy — not an application rewrite. This preserves the mitigation strategy of v1.0 §14 while satisfying the AWS mandate.

---

## 15. Development Roadmap — 16 Weeks

Two weeks longer than v1.0, reflecting the media pipeline and infrastructure-as-code work that Drive previously provided for free.

| Phase | Focus | Key deliverables | Duration |
|---|---|---|---|
| **0** | **Foundation & Guardrails** | AWS account structure, CDK project, VPC, S3 buckets + policies, CloudFront + OAC, Cognito pool, **Budgets + Cost Anomaly Detection** | 2 weeks |
| **1** | **Core Backend** | Express skeleton on Fargate, JWT verification, RBAC middleware, Mongo schemas, presigned upload + complete flow | 3 weeks |
| **2** | **Media Pipeline** | EventBridge → SQS → Lambda dispatcher, Sharp image path, ffmpeg short-media path, MediaConvert long-form path, DLQ + re-drive | 3 weeks |
| **3** | **Core Modules** | Artist, song, and asset CRUD; version labels; React UI shell; upload form with tag chips | 3 weeks |
| **4** | **Search & Tags** | Text index, faceted filters, asset-granular aggregation, tag management, search-first home screen | 2 weeks |
| **5** | **Collaboration** | Share tokens, expiry, revocation, download caps, activity log, admin dashboards | 2 weeks |
| **6** | **Migration & Polish** | Backfill of existing library, proxy generation for legacy assets, UI refinement, load testing, production cutover | 1 week |

### 15.1 Milestones

- **M0** — Infrastructure deployed via CDK; **cost alarms live before any data is uploaded.**
- **M1** — Browser-direct upload to S3 with metadata persisted to MongoDB.
- **M2** — Pipeline producing thumbnails and proxies; media cards render without touching originals.
- **M3** — Full CRUD across artists, songs, and assets.
- **M4** — Universal search returning mixed-media results with facets.
- **M5** — Secure external sharing and version history live.
- **M6** — Existing library migrated; production deployment and user onboarding complete.

---

## 16. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Egress cost recurrence** | Repeat of the ₹20,000 incident | Proxy-first architecture, CloudFront-only delivery, bulk-download gating, Budgets + anomaly detection, `BytesDownloaded` alarm |
| **Glacier retrieval surprise** | Unexpected charge on archive access | Cost estimate shown before every restore; Intelligent-Tiering (no retrieval fee) as the default for uncertain assets |
| **Media pipeline failure** | Assets stuck without previews | SQS retries + DLQ, admin re-drive UI, originals always intact — pipeline only writes to the proxies bucket |
| **MediaConvert backfill cost** | One-time spike during migration | Basic tier where quality permits, skip proxies for cold BTS raw, phased overnight batches, cost ceiling agreed in advance |
| **Presigned URL leakage** | Unauthorised access | Short TTLs (5 min originals / 1 h media), single-key scoping, CloudFront signed URLs with optional IP restriction, full access logging |
| **Large upload failure** | Editor frustration, wasted time | S3 multipart with per-part retry and resume; incomplete-MPU lifecycle cleanup |
| **Inconsistent manual tags** | Poor search quality | Controlled tag list, required tag step at upload, Admin promotion queue for custom tags |
| **Atlas Marketplace rejected by procurement** | Rework of the data layer | Documented fallback: DocumentDB + OpenSearch (§3.4.1); decision required before Phase 1 |
| **AWS lock-in** | Reduced future leverage | `StorageAdapter` abstraction; keys not URLs in the database (§14.6) |
| **Free-tier terms change** | Egress becomes billable | Alarms at 70% of the 1 TB allowance; proxy sizes tuned so realistic usage sits an order of magnitude below the ceiling |

---

## 17. Benefits

### 17.1 Business

- Centralised media management and a single source of truth for every release.
- Dramatically faster asset retrieval; duplicate uploads eliminated at the point of upload.
- Improved cross-team collaboration and controlled, auditable partner sharing.
- Predictable, alarmed, and governed monthly cost — no repeat of the ₹20,000 surprise.

### 17.2 Technical

- Stateless, horizontally scalable architecture with storage cost that decays automatically.
- A flexible document model that extends to new asset types without migration.
- Real adaptive streaming and edge caching, which the Drive design could not provide.
- Infrastructure defined as code, reproducible across dev, staging, and production.

---

## 18. Open Decisions

Four items require sign-off before Phase 1 begins.

| # | Decision | Why it matters | Owner |
|---|---|---|---|
| 1 | **MongoDB Atlas on AWS Marketplace vs DocumentDB + OpenSearch** | Determines whether the data and search layers are reused or rewritten; ~₹2,200/mo cost difference | Architecture + Procurement |
| 2 | **CloudFront tier on the existing account** — perpetual 1 TB pay-as-you-go vs the newer 100 GB flat-rate Free plan | The entire cost model rests on this allowance; must be confirmed in the Billing console | Project owner |
| 3 | **Cost Explorer breakdown of the ₹20,000 charge** — egress vs Glacier retrieval | If retrieval rather than egress, the tiering strategy in §5.3 needs adjustment | Project owner |
| 4 | **Retention policy for BTS unedited raw footage** — keep online, archive-only, or expire after N years | Largest single storage cost driver at roughly half the library by volume | Content team |

---

> **Final vision.** Harmony Hub becomes the centralised digital music asset ecosystem where the company manages every song, artist media item, promotional file, and release asset from one intelligent dashboard — simplifying operations, strengthening collaboration, and laying a scalable, cost-governed foundation on AWS for future content management and distribution.

---

*Harmony Hub · Project Planning Document · Version 2.0 (AWS) · Confidential — Internal Use*
