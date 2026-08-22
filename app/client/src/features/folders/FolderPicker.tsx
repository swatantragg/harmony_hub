// Choose an existing folder or make one on the spot.
//
// A folder here is a real Google Drive folder. Creating one creates it in the Drive;
// putting a file in one re-parents the Drive file. Neither copies a byte — Drive moves a
// file by updating an index entry — so this is still free and still freely undoable, but
// now the Drive and the app show the same thing to anybody who opens either.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderPlus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useFolderOptions } from '../../lib/vocabulary';
import { Modal, useToast } from '../../components/ui';
import { Select } from '../../components/Select';
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
        <Select
          value={value}
          onChange={(v) => {
            if (v === NEW) { setCreating(true); return; }
            onChange(v);
          }}
          options={[
            { value: '', label: 'No folder' },
            // Drive folders nest, so a flat list of names hides which "Masters" is which.
            // The full path answers that properly, where the old indent could only hint.
            ...(folders ?? []).map((f) => ({
              value: f._id,
              label: f.name,
              hint: (f.depth ?? 0) > 0 ? f.path : undefined,
              meta: f.assetCount,
            })),
            { value: NEW, label: '＋ New folder…' },
          ]}
          ariaLabel={label}
        />
        <div className="hint">{hint ?? 'Optional. A real folder in Google Drive — files move into it without any bytes being copied.'}</div>
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
  onClose, onCreated, defaultName = '', parentId = null, parentName,
}: {
  onClose: () => void;
  onCreated: (f: Folder) => void;
  defaultName?: string;
  /** Creates the folder inside this one. Null makes it a top-level folder. */
  parentId?: string | null;
  /** Only for the sentence in the header — the id is what the server acts on. */
  parentName?: string;
}) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [allowDuplicateName, setAllowDuplicate] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const create = useMutation({
    mutationFn: () =>
      api<Folder>('/folders', {
        method: 'POST',
        body: { name: name.trim(), description, tags, allowDuplicateName, parentId },
      }),
    onSuccess: (folder) => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: `Folder “${folder.name}” created`,
        body: 'It exists in Google Drive too. Add files to it now, or from any file’s details later.',
      });
      onCreated(folder);
    },
    // A duplicate name is the one refusal the reader can answer by insisting, so only that
    // one turns the button into "Create it anyway". Offering it for a 503 from Drive or a
    // rejected field just meant pressing it a second time and getting the same refusal.
    onError: (err: Error) => {
      setConflict(err.message);
      setAllowDuplicate(err instanceof ApiError && err.status === 409);
    },
  });

  return (
    <Modal
      title="New folder"
      subtitle={`${parentName ? `Inside “${parentName}”. ` : ''}Created in Google Drive as well as here.`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            <FolderPlus size={14} /> {allowDuplicateName ? 'Create it anyway' : 'Create folder'}
          </button>
        </>
      }
    >
      <div className="stack-4">
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
      </div>
    </Modal>
  );
}
