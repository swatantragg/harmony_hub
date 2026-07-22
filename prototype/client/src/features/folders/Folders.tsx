import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Folder as FolderIcon, FolderPlus, ArrowLeft, UploadCloud, AlertTriangle,
  Pencil, Trash2, Info, Search, Music2, Film, Image as ImageIcon, FileText,
} from 'lucide-react';
import { api } from '../../lib/api';
import {
  CardSkeletons, ConfirmDialog, EmptyState, Modal, Skeleton, TagChip, useDebounced, useToast,
} from '../../components/ui';
import { AssetCard } from '../assets/AssetCard';
import { AssetDrawer } from '../assets/AssetDrawer';
import { NewFolderDialog } from './FolderPicker';
import { TagPicker } from '../upload/TagPicker';
import { bytes, date, pluralise, relative } from '../../lib/format';
import { useSession } from '../../app/session';
import type { Folder, Family } from '../../lib/types';

const FAMILY_ICON: Record<string, typeof Music2> = { Audio: Music2, Video: Film, Image: ImageIcon, Document: FileText };
const FAMILY_ORDER: Family[] = ['Audio', 'Video', 'Image', 'Document'];

export function FolderList() {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(q);
  const navigate = useNavigate();
  const can = useSession((s) => s.can);

  const { data, isLoading } = useQuery({
    queryKey: ['folders', debounced],
    queryFn: () => api<{ data: Folder[] }>(`/folders${debounced ? `?q=${encodeURIComponent(debounced)}` : ''}`),
  });

  return (
    <div className="page stack-4">
      <div className="spread page-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="t-h1">Folders</h1>
          <p className="t-body" style={{ maxWidth: '64ch', marginTop: 6 }}>
            A way to keep related files together — a launch kit, a shoot, a set of contracts.
            Storage keeps every file separately as it always has; a folder is a grouping in the
            catalogue, so it can be renamed, re-tagged or removed without touching a byte.
          </p>
        </div>
        {can('asset:upload') && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <FolderPlus size={15} /> New folder
          </button>
        )}
      </div>

      <div className="searchbar" style={{ maxWidth: 400 }}>
        <Search size={17} color="var(--ink-3)" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, description or tag" aria-label="Filter folders" />
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
          {data!.data.map((f) => (
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
                <div className="card-title" style={{ fontSize: 14.5 }}>{f.name}</div>
                {f.description && <div className="card-sub" style={{ whiteSpace: 'normal' }}>{f.description}</div>}
                {f.tags.length > 0 && (
                  <div className="wrap-gap" style={{ marginTop: 2 }}>
                    {f.tags.slice(0, 3).map((t) => <TagChip key={t} name={t} />)}
                  </div>
                )}
                <div className="card-foot">
                  <span className="t-small">{pluralise(f.assetCount, 'file')}</span>
                  <span className="t-small" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{bytes(f.totalBytes)}</span>
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
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const can = useSession((s) => s.can);

  const { data, isLoading } = useQuery({
    queryKey: ['folder', id],
    queryFn: () => api<Folder>(`/folders/${id}`),
  });

  const remove = useMutation({
    mutationFn: () => api<{ filesReleased: number }>(`/folders/${id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: 'Folder removed',
        body: `${pluralise(r.filesReleased, 'file')} went back to the library. Nothing was deleted from storage.`,
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

            <div className="wrap-gap" style={{ marginTop: 11 }}>
              <span className="pill"><b>Files</b> · {data.assetCount}</span>
              <span className="pill"><b>Size</b> · {bytes(data.totalBytes)}</span>
              <span className="pill"><b>Created</b> · {date(data.createdAt)} by {data.createdByName}</span>
              <span className="pill"><b>Updated</b> · {relative(data.updatedAt)}</span>
            </div>

            {data.tags.length > 0 && (
              <div className="wrap-gap" style={{ marginTop: 10 }}>
                {data.tags.map((t) => (
                  <Link key={t} to={`/search?tags=${encodeURIComponent(t)}`} style={{ textDecoration: 'none' }}>
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

      <div className="note indigo">
        <Info size={15} />
        <div>
          <b>These files are not stored together.</b> Each one lives in storage as its own
          object under its own key, exactly as it would without a folder. The grouping is
          recorded in the catalogue, which is why renaming this folder or moving files in and
          out of it is instant and completely safe.
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
        FAMILY_ORDER.filter((f) => data.assetsByFamily?.[f]?.length).map((family) => {
          const Icon = FAMILY_ICON[family];
          const assets = data.assetsByFamily![family];
          return (
            <section key={family}>
              <h2 className="t-h2 row-tight" style={{ marginBottom: 13 }}>
                <span
                  data-family={family}
                  style={{
                    width: 26, height: 26, borderRadius: 8,
                    background: 'linear-gradient(135deg, var(--fam-a), var(--fam-b))',
                    color: 'var(--fam-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Icon size={14} />
                </span>
                {family}
                <span className="t-small" style={{ fontWeight: 500 }}>{pluralise(assets.length, 'file')}</span>
              </h2>
              <div className="cards">
                {assets.map((a) => (
                  <AssetCard key={a.assetId} asset={a} selected={openAsset === a.assetId} onOpen={(x) => setOpenAsset(x.assetId)} />
                ))}
              </div>
            </section>
          );
        })
      )}

      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
      {editing && <EditFolderDialog folder={data} onClose={() => setEditing(false)} />}
      {deleting && (
        <ConfirmDialog
          title="Remove this folder?"
          body={
            <>
              The {pluralise(data.assetCount, 'file')} inside go back to the library — nothing is
              deleted, and no stored object is touched. Only the grouping disappears.
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
      toast({ kind: 'ok', title: 'Folder updated', body: 'No file was moved — renaming a folder never touches storage.' });
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
          <div className="hint">Renaming affects the catalogue only. Every file inside keeps its own name and its own stored location.</div>
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
