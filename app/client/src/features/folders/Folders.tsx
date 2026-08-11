import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Folder as FolderIcon, FolderPlus, ArrowLeft, UploadCloud, AlertTriangle,
  Pencil, Trash2, Info, Search, Music2, Film, Image as ImageIcon, FileText, Share2, ExternalLink,
} from 'lucide-react';
import { api } from '../../lib/api';
import {
  CardSkeletons, ConfirmDialog, EmptyState, Modal, Skeleton, TagChip, useDebounced, useToast,
} from '../../components/ui';
import { AssetList } from '../assets/AssetCard';
import { AssetDrawer } from '../assets/AssetDrawer';
import { NewFolderDialog } from './FolderPicker';
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

export function FolderList() {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<FolderSort>('name');
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(q);
  const navigate = useNavigate();
  const can = useSession((s) => s.can);

  const { data, isLoading } = useQuery({
    queryKey: ['folders', debounced],
    queryFn: () => api<{ data: Folder[] }>(`/folders${debounced ? `?q=${encodeURIComponent(debounced)}` : ''}`),
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
        <div>
          <h1 className="t-h1">Folders</h1>
          <p className="t-body" style={{ maxWidth: '64ch', marginTop: 6 }}>
            A way to keep related files together — a launch kit, a shoot, a set of contracts.
            These are real Google Drive folders: open the Drive and the library is laid out exactly
            as it is here. Drive moves and renames by updating an index entry, so grouping, renaming
            and reorganising never copy a byte, however large the files are.
          </p>
        </div>
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
        <CardSkeletons n={4} />
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
        <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {folders.map((f) => (
            <button key={f._id} className="card" onClick={() => navigate(`/folders/${f._id}`)}>
              <div
                className="card-art"
                data-family="Document"
                style={{ height: 84, alignItems: 'center', justifyContent: 'center' }}
              >
                <span
                  style={{
                    width: 44, height: 44, borderRadius: 13, background: 'var(--wash-chip)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--info)',
                  }}
                >
                  <FolderIcon size={21} />
                </span>
                {f.needsAttention > 0 && (
                  <span className="type-badge" style={{ background: 'var(--danger-soft)', color: 'var(--danger-ink)' }}>
                    {f.needsAttention} need attention
                  </span>
                )}
              </div>
              <div className="card-body">
                <div className="card-title" style={{ fontSize: 16.5 }}>{f.name}</div>
                {f.description && <div className="card-sub" style={{ whiteSpace: 'normal' }}>{f.description}</div>}
                {f.tags.length > 0 && (
                  <div className="wrap-gap" style={{ marginTop: 2 }}>
                    {f.tags.slice(0, 3).map((t) => <TagChip key={t} name={t} />)}
                  </div>
                )}
                <div className="card-foot">
                  <span className="t-small">{pluralise(f.assetCount, 'file')}</span>
                  <span className="t-small" style={{ fontFamily: 'var(--mono)', fontSize: 13.5 }}>{bytes(f.totalBytes)}</span>
                </div>
              </div>
            </button>
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
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const can = useSession((s) => s.can);

  const { data, isLoading } = useQuery({
    queryKey: ['folder', id],
    queryFn: () => api<Folder>(`/folders/${id}`),
  });

  // "All" keeps the families in a deliberate order — audio, video, images, documents —
  // rather than whatever order the API happened to return, so the list reads the same way
  // every time it is opened.
  const visibleAssets = useMemo(() => {
    if (!data) return [];
    if (familyTab !== 'all') return data.assetsByFamily?.[familyTab] ?? [];
    return FAMILY_ORDER.flatMap((f) => data.assetsByFamily?.[f] ?? []);
  }, [data, familyTab]);

  const remove = useMutation({
    mutationFn: () => api<{ filesReleased: number }>(`/folders/${id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: 'Folder removed',
        body: `${pluralise(r.filesReleased, 'file')} moved back to the library root, in Google Drive too. Nothing was deleted.`,
      });
      navigate('/folders');
    },
  });

  if (isLoading || !data) {
    return <div className="page stack-3"><Skeleton h={32} w="34%" /><Skeleton h={96} /><CardSkeletons n={4} /></div>;
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

          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            {can('asset:upload') && (
              <Link className="btn btn-spark" to={`/upload?folderId=${data._id}`}>
                <UploadCloud size={15} /> Add files here
              </Link>
            )}
            {data.driveWebViewLink && (
              <a className="btn btn-secondary" href={data.driveWebViewLink} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> Open in Drive
              </a>
            )}
            {can('share:create') && (
              <button className="btn btn-secondary" onClick={() => setSharing(true)} disabled={data.assetCount === 0}>
                <Share2 size={14} /> Share folder
              </button>
            )}
            {can('asset:edit') && (
              <button className="btn btn-secondary" onClick={() => setEditing(true)}>
                <Pencil size={14} /> Edit folder
              </button>
            )}
            {can('asset:delete') && (
              <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => setDeleting(true)}>
                <Trash2 size={14} /> Remove folder
              </button>
            )}
          </div>
        </div>
      </div>

      {data.subfolders && data.subfolders.length > 0 && (
        <section>
          <h2 className="t-h2" style={{ marginBottom: 13 }}>Folders inside this one</h2>
          <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
            {data.subfolders.map((sub) => (
              <button key={sub._id} className="card" onClick={() => navigate(`/folders/${sub._id}`)}>
                <div className="card-body">
                  <div className="card-title row-tight" style={{ fontSize: 16 }}>
                    <FolderIcon size={15} color="var(--info)" /> {sub.name}
                  </div>
                  <div className="card-foot">
                    <span className="t-small">{pluralise(sub.assetCount, 'file')}</span>
                    <span className="t-small" style={{ fontFamily: 'var(--mono)', fontSize: 13.5 }}>{bytes(sub.totalBytes)}</span>
                  </div>
                </div>
              </button>
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
      {editing && <EditFolderDialog folder={data} onClose={() => setEditing(false)} />}
      {sharing && <ShareDialog folder={data} onClose={() => setSharing(false)} />}
      {deleting && (
        <ConfirmDialog
          title="Remove this folder?"
          body={
            <>
              The {pluralise(data.assetCount, 'file')} inside go back to the library — nothing is
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
