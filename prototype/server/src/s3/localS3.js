// LocalS3 — a faithful, on-disk stand-in for the Amazon S3 API surface the platform uses.
// Only the operations named in the architecture are implemented, with the same semantics:
// PutObject · HeadObject · GetObject(Range) · CopyObject · DeleteObject · ListObjectsV2 ·
// CreateMultipartUpload · UploadPart · CompleteMultipartUpload · AbortMultipartUpload · RestoreObject
//
// Swapping this for @aws-sdk/client-s3 is a one-file change: every caller goes through
// services/storage.js, which speaks only in these verbs.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, REGION } from '../config.js';
import { md5, uuid } from '../util/crypto.js';

const enc = (key) => encodeURIComponent(key);
const bucketDir = (bucket) => path.join(PATHS.s3, bucket);
const objDir = (bucket, key) => path.join(bucketDir(bucket), enc(key));
const bodyPath = (bucket, key) => path.join(objDir(bucket, key), 'body.bin');
const metaPath = (bucket, key) => path.join(objDir(bucket, key), 'meta.json');
const mpuDir = (uploadId) => path.join(PATHS.s3, '_mpu', uploadId);

export class S3Error extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

const NoSuchKey = (key) => new S3Error('NoSuchKey', 404, `object not found: ${key}`);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readMeta(bucket, key) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(bucket, key), 'utf8'));
  } catch {
    return null;
  }
}

// ── Object operations ───────────────────────────────────────────────────────

export function putObject({ bucket, key, body, contentType, metadata = {}, storageClass = 'STANDARD' }) {
  ensureDir(objDir(bucket, key));
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  fs.writeFileSync(bodyPath(bucket, key), buf);
  const meta = {
    bucket,
    key,
    region: REGION,
    versionId: uuid().replace(/-/g, '').slice(0, 16),
    size: buf.length,
    etag: `"${md5(buf)}"`,
    contentType: contentType || 'application/octet-stream',
    storageClass,
    restore: null,
    metadata,
    lastModified: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath(bucket, key), JSON.stringify(meta, null, 2));
  return meta;
}

// HeadObject — full metadata, zero data transfer. The primitive behind §10.5.
export function headObject({ bucket, key }) {
  const meta = readMeta(bucket, key);
  if (!meta) throw NoSuchKey(key);
  return meta;
}

export function getObject({ bucket, key, range }) {
  const meta = readMeta(bucket, key);
  if (!meta) throw NoSuchKey(key);
  if (meta.storageClass !== 'STANDARD' && !(meta.restore && meta.restore.ongoing === false)) {
    throw new S3Error('InvalidObjectState', 403, 'object is archived and must be restored first');
  }
  const buf = fs.readFileSync(bodyPath(bucket, key));
  if (!range) return { meta, body: buf, partial: false };
  const [startRaw, endRaw] = range.replace(/bytes=/, '').split('-');
  const start = Number(startRaw || 0);
  const end = Math.min(endRaw ? Number(endRaw) : buf.length - 1, buf.length - 1);
  return { meta, body: buf.subarray(start, end + 1), partial: true, start, end, total: buf.length };
}

// CopyObject with MetadataDirective=REPLACE onto itself — how a logical rename refreshes
// x-amz-meta-display-name and Content-Disposition without moving a byte (§10.4.1 step 7).
export function copyObject({ bucket, sourceKey, destKey, metadata, metadataDirective = 'COPY', storageClass }) {
  const src = readMeta(bucket, sourceKey);
  if (!src) throw NoSuchKey(sourceKey);
  const buf = fs.readFileSync(bodyPath(bucket, sourceKey));
  return putObject({
    bucket,
    key: destKey,
    body: buf,
    contentType: src.contentType,
    metadata: metadataDirective === 'REPLACE' ? metadata : src.metadata,
    storageClass: storageClass || src.storageClass,
  });
}

export function deleteObject({ bucket, key }) {
  const dir = objDir(bucket, key);
  if (!fs.existsSync(dir)) return { deleted: false };
  fs.rmSync(dir, { recursive: true, force: true });
  return { deleted: true };
}

