import { useEffect, useState } from 'react';
import { FileText, Film, Image as ImageIcon, Music2 } from 'lucide-react';
import type { Asset, Family } from '../../lib/types';
import { AvailabilityBadge, FamilyArt } from '../../components/ui';
import { bytes, midTruncate } from '../../lib/format';
import { api } from '../../lib/api';

export const FAMILY_ICON: Record<Family, typeof Music2> = {
  Audio: Music2, Video: Film, Image: ImageIcon, Document: FileText,
};

// Image assets show their real bytes, fetched through a short-lived signed URL. Everything
// else falls back to the family waveform wash so the grid stays visually even.
function useThumbnail(asset: Asset, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || asset.family !== 'Image' || asset.availability.status !== 'AVAILABLE') return;
    let alive = true;
    api<{ url: string }>(`/assets/${asset.assetId}/preview`, { method: 'POST' })
      .then((r) => alive && setUrl(r.url))
      .catch(() => {});
    return () => { alive = false; };
  }, [asset.assetId, asset.family, asset.availability.status, enabled]);
  return url;
}

export function AssetCard({
  asset, onOpen, selected, showThumbnails = true,
}: { asset: Asset; onOpen: (a: Asset) => void; selected?: boolean; showThumbnails?: boolean }) {
  const thumb = useThumbnail(asset, showThumbnails);
  const Icon = FAMILY_ICON[asset.family];

  return (
    <button
      className={`card ${selected ? 'selected' : ''}`}
      onClick={() => onOpen(asset)}
      aria-label={`${asset.displayName} — ${asset.type}, ${asset.availability.status.toLowerCase()}`}
    >
      <FamilyArt family={asset.family} seed={asset.assetId}>
        {thumb && <img src={thumb} alt="" loading="lazy" />}
        <span className="type-badge">{asset.type}</span>
        <span className="ver-badge">{asset.version}</span>
      </FamilyArt>

      <div className="card-body">
        <div className="card-title" title={asset.displayName}>{asset.displayName}</div>
        <div className="card-sub row-tight">
          <Icon size={12} color="var(--ink-3)" />
          <span className="truncate">
            {asset.songTitle ? `${asset.songTitle} · ${asset.artistName}` : asset.folderName ?? 'Not tied to a song'}
          </span>
        </div>
        <div className="card-key" title={asset.drive.path ?? asset.drive.name}>
          {midTruncate(asset.drive.path ?? asset.drive.name, 20, 12)}
        </div>
        <div className="card-foot">
          <AvailabilityBadge status={asset.availability.status} />
          <span className="t-small" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{bytes(asset.drive.sizeBytes)}</span>
        </div>
      </div>
    </button>
  );
}

export function AssetRow({ asset, onOpen, selected }: { asset: Asset; onOpen: (a: Asset) => void; selected?: boolean }) {
  const Icon = FAMILY_ICON[asset.family];
  return (
    <tr className={selected ? 'selected' : ''} onClick={() => onOpen(asset)}>
      <td>
        <div className="row-tight">
          <span
            data-family={asset.family}
            style={{
              width: 30, height: 30, borderRadius: 8, flex: 'none',
              background: 'linear-gradient(135deg, var(--fam-a), var(--fam-b))',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fam-ink)',
            }}
          >
            <Icon size={14} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }} className="truncate">{asset.displayName}</div>
            <div className="t-small" style={{ fontSize: 11.5 }}>
              {asset.songTitle ? `${asset.songTitle} · ${asset.artistName}` : asset.folderName ?? 'Not tied to a song'}
            </div>
          </div>
        </div>
      </td>
      <td className="t-small">{asset.type}</td>
      <td><span className="vchip">{asset.version}</span></td>
      <td className="t-small" style={{ fontFamily: 'var(--mono)' }}>{bytes(asset.drive.sizeBytes)}</td>
      <td><AvailabilityBadge status={asset.availability.status} /></td>
    </tr>
  );
}
