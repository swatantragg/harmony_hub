// File lists. The product renders every file as a row in a table: a card grid showed
// four things about six files where a list shows five things about thirty, and the
// question people bring to a media library is nearly always "where is this one file".
import { FileText, Film, Image as ImageIcon, Music2 } from 'lucide-react';
import type { Asset, Family } from '../../lib/types';
import { AvailabilityBadge } from '../../components/ui';
import { bytes } from '../../lib/format';

export const FAMILY_ICON: Record<Family, typeof Music2> = {
  Audio: Music2, Video: Film, Image: ImageIcon, Document: FileText,
};

// Every list of files in the product, in one place.
//
// Files used to render as a grid of cards in some screens and a table in others, which
// meant the same file looked like two different kinds of object depending on where you
// met it. A row also does what a card cannot: it lines type, version, size and
// availability into columns you can compare down, and fits four times as many files on a
// screen — which is the whole job when you are looking for one known name among hundreds.
export function AssetList({
  assets, onOpen, selectedId, dense = false,
}: {
  assets: Asset[];
  onOpen: (a: Asset) => void;
  selectedId?: string | null;
  /** Drops the columns that stop being worth their width inside a narrow panel. */
  dense?: boolean;
}) {
  return (
    <div className="panel" style={{ overflow: 'hidden' }}>
      <div className="table-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>File</th>
              <th>Type</th>
              {!dense && <th>Version</th>}
              <th>Size</th>
              <th>Availability</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <AssetRow key={a.assetId} asset={a} selected={selectedId === a.assetId} onOpen={onOpen} dense={dense} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AssetRow({
  asset, onOpen, selected, dense = false,
}: { asset: Asset; onOpen: (a: Asset) => void; selected?: boolean; dense?: boolean }) {
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
            <div className="t-small" style={{ fontSize: 14 }}>
              {asset.songTitle ? `${asset.songTitle} · ${asset.artistName}` : asset.folderName ?? 'Not tied to a song'}
            </div>
          </div>
        </div>
      </td>
      <td className="t-small">{asset.type}</td>
      {!dense && <td><span className="vchip">{asset.version}</span></td>}
      <td className="t-small" style={{ fontFamily: 'var(--mono)' }}>{bytes(asset.drive.sizeBytes)}</td>
      <td><AvailabilityBadge status={asset.availability.status} /></td>
    </tr>
  );
}
