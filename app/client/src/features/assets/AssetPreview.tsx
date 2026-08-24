import { useEffect, useState } from 'react';
import { Archive, CircleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import type { Asset } from '../../lib/types';
import { FilePreview } from '../preview/FilePreview';

export function AssetPreview({ asset }: { asset: Asset }) {
  const [url, setUrl] = useState<string | null>(null);
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
    const isArchive = ['TRASHED', 'RESTORING'].includes(asset.availability.status);
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
        sizeBytes: asset.drive.sizeBytes,
        durationSec: asset.durationSec,
        dimensions: asset.dimensions,
        seed: asset.assetId,
      }}
    />
  );
}
