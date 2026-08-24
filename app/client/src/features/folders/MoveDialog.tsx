import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, FolderPlus, Home, Loader2, Folder as FolderIcon } from 'lucide-react';
import { api } from '../../lib/api';
import { Modal, useToast } from '../../components/ui';
import { useFolderOptions } from '../../lib/vocabulary';
import { NewFolderDialog } from './FolderPicker';
import { pluralise } from '../../lib/format';

const ROOT = '__root__';

interface MoveTarget {
  kind: 'asset' | 'folder';
  id: string;
  name: string;
  currentParentId: string | null;
}

export function MoveDialog({ target, onClose }: { target: MoveTarget; onClose: () => void }) {
  const { data: folders } = useFolderOptions();
  const [selected, setSelected] = useState<string>(target.currentParentId ?? ROOT);
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  const options = useMemo(() => {
    const all = folders ?? [];
    if (target.kind !== 'folder') return all;
    const self = all.find((f) => f._id === target.id);
    if (!self) return all;
    const prefix = `${self.path}${' / '}`;
    return all.filter((f) => f._id !== target.id && !f.path.startsWith(prefix));
  }, [folders, target]);

  const move = useMutation({
    mutationFn: async () => {
      const destination = selected === ROOT ? null : selected;
      if (target.kind === 'folder') {
        return api(`/folders/${target.id}`, { method: 'PATCH', body: { parentId: destination } });
      }
      const out = await api<{ ok: boolean; moved: number; failed: { displayName: string }[] }>(
        `/folders/${destination ?? 'none'}/assets`,
        { method: 'POST', body: { assetIds: [target.id] } },
      );
      if (!out.ok || out.moved === 0) {
        throw new Error(
          out.failed?.length
            ? 'Google Drive would not re-parent the file, so nothing was changed. Try again in a moment.'
            : 'The file is no longer in the catalogue, so there was nothing to move.',
        );
      }
      return out;
    },
    onSuccess: () => {
      qc.invalidateQueries();
      const where = selected === ROOT
        ? 'the library root'
        : `“${options.find((f) => f._id === selected)?.name ?? 'the folder'}”`;
      toast({
        kind: 'ok',
        title: `Moved to ${where}`,
        body: 'Re-parented in Google Drive too. No bytes were copied, and every share link still works.',
      });
      onClose();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not move it', body: e.message }),
  });

  const unchanged = selected === (target.currentParentId ?? ROOT);

  return (
    <>
      <Modal
        title={`Move “${target.name}”`}
        subtitle="Pick where it should live. Moving re-parents it in Google Drive — nothing is copied."
        onClose={onClose}
        width="narrow"
        footer={
          <>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={unchanged || move.isPending}
              title={unchanged ? 'That is where it already is.' : undefined}
              onClick={() => move.mutate()}
            >
              {move.isPending ? <Loader2 size={15} className="spin" /> : null} Move here
            </button>
          </>
        }
      >
        <div className="stack-3">
          <button className="btn btn-secondary btn-block" onClick={() => setCreating(true)}>
            <FolderPlus size={15} /> New folder…
          </button>

          <div className="panel rows move-list">
            <button
              type="button"
              className={`row-item move-option ${selected === ROOT ? 'on' : ''}`}
              onClick={() => setSelected(ROOT)}
            >
              <span className="row-icon info"><Home size={18} /></span>
              <span className="row-main">
                <span className="row-title">Library root</span>
                <span className="row-sub">Not inside any folder</span>
              </span>
              {selected === ROOT && <Check size={18} className="move-tick" />}
            </button>

            {options.map((f) => (
              <button
                key={f._id}
                type="button"
                className={`row-item move-option ${selected === f._id ? 'on' : ''}`}
                onClick={() => setSelected(f._id)}
                style={{ paddingLeft: 16 + (f.depth ?? 0) * 18 }}
              >
                <span className="row-icon info"><FolderIcon size={18} /></span>
                <span className="row-main">
                  <span className="row-title">{f.name}</span>
                  <span className="row-sub">
                    {(f.depth ?? 0) > 0 ? f.path : pluralise(f.assetCount, 'file')}
                  </span>
                </span>
                {selected === f._id && <Check size={18} className="move-tick" />}
              </button>
            ))}
          </div>

          {target.kind === 'folder' && (
            <div className="t-small">
              Everything inside it moves with it. A folder cannot be moved into itself, so its
              own subfolders are not listed.
            </div>
          )}
        </div>
      </Modal>

      {creating && (
        <NewFolderDialog
          parentId={selected === ROOT ? null : selected}
          onClose={() => setCreating(false)}
          onCreated={(f) => { setSelected(f._id); setCreating(false); }}
        />
      )}
    </>
  );
}
