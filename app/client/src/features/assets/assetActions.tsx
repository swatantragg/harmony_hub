// Share, move, rename, edit, delete — the verbs that belong to a file, in one place.
//
// The counterpart to useFolderActions in features/folders/Folders.tsx, and the same
// reasoning: a file is met in a list, in a folder, in a search result and in its own
// detail panel, and it has to offer the same things in all four. Wiring five dialogs into
// each of those screens separately is how they drift.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderInput, Pencil, Share2, SlidersHorizontal, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { ConfirmDialog, useToast } from '../../components/ui';
import type { RowAction } from '../../components/RowMenu';
import { useSession } from '../../app/session';
import { RenameDialog } from './RenameDialog';
import { EditMetadataDialog } from './EditMetadataDialog';
import { ShareDialog } from '../shares/ShareDialog';
import { MoveDialog } from '../folders/MoveDialog';
import type { Asset } from '../../lib/types';

export function useAssetActions(asset: Asset | null, opts: { onDeleted?: () => void } = {}) {
  const [renaming, setRenaming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const can = useSession((s) => s.can);

  const softDelete = useMutation({
    mutationFn: () => api(`/assets/${asset?.assetId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: 'Moved to the bin',
        body: 'Hidden here and trashed in Google Drive. Recoverable from either side for 30 days.',
      });
      opts.onDeleted?.();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not delete', body: e.message }),
  });

  const missing = asset?.availability.status === 'MISSING';

  const actions: RowAction[] = asset ? [
    {
      label: 'Share file',
      icon: <Share2 size={16} />,
      hidden: !can('share:create'),
      disabled: missing,
      disabledReason: 'The stored file is missing, so a link would resolve to nothing.',
      onSelect: () => setSharing(true),
    },
    {
      label: 'Move to folder',
      icon: <FolderInput size={16} />,
      hidden: !can('asset:edit'),
      onSelect: () => setMoving(true),
    },
    {
      label: 'Rename',
      icon: <Pencil size={16} />,
      hidden: !can('asset:rename'),
      onSelect: () => setRenaming(true),
    },
    {
      label: 'Edit details',
      icon: <SlidersHorizontal size={16} />,
      hidden: !can('asset:edit'),
      onSelect: () => setEditing(true),
    },
    {
      label: 'Delete',
      icon: <Trash2 size={16} />,
      danger: true,
      hidden: !can('asset:delete'),
      onSelect: () => setDeleting(true),
    },
  ] : [];

  const dialogs = asset ? (
    <>
      {renaming && <RenameDialog asset={asset} onClose={() => setRenaming(false)} />}
      {editing && <EditMetadataDialog asset={asset} onClose={() => setEditing(false)} />}
      {sharing && <ShareDialog asset={asset} onClose={() => setSharing(false)} />}
      {moving && (
        <MoveDialog
          target={{
            kind: 'asset',
            id: asset.assetId,
            name: asset.displayName,
            currentParentId: asset.folderId ?? null,
          }}
          onClose={() => setMoving(false)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Move to the recycle bin?"
          body={
            <>
              “{asset.displayName}” is hidden here and trashed in Google Drive. It stays
              recoverable from either side for 30 days, and any share link pointing at it stops
              working immediately.
            </>
          }
          confirmLabel="Move to recycle bin"
          onConfirm={() => softDelete.mutate()}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  ) : null;

  return { actions, dialogs };
}
