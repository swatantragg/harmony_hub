// Choose an existing folder or make one on the spot. A folder here is purely a grouping
// in the catalogue — storage still keeps every file as its own separate object, so
// putting a file "in" a folder moves nothing and can be undone freely.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, X, Info } from 'lucide-react';
import { api } from '../../lib/api';
import { useFolderOptions } from '../../lib/vocabulary';
import { useToast } from '../../components/ui';
import { TagPicker } from '../upload/TagPicker';
import type { Folder } from '../../lib/types';

const NEW = '__new__';

export function FolderPicker({
  value, onChange, label = 'Folder', hint,
}: { value: string; onChange: (folderId: string) => void; label?: string; hint?: string }) {
  const { data: folders } = useFolderOptions();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="field grow" style={{ minWidth: 190 }}>
        <label className="label">{label}</label>
        <select
          className="select"
          value={value}
          onChange={(e) => {
            if (e.target.value === NEW) { setCreating(true); return; }
            onChange(e.target.value);
          }}
        >
          <option value="">No folder</option>
          {(folders ?? []).map((f) => (
            <option key={f._id} value={f._id}>{f.name} ({f.assetCount})</option>
          ))}
          <option value={NEW}>＋ New folder…</option>
        </select>
        <div className="hint">{hint ?? 'Optional. Groups files together without changing where they are stored.'}</div>
      </div>

      {creating && (
        <NewFolderDialog
          onClose={() => setCreating(false)}
          onCreated={(f) => { onChange(f._id); setCreating(false); }}
        />
      )}
    </>
  );
}

export function NewFolderDialog({
  onClose, onCreated, defaultName = '',
}: { onClose: () => void; onCreated: (f: Folder) => void; defaultName?: string }) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [allowDuplicateName, setAllowDuplicate] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const create = useMutation({
    mutationFn: () =>
      api<Folder>('/folders', { method: 'POST', body: { name: name.trim(), description, tags, allowDuplicateName } }),
    onSuccess: (folder) => {
      qc.invalidateQueries();
      toast({ kind: 'ok', title: `Folder “${folder.name}” created`, body: 'Add files to it now, or from any file’s details later.' });
      onCreated(folder);
    },
    onError: (err: Error) => {
      setConflict(err.message);
      setAllowDuplicate(true);
    },
  });

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal aria-label="New folder">
        <div className="modal-head spread">
          <div>
            <h2 className="t-h2">New folder</h2>
            <div className="t-small" style={{ marginTop: 3 }}>A way to group files. Nothing is moved in storage.</div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>

        <div className="modal-body stack-4">
          <div className="field">
            <label className="label">Folder name</label>
            <input
              className="input"
              autoFocus
              value={name}
              placeholder="e.g. Dil Se — launch kit"
              onChange={(e) => { setName(e.target.value); setConflict(null); }}
            />
            {conflict && <div className="t-small" style={{ color: 'var(--warn-ink)' }}>{conflict}</div>}
          </div>

          <div className="field">
            <label className="label">What is it for? (optional)</label>
            <textarea
              className="textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A sentence so the next person knows what belongs in here."
            />
          </div>

          <TagPicker value={tags} onChange={setTags} label="Folder tags" />

          <div className="note indigo">
            <Info size={15} />
            <div>
              <b>Folders live in the catalogue, not in storage.</b> Each file inside stays a
              separate object exactly as it is today, so renaming this folder, moving files
              between folders, or deleting it later never touches a single byte.
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            <FolderPlus size={14} /> {conflict ? 'Create it anyway' : 'Create folder'}
          </button>
        </div>
      </div>
    </div>
  );
}
