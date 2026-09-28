import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Tags, Search, Pencil, Trash2, ExternalLink, Loader2, Info, AlertTriangle, Merge,
} from 'lucide-react';
import { ApiError, api } from '../../lib/api';
import { ConfirmDialog, EmptyState, Modal, Skeleton, useToast } from '../../components/ui';
import { AssetList } from '../assets/AssetCard';
import { AssetDrawer } from '../assets/AssetDrawer';
import { pluralise } from '../../lib/format';
import type { Asset } from '../../lib/types';

interface ManagedTag {
  _id: string | null;
  key: string;
  name: string;
  group: string;
  controlled: boolean;
  /** Every spelling of this tag currently in circulation. More than one is a problem. */
  variants: string[];
  fileCount: number;
  folderCount: number;
}
interface TagSectionRow { group: string; tags: ManagedTag[] }
interface ManageResponse { sections: TagSectionRow[]; totals: { tags: number; unused: number } }

/** How many files the inline preview pulls before it points at the search page. */
const PREVIEW = 24;

/** A count that reads as a count — round, monospaced, and zero is not hidden. */
function Count({ n }: { n: number }) {
  return (
    <span
      aria-label={`${n} ${n === 1 ? 'file' : 'files'}`}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: 22, height: 22, padding: '0 6px', borderRadius: 999,
        fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, lineHeight: 1,
        background: n > 0 ? 'var(--indigo)' : 'var(--surface-2)',
        color: n > 0 ? 'var(--on-accent)' : 'var(--ink-3)',
        border: n > 0 ? 'none' : '1px solid var(--line-2)',
        flex: 'none',
      }}
    >
      {n}
    </span>
  );
}

