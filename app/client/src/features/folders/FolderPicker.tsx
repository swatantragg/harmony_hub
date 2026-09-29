import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Folder as FolderIcon, FolderPlus, Layers, Plus, Search } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { pluralise } from '../../lib/format';
import { useFolderOptions } from '../../lib/vocabulary';
import { Modal, useToast } from '../../components/ui';
import { Select } from '../../components/Select';
import { TagPicker } from '../upload/TagPicker';
import type { Folder, FolderOption } from '../../lib/types';

const NEW = '__new__';

/** How many folder chips show before the list asks to be opened out. Matches the tag sections. */
const PREVIEW = 18;

const parentPath = (f: FolderOption) => f.path.split(' / ').slice(0, -1).join(' / ');

/**
 * "Put all in a folder" on the upload screen.
 *
 * A dropdown showed the choice only while it was open, and the bulk one reset
 * to "No folder" the moment it was used — so the only way to check where a
 * queue was going was to read every file's own picker. This works like the tag
 * sections instead: every folder is a chip, a search box narrows them, and the
 * folder the files are going into stays lit at the front. The line underneath
 * says the same thing in words, including a folder just created here or made
 * by uploading a whole folder.
 *
 * `value` is the folder every file shares ('' for none); `mixed` means they do
 * not all share one.
 */
export function FolderSearchPicker({
  value, mixed = false, count, onChange, label = 'Put all in a folder',
}: {
  value: string;
  mixed?: boolean;
  count: number;
  onChange: (folderId: string) => void;
  label?: string;
}) {
  const { data: folders, isPending, isError, refetch } = useFolderOptions();
  const [term, setTerm] = useState('');
  const [openedOut, setOpenedOut] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  // A folder made here is on the files before the refreshed list comes back.
  const [justMade, setJustMade] = useState<Folder | null>(null);

  const all = folders ?? [];
  const chosenId = mixed ? '' : value;
  const chosen = chosenId ? all.find((f) => f._id === chosenId) ?? null : null;
  const chosenName = chosen?.name ?? (justMade?._id === chosenId ? justMade.name : null);

  const q = term.trim().toLowerCase();
  const rest = useMemo(
    () => all.filter((f) => f._id !== chosenId
      && (!q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))),
    [all, chosenId, q],
  );
  const truncated = !openedOut && !q && rest.length > PREVIEW;
  const shown = truncated ? rest.slice(0, PREVIEW) : rest;

  const chip = (f: FolderOption) => {
    const on = f._id === chosenId;
    return (
      <button
        key={f._id}
        type="button"
        className={`chip folder-chip ${on ? 'on' : ''}`}
        onClick={() => onChange(on ? '' : f._id)}
        aria-pressed={on}
        title={on ? `${f.path} — click again to take the files out of it` : f.path}
      >
        <FolderIcon size={13} aria-hidden style={{ flex: 'none' }} />
        <span className="chip-label">{f.name}</span>
        {(f.depth ?? 0) > 0 && <span className="count">in {parentPath(f).split(' / ').pop()}</span>}
      </button>
    );
  };

  const everyFile = count === 1 ? 'The file goes' : count === 2 ? 'Both files go' : `All ${count} files go`;

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', gap: 10, marginBottom: 7, flexWrap: 'wrap' }}>
        <div className="row-tight">
          <FolderIcon size={13} color="var(--ink-3)" />
          <span className="label">{label}</span>
          {all.length > 0 && <span className="t-small" style={{ opacity: 0.8 }}>· {all.length}</span>}
        </div>
        <div className="row-tight" style={{ flexWrap: 'wrap' }}>
          <Search size={13} color="var(--ink-3)" />
          <input
            className="input"
            style={{ maxWidth: 210, padding: '6px 9px' }}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search folders…"
            aria-label="Search folders"
          />
          {/* At the top, beside the search, rather than after two thousand chips. */}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setCreating(term.trim())}
            title={q ? `Make a folder called “${term.trim()}” and put the files in it` : 'Make a folder and put the files in it'}
          >
            <Plus size={13} aria-hidden /> {q ? `New folder “${term.trim()}”` : 'New folder'}
          </button>
        </div>
      </div>

      {isPending ? (
        <div className="hint" aria-live="polite">Loading folders…</div>
      ) : isError ? (
        <div className="hint">
          The folder list could not be loaded.{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refetch()}>Try again</button>
        </div>
      ) : (
        <div className="wrap-gap">
          <button
            type="button"
            className={`chip ${!mixed && !value ? 'on' : ''}`}
            onClick={() => onChange('')}
            aria-pressed={!mixed && !value}
            title="Leave the files at the top of the library, in no folder"
          >
            No folder
          </button>
          {chosen && chip(chosen)}
          {!chosen && chosenName && (
            <button type="button" className="chip folder-chip on" aria-pressed onClick={() => onChange('')}>
              <FolderIcon size={13} aria-hidden style={{ flex: 'none' }} />
              <span className="chip-label">{chosenName}</span>
            </button>
          )}
          {shown.map(chip)}
          {truncated && (
            <button type="button" className="chip chip-more" onClick={() => setOpenedOut(true)}>
              Show all {rest.length} folders <ChevronDown size={13} aria-hidden />
            </button>
          )}
          {openedOut && !q && rest.length > PREVIEW && (
            <button type="button" className="chip chip-more" onClick={() => setOpenedOut(false)}>
              Show fewer <ChevronUp size={13} aria-hidden />
            </button>
          )}
        </div>
      )}

      {q && rest.length === 0 && !isPending && (
        <div className="hint" style={{ marginTop: 7 }}>
          No folder matches “{term.trim()}”. Make it with <b>New folder</b> above and the files go straight into it.
        </div>
      )}

      <div className={`bulk-verdict ${!mixed && value ? 'set' : ''}`} style={{ marginTop: 10 }} aria-live="polite">
        {mixed ? <Layers size={14} aria-hidden /> : <FolderIcon size={14} aria-hidden />}
        <span>
          {mixed ? (
            <>These {pluralise(count, 'file')} are in different folders. Pick one above to put them all in the same place.</>
          ) : value ? (
            <>
              {everyFile} into <b>“{chosenName ?? 'the chosen folder'}”</b>
              {chosen && (chosen.depth ?? 0) > 0 && <> — {chosen.path}</>}
              . It is a real Google Drive folder, so that is where they appear in Drive too.
            </>
          ) : (
            <>No folder — {count === 1 ? 'the file goes' : 'the files go'} to the top of the library.</>
          )}
        </span>
      </div>

      {creating !== null && (
        <NewFolderDialog
          defaultName={creating}
          onClose={() => setCreating(null)}
          onCreated={(f) => {
            setJustMade(f);
            setTerm('');
            setCreating(null);
            onChange(f._id);
          }}
        />
      )}
    </div>
  );
}

