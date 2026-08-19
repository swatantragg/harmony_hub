import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Folder as FolderIcon, FolderPlus, ArrowLeft, UploadCloud, AlertTriangle, FolderInput,
  Pencil, Trash2, Info, Search, Music2, Film, Image as ImageIcon, FileText, Share2, ExternalLink,
} from 'lucide-react';
import { api } from '../../lib/api';
import {
  ConfirmDialog, EmptyState, Modal, RowSkeletons, Skeleton, TagChip, useDebounced, useToast,
} from '../../components/ui';
import { RowMenu } from '../../components/RowMenu';
import type { RowAction } from '../../components/RowMenu';
import { AssetList } from '../assets/AssetCard';
import { AssetDrawer } from '../assets/AssetDrawer';
import { NewFolderDialog } from './FolderPicker';
import { MoveDialog } from './MoveDialog';
import { ShareDialog } from '../shares/ShareDialog';
import { TagPicker } from '../upload/TagPicker';
import { bytes, date, pluralise, relative } from '../../lib/format';
import { useSession } from '../../app/session';
import type { Folder, Family } from '../../lib/types';

const FAMILY_ICON: Record<string, typeof Music2> = { Audio: Music2, Video: Film, Image: ImageIcon, Document: FileText };
const FAMILY_ORDER: Family[] = ['Audio', 'Video', 'Image', 'Document'];
// Plural, because a tab labels a group rather than a single thing.
const FAMILY_LABEL: Record<Family, string> = {
  Audio: 'Audio', Video: 'Videos', Image: 'Images', Document: 'Documents',
};

// Alphabetical first and by default: a folder list is something people scan for a name
// they already know, and any other default order makes that a hunt.
const FOLDER_SORTS = [
  ['name', 'Name — A to Z'],
  ['nameDesc', 'Name — Z to A'],
  ['files', 'Most files first'],
  ['filesAsc', 'Fewest files first'],
  ['largest', 'Largest first'],
  ['newest', 'Recently updated'],
  ['oldest', 'Least recently updated'],
] as const;
type FolderSort = typeof FOLDER_SORTS[number][0];