export function listObjectsV2({ bucket, prefix = '' }) {
  const dir = bucketDir(bucket);
  if (!fs.existsSync(dir)) return { contents: [] };
  const contents = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('_')) continue;
    const key = decodeURIComponent(entry);
    if (!key.startsWith(prefix)) continue;
    const meta = readMeta(bucket, key);
    if (meta) {
      contents.push({
        key,
        size: meta.size,
        etag: meta.etag,
        storageClass: meta.storageClass,
        lastModified: meta.lastModified,
      });
    }
  }
  return { contents: contents.sort((a, b) => a.key.localeCompare(b.key)) };
}

// RestoreObject — Glacier retrieval request (§10.9).
export function restoreObject({ bucket, key, tier = 'Standard', days = 7 }) {
  const meta = readMeta(bucket, key);
  if (!meta) throw NoSuchKey(key);
  // Prototype timing: Expedited resolves in ~20 s, Standard ~90 s, Bulk ~180 s.
  const waitMs = { Expedited: 20_000, Standard: 90_000, Bulk: 180_000 }[tier] ?? 90_000;
  meta.restore = {
    ongoing: true,
    tier,
    requestedAt: new Date().toISOString(),
    readyAt: new Date(Date.now() + waitMs).toISOString(),
    expiryDate: new Date(Date.now() + waitMs + days * 86_400_000).toISOString(),
  };
  fs.writeFileSync(metaPath(bucket, key), JSON.stringify(meta, null, 2));
  return meta;
}

// Called on every HeadObject read path to settle in-flight restores, the way S3 would.
export function settleRestore({ bucket, key }) {
  const meta = readMeta(bucket, key);
  if (!meta?.restore?.ongoing) return meta;
  if (Date.parse(meta.restore.readyAt) <= Date.now()) {
    meta.restore.ongoing = false;
    fs.writeFileSync(metaPath(bucket, key), JSON.stringify(meta, null, 2));
  }
  return meta;
}

export function setStorageClass({ bucket, key, storageClass }) {
  const meta = readMeta(bucket, key);
  if (!meta) throw NoSuchKey(key);
  meta.storageClass = storageClass;
  fs.writeFileSync(metaPath(bucket, key), JSON.stringify(meta, null, 2));
  return meta;
}

// ── Multipart upload ────────────────────────────────────────────────────────

export function createMultipartUpload({ bucket, key, contentType, metadata }) {
  const uploadId = uuid();
  ensureDir(mpuDir(uploadId));
  fs.writeFileSync(
    path.join(mpuDir(uploadId), 'manifest.json'),
    JSON.stringify({ uploadId, bucket, key, contentType, metadata, createdAt: new Date().toISOString() }, null, 2),
  );
  return { uploadId };
}

export function uploadPart({ uploadId, partNumber, body }) {
  const dir = mpuDir(uploadId);
  if (!fs.existsSync(dir)) throw new S3Error('NoSuchUpload', 404, 'multipart upload does not exist');
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  fs.writeFileSync(path.join(dir, `part-${String(partNumber).padStart(5, '0')}.bin`), buf);
  return { partNumber: Number(partNumber), etag: `"${md5(buf)}"`, size: buf.length };
}

export function listParts({ uploadId }) {
  const dir = mpuDir(uploadId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('part-'))
    .map((f) => Number(f.slice(5, 10)))
    .sort((a, b) => a - b);
}

export function completeMultipartUpload({ uploadId, parts }) {
  const dir = mpuDir(uploadId);
  if (!fs.existsSync(dir)) throw new S3Error('NoSuchUpload', 404, 'multipart upload does not exist');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const chunks = ordered.map((p) =>
    fs.readFileSync(path.join(dir, `part-${String(p.partNumber).padStart(5, '0')}.bin`)),
  );
  const meta = putObject({
    bucket: manifest.bucket,
    key: manifest.key,
    body: Buffer.concat(chunks),
    contentType: manifest.contentType,
    metadata: manifest.metadata,
  });
  // Multipart ETags carry a "-{partCount}" suffix in real S3; mirror that.
  meta.etag = `"${meta.etag.replace(/"/g, '')}-${ordered.length}"`;
  fs.writeFileSync(metaPath(manifest.bucket, manifest.key), JSON.stringify(meta, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });
  return meta;
}

export function abortMultipartUpload({ uploadId }) {
  fs.rmSync(mpuDir(uploadId), { recursive: true, force: true });
  return { aborted: true };
}

export function initBuckets(buckets) {
  for (const b of Object.values(buckets)) ensureDir(bucketDir(b));
  ensureDir(path.join(PATHS.s3, '_mpu'));
}
