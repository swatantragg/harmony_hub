// StorageService — the entire S3 surface of the application (§9.2).
// Presign, head, availability interpretation, metadata refresh. Nothing else in the
// codebase imports the S3 client directly.
import * as s3 from '../s3/localS3.js';
import { presign } from '../s3/presign.js';
import { BUCKETS, TTL } from '../config.js';

export const assetsBucket = BUCKETS.assets;

export function presignGet({ bucket, key, expiresIn = TTL.download, filename, inline = false }) {
  return presign({
    op: 'GET',
    bucket,
    key,
    expiresIn,
    extra: filename
      ? { 'response-content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"` }
      : {},
  });
}

export function presignPart({ bucket, key, uploadId, partNumber }) {
  return presign({ op: 'PUT', bucket, key, expiresIn: TTL.uploadPart, extra: { uploadId, partNumber } });
}

// ── Availability verification (§10.5.1) ─────────────────────────────────────
// The whole decision table lives here, in one place, and returns the same shape
// whether it was reached by a live probe or by nightly reconciliation.

export function probe(asset) {
  const now = new Date().toISOString();
  const base = { lastCheckedAt: now, checkMethod: 'HEAD_OBJECT' };

  let meta;
  try {
    s3.settleRestore({ bucket: asset.s3.bucket, key: asset.s3.key });
    meta = s3.headObject({ bucket: asset.s3.bucket, key: asset.s3.key });
  } catch (err) {
    if (err.code === 'NoSuchKey') {
      return {
        availability: {
          ...base,
          status: 'MISSING',
          lastVerifiedAt: asset.availability?.lastVerifiedAt ?? null,
          detail: `NoSuchKey — object not found in ${asset.s3.bucket}`,
        },
        s3Head: null,
      };
    }
    // 403 means an IAM problem, not a missing file — never report the file as gone.
    return {
      availability: {
        ...base,
        status: 'UNVERIFIED',
        lastVerifiedAt: asset.availability?.lastVerifiedAt ?? null,
        detail: `${err.code} — could not verify; storage permissions need review`,
      },
      s3Head: null,
    };
  }

  const head = {
    sizeBytes: meta.size,
    etag: meta.etag,
    storageClass: meta.storageClass,
    lastModified: meta.lastModified,
    contentType: meta.contentType,
    versionId: meta.versionId,
    restore: meta.restore,
  };

  const archived = meta.storageClass === 'GLACIER' || meta.storageClass === 'DEEP_ARCHIVE';
  if (archived && meta.restore?.ongoing === true) {
    return {
      availability: {
        ...base,
        status: 'RESTORING',
        lastVerifiedAt: now,
        detail: `${meta.restore.tier} retrieval in progress — expected ready ${meta.restore.readyAt}`,
      },
      s3Head: head,
    };
  }
  if (archived && !(meta.restore && meta.restore.ongoing === false)) {
    return {
      availability: {
        ...base,
        status: 'ARCHIVED',
        lastVerifiedAt: now,
        detail: `Stored in ${meta.storageClass} — restore required before download`,
      },
      s3Head: head,
    };
  }

  const sizeDrift = asset.s3.sizeBytes != null && meta.size !== asset.s3.sizeBytes;
  const etagDrift = asset.s3.etag && meta.etag !== asset.s3.etag;
  if (sizeDrift || etagDrift) {
    const reasons = [];
    if (sizeDrift) reasons.push(`size ${asset.s3.sizeBytes} → ${meta.size}`);
    if (etagDrift) reasons.push(`ETag ${asset.s3.etag} → ${meta.etag}`);
    return {
      availability: {
        ...base,
        status: 'MISMATCH',
        lastVerifiedAt: now,
        detail: `Object present but differs from the catalogue record (${reasons.join('; ')})`,
      },
      s3Head: head,
    };
  }

  return {
    availability: { ...base, status: 'AVAILABLE', lastVerifiedAt: now, detail: null },
    s3Head: head,
  };
}

// Runs the probe and writes the result back onto the asset document.
export function verifyAsset(asset) {
  const { availability, s3Head } = probe(asset);
  asset.availability = availability;
  asset.lastHead = s3Head;
  return { availability, s3Head };
}

// Marks anything unverified for more than 24 h, so the UI can prompt a re-check (§8.4).
export function staleness(asset) {
  const at = asset.availability?.lastCheckedAt;
  if (!at) return { stale: true, ageHours: null };
  const ageHours = (Date.now() - Date.parse(at)) / 3_600_000;
  return { stale: ageHours > 24, ageHours };
}

// Refreshes x-amz-meta-display-name + Content-Disposition without moving bytes (§10.4.1 step 7).
export function refreshObjectMetadata(asset, song, artist) {
  try {
    const existing = s3.headObject({ bucket: asset.s3.bucket, key: asset.s3.key });
    s3.copyObject({
      bucket: asset.s3.bucket,
      sourceKey: asset.s3.key,
      destKey: asset.s3.key,
      metadataDirective: 'REPLACE',
      metadata: {
        ...existing.metadata,
        'asset-id': asset.assetId,
        'display-name': asset.displayName,
        'song-id': song?._id ?? '',
        'song-title': song?.title ?? '',
        artist: artist?.name ?? '',
        'asset-type': asset.type,
        family: asset.family,
        version: asset.version,
      },
    });
    return true;
  } catch {
    return false; // A missing object must not fail the rename — the catalogue is still correct.
  }
}

export { s3 };
