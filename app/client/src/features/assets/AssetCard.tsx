// File lists. The product renders every file as a row in a table: a card grid showed
// four things about six files where a list shows five things about thirty, and the
// question people bring to a media library is nearly always "where is this one file".
import { FileText, Film, Image as ImageIcon, Music2 } from 'lucide-react';
import type { Asset, Family } from '../../lib/types';
import { AvailabilityBadge } from '../../components/ui';
import { RowMenu } from '../../components/RowMenu';
import { useAssetActions } from './assetActions';
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
              {/* The action column has no heading — the dots are self-explanatory and a
                  word here would be the widest thing in the narrowest column. */}
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

  // The row's dialogs are rendered from inside the row, and a Modal portals its DOM to
  // <body> — but a React portal still bubbles its events through the React tree, not the
  // DOM tree. So without this guard every click inside "Share", "Edit details", "Rename",
  // "Move" or the delete confirmation also reached this handler and opened the file's
  // details drawer over the top of the dialog, which is what made those five verbs
  // unusable from any file list — the library, a song, a search result, and the file
  // list inside a folder.
  //
  // The test is the DOM, which is the thing that actually knows where the click happened:
  // a portalled dialog is not a descendant of this row.
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
        {/* The dialogs render from here, inside the row, and portal their DOM to the
            body so the table's overflow never clips them. The row's own click handler is
            kept off them by the DOM check above. */}
        {dialogs}
      </td>
    </tr>
  );
}