// Share, move, edit, delete — the four things you can do to a folder, offered identically
// wherever a folder appears. Returns the menu entries and the dialogs they open, so a
// caller renders `{dialogs}` once and hands `actions` to a RowMenu.
//
// The alternative — each screen wiring its own four useState flags and four dialogs — is
// how the list and the detail page end up offering different subsets of the same verbs.
function useFolderActions(folder: Folder | null, opts: { onDeleted?: () => void } = {}) {
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const can = useSession((s) => s.can);

  const remove = useMutation({
    mutationFn: () => api<{ filesReleased: number }>(`/folders/${folder?._id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: 'Folder removed',
        body: `${pluralise(r.filesReleased, 'file')} moved back to the library root, in Google Drive too. Nothing was deleted.`,
      });
      opts.onDeleted?.();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not remove the folder', body: e.message }),
  });

  const actions: RowAction[] = folder ? [
    {
      label: 'New folder inside',
      icon: <FolderPlus size={16} />,
      hidden: !can('asset:upload'),
      onSelect: () => setAddingChild(true),
    },
    {
      label: 'Share folder',
      icon: <Share2 size={16} />,
      hidden: !can('share:create'),
      // A share link covers the whole tree, so the count that decides whether there is
      // anything to share is the deep one. Testing `assetCount` greyed this out on every
      // folder that keeps its files in subfolders — which is most of them once a library
      // has been organised.
      disabled: (folder.totalAssetCount ?? folder.assetCount) === 0,
      disabledReason: 'Nothing is filed in this folder or in any folder inside it yet.',
      onSelect: () => setSharing(true),
    },
    {
      label: 'Move folder',
      icon: <FolderInput size={16} />,
      hidden: !can('asset:edit'),
      onSelect: () => setMoving(true),
    },
    {
      label: 'Edit folder',
      icon: <Pencil size={16} />,
      hidden: !can('asset:edit'),
      onSelect: () => setEditing(true),
    },
    {
      label: 'Delete folder',
      icon: <Trash2 size={16} />,
      danger: true,
      hidden: !can('asset:delete'),
      onSelect: () => setDeleting(true),
    },
  ] : [];

  const dialogs = folder ? (
    <>
      {editing && <EditFolderDialog folder={folder} onClose={() => setEditing(false)} />}
      {sharing && <ShareDialog folder={folder} onClose={() => setSharing(false)} />}
      {moving && (
        <MoveDialog
          target={{ kind: 'folder', id: folder._id, name: folder.name, currentParentId: folder.parentId ?? null }}
          onClose={() => setMoving(false)}
        />
      )}
      {addingChild && (
        <NewFolderDialog
          parentId={folder._id}
          parentName={folder.name}
          onClose={() => setAddingChild(false)}
          onCreated={(f) => { setAddingChild(false); navigate(`/folders/${f._id}`); }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Remove “${folder.name}”?`}
          body={
            <>
              The {pluralise(folder.assetCount, 'file')} inside go back to the library — nothing is
              deleted — they are moved back to the library root, in Google Drive as well as here, and
              only the emptied folder goes to the bin. Any share link pointing at this folder stops
              resolving, since the grouping it described is gone.
            </>
          }
          confirmLabel="Remove folder"
          onConfirm={() => remove.mutate()}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  ) : null;

  return { actions, dialogs, openMove: () => setMoving(true), openNewChild: () => setAddingChild(true) };
}

// A folder row that carries its own action menu. Used by the folder list and by the
// "folders inside this one" section, so a subfolder offers exactly what a folder does.
function FolderRow({ folder, onOpen }: { folder: Folder; onOpen: () => void }) {
  const { actions, dialogs } = useFolderActions(folder);
  return (
    <>
      <div className="row-item" role="button" tabIndex={0} onClick={onOpen}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      >
        <span className="row-icon info"><FolderIcon size={20} /></span>
        <span className="row-main">
          <span className="row-title">{folder.name}</span>
          {/* Only set when this row came from a search, where a nested folder needs its
              parent named to be told apart from a sibling with the same name. */}
          {folder.parentName && <span className="row-sub">in {folder.parentName}</span>}
          {folder.description && <span className="row-sub">{folder.description}</span>}
          {(folder.tags.length > 0 || folder.needsAttention > 0 || folder.subfolderCount > 0) && (
            <span className="wrap-gap" style={{ marginTop: 5 }}>
              {folder.needsAttention > 0 && (
                <span className="tag" style={{ background: 'var(--danger-soft)', color: 'var(--danger-ink)', borderColor: 'var(--danger-edge)' }}>
                  {folder.needsAttention} need{folder.needsAttention === 1 ? 's' : ''} attention
                </span>
              )}
              {folder.subfolderCount > 0 && (
                <span className="tag">{pluralise(folder.subfolderCount, 'subfolder')}</span>
              )}
              {folder.tags.slice(0, 3).map((t) => <TagChip key={t} name={t} />)}
            </span>
          )}
        </span>
        <span className="row-meta">
          <span>{pluralise(folder.assetCount, 'file')}</span>
          <b>{bytes(folder.totalBytes)}</b>
        </span>
        <RowMenu actions={actions} label={`Actions for ${folder.name}`} />
      </div>
      {dialogs}
    </>
  );
}

export function FolderList() {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<FolderSort>('name');
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(q);
  const navigate = useNavigate();
  const can = useSession((s) => s.can);

  // Browsing shows the top level only; you go into a folder to see what is inside it, the
  // way the Drive itself behaves. Listing every folder flat made a subfolder appear twice —
  // once here and once inside its parent — and made moving one into another look like it
  // had done nothing at all.
  //
  // Searching drops the restriction: a name you half-remember is worth finding at any
  // depth, and each result carries its path.
  const { data, isLoading } = useQuery({
    queryKey: ['folders', debounced],
    queryFn: () => api<{ data: Folder[] }>(
      debounced ? `/folders?q=${encodeURIComponent(debounced)}` : '/folders?parentId=root',
    ),
  });

  const folders = useMemo(() => {
    const by: Record<FolderSort, (a: Folder, b: Folder) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      nameDesc: (a, b) => b.name.localeCompare(a.name),
      files: (a, b) => b.assetCount - a.assetCount || a.name.localeCompare(b.name),
      filesAsc: (a, b) => a.assetCount - b.assetCount || a.name.localeCompare(b.name),
      largest: (a, b) => b.totalBytes - a.totalBytes,
      newest: (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      oldest: (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
    };
    return [...(data?.data ?? [])].sort(by[sort] ?? by.name);
  }, [data, sort]);

  return (
    <div className="page stack-4">
      <div className="spread page-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <h1 className="t-h1">Folders</h1>
        {can('asset:upload') && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <FolderPlus size={15} /> New folder
          </button>
        )}
      </div>

      <div className="toolbar">
        <div className="searchbar" style={{ maxWidth: 400, flex: '1 1 260px' }}>
          <Search size={17} color="var(--ink-3)" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, description or tag" aria-label="Filter folders" />
        </div>
        <select className="select" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value as FolderSort)} aria-label="Sort folders">
          {FOLDER_SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {!isLoading && <span className="t-small">{pluralise(folders.length, 'folder')}</span>}
      </div>

      {isLoading ? (
        <RowSkeletons n={4} />
      ) : (data?.data.length ?? 0) === 0 ? (
        <EmptyState
          icon={<FolderIcon size={26} />}
          title={q ? 'No folder matches that' : 'No folders yet'}
          body={
            q
              ? 'Folders can be searched by name, description or tag. Try a shorter term.'
              : 'Group related files into a folder — or drop an entire folder on the upload screen and one will be made for you.'
          }
          action={can('asset:upload') ? <button className="btn btn-primary" onClick={() => setCreating(true)}>Create a folder</button> : undefined}
        />
      ) : (
        <div className="panel rows">
          {folders.map((f) => (
            <FolderRow key={f._id} folder={f} onOpen={() => navigate(`/folders/${f._id}`)} />
          ))}
        </div>
      )}

      {creating && <NewFolderDialog onClose={() => setCreating(false)} onCreated={(f) => navigate(`/folders/${f._id}`)} />}
    </div>
  );
}

