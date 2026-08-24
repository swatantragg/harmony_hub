import { FileText, Film, Image as ImageIcon, Music2 } from 'lucide-react';
import type { Asset, Family } from '../../lib/types';
import { AvailabilityBadge } from '../../components/ui';
import { RowMenu } from '../../components/RowMenu';
import { useAssetActions } from './assetActions';
import { bytes } from '../../lib/format';

export const FAMILY_ICON: Record<Family, typeof Music2> = {
  Audio: Music2, Video: Film, Image: ImageIcon, Document: FileText,
};

export function AssetList({
  assets, onOpen, selectedId, dense = false,
}: {
  assets: Asset[];
  onOpen: (a: Asset) => void;
  selectedId?: string | null;
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
              <th aria-label="Actions" />
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
  const { actions, dialogs } = useAssetActions(asset);

  const openIfFromRow = (e: React.MouseEvent<HTMLTableRowElement>) => {
    if (!e.currentTarget.contains(e.target as Node)) return;
    onOpen(asset);
  };

  return (
    <tr className={selected ? 'selected' : ''} onClick={openIfFromRow}>
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
      <td style={{ width: 1, paddingLeft: 0, paddingRight: 8 }}>
        <RowMenu actions={actions} label={`Actions for ${asset.displayName}`} />
        {dialogs}
      </td>
    </tr>
  );
}