/**
 * One file's folder. A dropdown, because it sits in a row beside other
 * dropdowns — but a searchable one, with "New folder" first: the list runs to
 * thousands in whole-Drive mode, and making a folder used to mean scrolling to
 * the very end of it. What is typed in the search becomes the new folder's name.
 */
export function FolderPicker({
  value, onChange, label = 'Folder', hint,
}: { value: string; onChange: (folderId: string) => void; label?: string; hint?: string }) {
  const { data: folders } = useFolderOptions();
  const [creating, setCreating] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const typed = term.trim();

  const options = useMemo(() => [
    { value: NEW, label: typed ? `＋ New folder “${typed}”…` : '＋ New folder…', pinned: true },
    { value: '', label: 'No folder' },
    ...(folders ?? []).map((f) => ({
      value: f._id,
      label: f.name,
      hint: (f.depth ?? 0) > 0 ? f.path : undefined,
      search: f.path,
      meta: f.assetCount,
    })),
  ], [folders, typed]);

  return (
    <>
      <div className="field grow" style={{ minWidth: 190 }}>
        <label className="label">{label}</label>
        <Select
          value={value}
          searchable
          searchPlaceholder="Search folders…"
          onSearchChange={setTerm}
          onChange={(v) => {
            if (v === NEW) { setCreating(typed); return; }
            onChange(v);
          }}
          options={options}
          ariaLabel={label}
        />
        <div className="hint">{hint ?? 'Optional. A real folder in Google Drive — files move into it without any bytes being copied.'}</div>
      </div>

      {creating !== null && (
        <NewFolderDialog
          defaultName={creating}
          onClose={() => setCreating(null)}
          onCreated={(f) => { onChange(f._id); setCreating(null); }}
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
  parentId?: string | null;
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
