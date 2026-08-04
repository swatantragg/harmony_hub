// Preview & streaming (§10.3). Everything here is served by a presigned inline URL that
// the browser fetches directly from storage — audio and video seeking use HTTP Range, so
// large files stream progressively instead of downloading in full.
//
// The viewer itself lives in features/preview/FilePreview so the public share page renders
// exactly the same thing: what a partner sees before downloading is what you saw before
// sharing.
import { useEffect, useState } from 'react';
import { Archive, CircleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import type { Asset } from '../../lib/types';
import { FilePreview } from '../preview/FilePreview';

export function AssetPreview({ asset }: { asset: Asset }) {
  const [url, setUrl] = useState<string | null>(null);
  // An unchecked file is almost certainly fine — it simply has not been proven recently.
  // Only a confirmed absence or an archived object actually blocks a preview.
  const playable = ['AVAILABLE', 'MISMATCH', 'UNVERIFIED'].includes(asset.availability.status);

  useEffect(() => {
    if (!playable) return;
    let alive = true;
    setUrl(null);
    api<{ url: string }>(`/assets/${asset.assetId}/preview`, { method: 'POST' })
      .then((r) => { if (alive) setUrl(r.url); })
      .catch(() => {});
    return () => { alive = false; };
  }, [asset.assetId, playable]);

  if (!playable) {
    const isArchive = ['ARCHIVED', 'RESTORING'].includes(asset.availability.status);
    return (
      <div className="preview-stage col" style={{ gap: 10, padding: 28, textAlign: 'center' }}>
        {isArchive ? <Archive size={26} color="var(--info)" /> : <CircleAlert size={26} color="var(--danger)" />}
        <div className="t-small" style={{ maxWidth: '38ch' }}>
          {isArchive
            ? 'This file is in archival storage. Request a restore to preview or download it.'
            : 'There is no object in storage behind this record, so there is nothing to preview.'}
        </div>
      </div>
    );
  }

  return (
    <FilePreview
      url={url}
      file={{
        displayName: asset.displayName,
        mimeType: asset.mimeType,
        sizeBytes: asset.s3.sizeBytes,
        durationSec: asset.durationSec,
        dimensions: asset.dimensions,
        seed: asset.assetId,
      }}
    />
  );
}