export function FolderDetail() {
  const { id } = useParams();
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const [familyTab, setFamilyTab] = useState<'all' | Family>('all');
  const navigate = useNavigate();
  const can = useSession((s) => s.can);

  const { data, isLoading } = useQuery({
    queryKey: ['folder', id],
    queryFn: () => api<Folder>(`/folders/${id}`),
  });

  // The same four verbs the list offers, from the same place — plus "new folder inside",
  // which is how a folder tree gets built at all.
  const { actions, dialogs, openNewChild } = useFolderActions(data ?? null, {
    onDeleted: () => navigate('/folders'),
  });

  // "All" keeps the families in a deliberate order — audio, video, images, documents —
  // rather than whatever order the API happened to return, so the list reads the same way
  // every time it is opened.
  const visibleAssets = useMemo(() => {
    if (!data) return [];
    if (familyTab !== 'all') return data.assetsByFamily?.[familyTab] ?? [];
    return FAMILY_ORDER.flatMap((f) => data.assetsByFamily?.[f] ?? []);
  }, [data, familyTab]);

  if (isLoading || !data) {
    return <div className="page stack-3"><Skeleton h={32} w="34%" /><Skeleton h={96} /><RowSkeletons n={4} /></div>;
  }

  return (
    <div className="page stack-5">
      <div>
        <Link className="btn btn-ghost btn-sm" to="/folders" style={{ marginBottom: 12, paddingLeft: 0 }}>
          <ArrowLeft size={14} /> All folders
        </Link>

        <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div className="row-tight" style={{ marginBottom: 7 }}>
              <FolderIcon size={15} color="var(--info)" />
              <span className="eyebrow">Folder</span>
              {data.songTitle && (
                <span className="t-small">· <Link to={`/songs/${data.songId}`}>{data.songTitle}</Link></span>
              )}
            </div>
            <h1 className="t-h1">{data.name}</h1>
            {data.description && <p className="t-body" style={{ marginTop: 8, maxWidth: '62ch' }}>{data.description}</p>}

            {/* Breadcrumb. Drive folders nest, so "which Masters folder is this" is a real
                question that a bare name cannot answer. */}
            {data.breadcrumb && data.breadcrumb.length > 1 && (
              <div className="t-small" style={{ marginTop: 6 }}>
                {data.breadcrumb.map((crumb, i) => (
                  <span key={crumb._id}>
                    {i > 0 && ' / '}
                    {i === data.breadcrumb!.length - 1
                      ? crumb.name
                      : <Link to={`/folders/${crumb._id}`}>{crumb.name}</Link>}
                  </span>
                ))}
              </div>
            )}

            <div className="wrap-gap" style={{ marginTop: 11 }}>
              <span className="pill"><b>Files</b> · {data.assetCount}</span>
              {data.subfolderCount > 0 && <span className="pill"><b>Subfolders</b> · {data.subfolderCount}</span>}
              <span className="pill"><b>Size</b> · {bytes(data.totalBytes)}</span>
              <span className="pill"><b>Created</b> · {date(data.createdAt)} by {data.createdByName}</span>
              <span className="pill"><b>Updated</b> · {relative(data.updatedAt)}</span>
            </div>

            {data.tags.length > 0 && (
              <div className="wrap-gap" style={{ marginTop: 10 }}>
                {data.tags.map((t) => (
                  <Link key={t} to={`/?tags=${encodeURIComponent(t)}`} style={{ textDecoration: 'none' }}>
                    <TagChip name={t} />
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* The two things done most often stay as buttons; the rest live in the menu, so
              this bar does not grow a sixth control every time a verb is added. */}
          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            {can('asset:upload') && (
              <Link className="btn btn-spark" to={`/upload?folderId=${data._id}`}>
                <UploadCloud size={15} /> Add files here
              </Link>
            )}
            {can('asset:upload') && (
              <button className="btn btn-secondary" onClick={openNewChild}>
                <FolderPlus size={15} /> New folder inside
              </button>
            )}
            {data.driveWebViewLink && (
              <a className="btn btn-secondary" href={data.driveWebViewLink} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> Open in Drive
              </a>
            )}
            <RowMenu actions={actions} label={`Actions for ${data.name}`} />
          </div>
        </div>
      </div>

      {data.subfolders && data.subfolders.length > 0 && (
        <section>
          <h2 className="t-h2" style={{ marginBottom: 13 }}>Folders inside this one</h2>
          <div className="panel rows">
            {data.subfolders.map((sub) => (
              <FolderRow key={sub._id} folder={sub} onOpen={() => navigate(`/folders/${sub._id}`)} />
            ))}
          </div>
        </section>
      )}

      <div className="note indigo">
        <Info size={15} />
        <div>
          <b>This is a real Google Drive folder.</b> Every file listed here sits inside it in the
          Drive as well, so the two never disagree and anybody who opens drive.google.com finds
          what they expect. Moving files in and out re-parents them in Drive — no bytes are copied,
          which is why it is instant and completely safe.
        </div>
      </div>

      {data.needsAttention > 0 && (
        <div className="note danger">
          <AlertTriangle size={15} />
          <div>
            <b>{pluralise(data.needsAttention, 'file in here needs', 'files in here need')} attention.</b>{' '}
            Their stored object is missing or does not match the catalogue record.
          </div>
        </div>
      )}

      {data.assetCount === 0 ? (
        <EmptyState
          icon={<UploadCloud size={26} />}
          title="This folder is empty"
          body="Add files to it from here, or open any file and move it in from its details panel."
          action={can('asset:upload') ? <Link className="btn btn-spark" to={`/upload?folderId=${data._id}`}>Add the first file</Link> : undefined}
        />
      ) : (
        <section className="stack-3">
          {/* One tab per kind of file, rather than four stacked sections the reader has to
              scroll past. Only the kinds this folder actually holds get a tab, and each
              carries its count, so an empty tab is never offered. */}
          <div className="tabs" style={{ overflowX: 'auto' }}>
            {[{ id: 'all' as const, label: 'All', count: data.assetCount }]
              .concat(
                FAMILY_ORDER
                  .filter((f) => data.assetsByFamily?.[f]?.length)
                  .map((f) => ({ id: f as never, label: FAMILY_LABEL[f], count: data.assetsByFamily![f].length })),
              )
              .map((t) => (
                <button
                  key={t.id}
                  className={`tab ${familyTab === t.id ? 'on' : ''}`}
                  onClick={() => setFamilyTab(t.id)}
                >
                  {t.label}
                  <span className="badge-count" style={{ marginLeft: 7 }}>{t.count}</span>
                </button>
              ))}
          </div>

          <AssetList assets={visibleAssets} selectedId={openAsset} onOpen={(a) => setOpenAsset(a.assetId)} />
        </section>
      )}

      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
      {dialogs}
    </div>
  );
}

function EditFolderDialog({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const [name, setName] = useState(folder.name);
  const [description, setDescription] = useState(folder.description);
  const [tags, setTags] = useState<string[]>(folder.tags);
  const qc = useQueryClient();
  const toast = useToast();

  const save = useMutation({
    mutationFn: () => api(`/folders/${folder._id}`, { method: 'PATCH', body: { name, description, tags } }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({ kind: 'ok', title: 'Folder updated', body: 'Renamed here and in Google Drive. No file moved and no bytes were copied.' });
      onClose();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not save', body: e.message }),
  });

  return (
    <Modal
      title="Edit folder"
      subtitle="Name, description and tags. Tags can be added at any time, including now."
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            Save changes
          </button>
        </>
      }
    >
      <div className="stack-4">
        <div className="field">
          <label className="label">Folder name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <div className="hint">Renames the Google Drive folder too. Every file inside keeps its own name and its own Drive file id, so nothing breaks.</div>
        </div>
        <div className="field">
          <label className="label">Description</label>
          <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <TagPicker value={tags} onChange={setTags} label="Folder tags" />
      </div>
    </Modal>
  );
}