function RenameDialog({
  tag, onClose,
}: { tag: ManagedTag; onClose: () => void }) {
  const [name, setName] = useState(tag.name);
  const [merge, setMerge] = useState<{ into: string; files: number } | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const save = useMutation({
    mutationFn: (confirmMerge: boolean) =>
      api<{ name: string; previousName: string; files: number; folders: number; merged: boolean }>(
        `/tags/manage/${encodeURIComponent(tag.key)}`,
        { method: 'PATCH', body: { name: name.trim(), merge: confirmMerge } },
      ),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: r.merged ? 'Tags merged' : 'Tag renamed',
        body: `${r.previousName} → ${r.name}, across ${pluralise(r.files, 'file')}${
          r.folders ? ` and ${pluralise(r.folders, 'folder')}` : ''}.`,
      });
      onClose();
    },
    onError: (e: Error) => {
      // 409 is not a failure here, it is a question: the name is taken, and
      // going ahead means merging. Ask it rather than reporting an error.
      const offer = e instanceof ApiError
        ? (e.details.merge as { into: string; files: number } | undefined)
        : undefined;
      if (offer) { setMerge(offer); return; }
      toast({ kind: 'danger', title: 'Could not rename', body: e.message });
    },
  });

  const changed = name.trim() && name.trim() !== tag.name;

  return (
    <Modal
      title="Rename tag"
      subtitle={tag.name}
      onClose={onClose}
      width="narrow"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className={`btn ${merge ? 'btn-danger-solid' : 'btn-primary'}`}
            disabled={!changed || save.isPending}
            onClick={() => save.mutate(Boolean(merge))}
          >
            {save.isPending ? <Loader2 size={14} className="spin" /> : null}
            {merge ? `Merge into “${merge.into}”` : 'Rename everywhere'}
          </button>
        </>
      }
    >
      <div className="stack-3">
        <div className="field">
          <label className="label" htmlFor="tag-rename">New name</label>
          <input
            id="tag-rename"
            className="input"
            value={name}
            autoFocus
            onChange={(e) => { setName(e.target.value); setMerge(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && changed) save.mutate(Boolean(merge)); }}
          />
        </div>

        <div className="note">
          <Info size={15} />
          <div>
            Every one of the {pluralise(tag.fileCount, 'file')}
            {tag.folderCount > 0 && <> and {pluralise(tag.folderCount, 'folder')}</>} carrying
            this tag is updated in one go. Nothing is re-uploaded — a tag is metadata, so the
            files themselves are not touched.
          </div>
        </div>

        {tag.variants.length > 1 && (
          <div className="note">
            <Merge size={15} />
            <div>
              <b>{tag.variants.length} spellings of this tag are in use:</b>{' '}
              {tag.variants.map((v) => `“${v}”`).join(', ')}. Renaming settles all of them on
              the one name, which is usually the reason to do it.
            </div>
          </div>
        )}

        {merge && (
          <div className="note danger">
            <AlertTriangle size={15} />
            <div>
              <b>“{merge.into}” already exists</b>, on {pluralise(merge.files, 'file')}. Going
              ahead merges the two into one tag. A file that had both ends up with one, and
              there is no way to tell them apart again afterwards.
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The files carrying one tag, pulled through the ordinary search API. */
function TagFiles({ tag, onOpen }: { tag: ManagedTag; onOpen: (id: string) => void }) {
  const { data, isPending } = useQuery({
    queryKey: ['tag-files', tag.name, PREVIEW],
    queryFn: () => api<{ data: Asset[]; total: number }>(
      `/search?tags=${encodeURIComponent(tag.name)}&limit=${PREVIEW}&sort=updated`,
    ),
  });

  if (isPending) return <div className="stack-2" style={{ marginTop: 12 }}><Skeleton h={54} /><Skeleton h={54} /></div>;
  if (!data?.data.length) {
    return (
      <div className="hint" style={{ marginTop: 12 }}>
        Nothing carries this tag. It can be deleted without affecting any file.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <AssetList assets={data.data} onOpen={(a) => onOpen(a.assetId)} dense />
      {data.total > data.data.length && (
        <Link
          className="btn btn-ghost btn-sm"
          style={{ marginTop: 10 }}
          to={`/?tags=${encodeURIComponent(tag.name)}`}
        >
          <ExternalLink size={13} /> See all {data.total} in search
        </Link>
      )}
    </div>
  );
}

function TagRow({
  tag, open, onToggle, onRename, onDelete, onOpenAsset,
}: {
  tag: ManagedTag;
  open: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
  onOpenAsset: (id: string) => void;
}) {
  return (
    <div
      className="panel"
      style={{ boxShadow: 'none', borderColor: open ? 'var(--indigo)' : 'var(--line)' }}
    >
      <div className="panel-body" style={{ padding: '11px 13px' }}>
        <div className="spread" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="row-tight grow"
            onClick={onToggle}
            aria-expanded={open}
            style={{
              background: 'none', border: 0, padding: 0, cursor: 'pointer',
              textAlign: 'left', minWidth: 190, color: 'inherit', gap: 9,
            }}
          >
            <Count n={tag.fileCount} />
            <span style={{ fontWeight: 600, wordBreak: 'break-word' }}>{tag.name}</span>
            {tag.variants.length > 1 && (
              <span className="t-small" style={{ color: 'var(--warn-ink)' }}>
                · {tag.variants.length} spellings
              </span>
            )}
            {tag.folderCount > 0 && (
              <span className="t-small">· {pluralise(tag.folderCount, 'folder')}</span>
            )}
          </button>

          <div className="row-tight">
            <button className="btn btn-ghost btn-sm" onClick={onRename}>
              <Pencil size={13} /> Rename
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onDelete}>
              <Trash2 size={13} /> Delete
            </button>
          </div>
        </div>

        {open && <TagFiles tag={tag} onOpen={onOpenAsset} />}
      </div>
    </div>
  );
}

export function ManageTags() {
  const [term, setTerm] = useState('');
  const [usedOnly, setUsedOnly] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<ManagedTag | null>(null);
  const [deleting, setDeleting] = useState<ManagedTag | null>(null);
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isPending } = useQuery({
    queryKey: ['tags-manage'],
    queryFn: () => api<ManageResponse>('/tags/manage'),
  });

  const remove = useMutation({
    mutationFn: (tag: ManagedTag) =>
      api<{ name: string; files: number; folders: number }>(
        `/tags/manage/${encodeURIComponent(tag.key)}`, { method: 'DELETE' },
      ),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: 'Tag deleted',
        body: r.files || r.folders
          ? `Removed from ${pluralise(r.files, 'file')}${r.folders ? ` and ${pluralise(r.folders, 'folder')}` : ''}. No file was deleted.`
          : 'It was not on anything.',
      });
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not delete', body: e.message }),
  });

  const sections = useMemo(() => {
    const q = term.trim().toLowerCase();
    return (data?.sections ?? [])
      .map((s) => ({
        ...s,
        tags: s.tags.filter(
          (t) => (!usedOnly || t.fileCount > 0 || t.folderCount > 0)
            && (!q || t.name.toLowerCase().includes(q)),
        ),
      }))
      .filter((s) => s.tags.length > 0);
  }, [data, term, usedOnly]);

  if (isPending) {
    return <div className="page stack-3"><Skeleton h={32} w="30%" /><Skeleton h={90} /><Skeleton h={260} /></div>;
  }

  const shown = sections.reduce((n, s) => n + s.tags.length, 0);
  const totals = data?.totals ?? { tags: 0, unused: 0 };

  return (
    <div className="page stack-5">
      <div className="spread page-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <h1 className="t-h1">Manage tags</h1>
          <div className="hint" style={{ marginTop: 4 }}>
            {totals.tags} tags across {(data?.sections ?? []).length} sections
            {totals.unused > 0 && <> · {totals.unused} on nothing yet</>}
          </div>
        </div>
        <div className="row-tight" style={{ flexWrap: 'wrap' }}>
          <div className="row-tight">
            <Search size={14} color="var(--ink-3)" />
            <input
              className="input"
              style={{ maxWidth: 220 }}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Find a tag…"
              aria-label="Find a tag"
            />
          </div>
          <label className="check" style={{ whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              checked={usedOnly}
              onChange={(e) => setUsedOnly(e.target.checked)}
              style={{ accentColor: 'var(--indigo)' }}
            />
            <span className="label" style={{ margin: 0 }}>In use only</span>
          </label>
        </div>
      </div>

      <div className="note indigo">
        <Tags size={16} />
        <div>
          <b>A tag is a label copied onto every file that carries it, not a folder.</b> Renaming
          one here rewrites it on every file and folder at once, and deleting one takes it off
          them — <b>no file is ever deleted, moved or re-uploaded</b>. The number beside each tag
          is counted from the files themselves; click it to see them.
        </div>
      </div>

      {shown === 0 ? (
        <EmptyState
          icon={<Tags size={26} />}
          title={term.trim() ? `Nothing matches “${term.trim()}”` : 'No tags in use yet'}
          body={
            usedOnly && totals.unused > 0
              ? `${totals.unused} tags exist but are not on any file. Untick “In use only” to see them.`
              : 'Tags are added when a file is uploaded or edited.'
          }
        />
      ) : (
        sections.map((section) => (
          <section key={section.group}>
            <div className="spread" style={{ marginBottom: 11 }}>
              <h2 className="t-h2">{section.group}</h2>
              <span className="t-small">{pluralise(section.tags.length, 'tag')}</span>
            </div>
            <div className="stack-2">
              {section.tags.map((tag) => (
                <TagRow
                  key={tag.key}
                  tag={tag}
                  open={openKey === tag.key}
                  onToggle={() => setOpenKey(openKey === tag.key ? null : tag.key)}
                  onRename={() => setRenaming(tag)}
                  onDelete={() => setDeleting(tag)}
                  onOpenAsset={setOpenAsset}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {renaming && <RenameDialog tag={renaming} onClose={() => setRenaming(null)} />}

      {deleting && (
        <ConfirmDialog
          title="Delete this tag?"
          danger
          confirmLabel={`Remove from ${pluralise(deleting.fileCount, 'file')}`}
          requireTyped={deleting.fileCount >= 25 ? deleting.name : undefined}
          body={
            <>
              <b>“{deleting.name}”</b> comes off {pluralise(deleting.fileCount, 'file')}
              {deleting.folderCount > 0 && <> and {pluralise(deleting.folderCount, 'folder')}</>}.
              The files stay exactly where they are — this removes the label, nothing else.
              {' '}Anyone searching for this tag afterwards will find nothing, and putting it
              back means tagging each file again.
              {deleting.fileCount >= 25 && (
                <> Type the tag name below to confirm.</>
              )}
            </>
          }
          onConfirm={() => remove.mutate(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}

      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
    </div>
  );
}
