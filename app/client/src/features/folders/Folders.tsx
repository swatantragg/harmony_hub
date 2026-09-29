import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Folder as FolderIcon, FolderPlus, ArrowLeft, UploadCloud, AlertTriangle, FolderInput,
  Pencil, Trash2, Info, Search, Music2, Film, Image as ImageIcon, FileText, Share2, ExternalLink,
  Inbox, Loader2, X, Files, FolderTree, Tag as TagIcon,
} from 'lucide-react';
import { api } from '../../lib/api';
import {
  ConfirmDialog, EmptyState, Modal, NewFromDriveBadge, RowSkeletons, Skeleton, TagChip, useDebounced, useToast,
} from '../../components/ui';
import { RowMenu } from '../../components/RowMenu';
import { Select, pairs } from '../../components/Select';
import { LIST_PAGE_SIZES, Pagination, usePaged } from '../../components/Pagination';
import type { RowAction } from '../../components/RowMenu';
import { AssetList } from '../assets/AssetCard';
import { AssetDrawer } from '../assets/AssetDrawer';
import { NewFolderDialog } from './FolderPicker';
import { MoveDialog } from './MoveDialog';
import { ShareDialog } from '../shares/ShareDialog';
import { TagPicker } from '../upload/TagPicker';
import { bytes, date, pluralise, relative } from '../../lib/format';
import { isSameTag } from '../../lib/vocabulary';
import { useSession } from '../../app/session';
import type { Folder, Family } from '../../lib/types';

const FAMILY_ICON: Record<string, typeof Music2> = { Audio: Music2, Video: Film, Image: ImageIcon, Document: FileText };

/** Where a folder's tags go when it is edited: itself, its files, or every file below it. */
type TagScope = 'folder' | 'files' | 'tree';
const FAMILY_ORDER: Family[] = ['Audio', 'Video', 'Image', 'Document'];
const FAMILY_LABEL: Record<Family, string> = {
  Audio: 'Audio', Video: 'Videos', Image: 'Images', Document: 'Documents',
};

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

function useFolderActions(folder: Folder | null, opts: { onDeleted?: () => void } = {}) {
  const [editing, setEditing] = useState<TagScope | null>(null);
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
      onSelect: () => setEditing('folder'),
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
      {editing && <EditFolderDialog folder={folder} defaultScope={editing} onClose={() => setEditing(null)} />}
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

  return {
    actions, dialogs,
    openMove: () => setMoving(true),
    openNewChild: () => setAddingChild(true),
    openEdit: (scope: TagScope = 'folder') => setEditing(scope),
  };
}

function FolderRow({ folder, onOpen }: { folder: Folder; onOpen: () => void }) {
  const { actions, dialogs } = useFolderActions(folder);
  return (
    <>
      <div className="row-item" role="button" tabIndex={0} onClick={onOpen}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
        }}
      >
        <span className="row-icon info"><FolderIcon size={20} /></span>
        <span className="row-main">
          <span className="name-line">
            <span className="row-title">{folder.name}</span>
            {folder.awaitingReview && <NewFromDriveBadge />}
          </span>
          {folder.parentName && <span className="row-sub">in {folder.parentName}</span>}
          {folder.description && <span className="row-sub">{folder.description}</span>}
          {(folder.tags.length > 0 || folder.needsAttention > 0 || folder.subfolderCount > 0 || (folder.newFileCount ?? 0) > 0) && (
            <span className="wrap-gap" style={{ marginTop: 5 }}>
              {(folder.newFileCount ?? 0) > 0 && (
                <span className="tag new-tag" title="Files put straight into Google Drive that nobody has reviewed yet">
                  {pluralise(folder.newFileCount ?? 0, 'new file')} from Drive
                </span>
              )}
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

/**
 * "New" beside the Folders heading. Lit while folders added straight to Google
 * Drive are waiting for somebody to review and tag them, grey when none are —
 * and it says which, on hover or on a tap. Lit, it opens the one new folder, or
 * lists them when there are several.
 */
function NewFromDriveButton({ listing, onList }: { listing: boolean; onList: (on: boolean) => void }) {
  const navigate = useNavigate();
  const [tipOpen, setTipOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['folders', 'new-from-drive'],
    queryFn: () => api<{ data: Folder[]; total: number }>('/folders?review=pending'),
    staleTime: 30_000,
  });
  const count = data?.total ?? data?.data?.length ?? 0;

  // A phone has no hover, so a tap on the grey one shows the explanation instead.
  useEffect(() => {
    if (!tipOpen) return undefined;
    const t = setTimeout(() => setTipOpen(false), 5000);
    return () => clearTimeout(t);
  }, [tipOpen]);

  const tip = listing
    ? `Showing only the ${pluralise(count, 'folder')} added straight to Google Drive. Click to show every folder again.`
    : count === 0
      ? 'Nothing new from Google Drive. When somebody adds a folder straight to Drive — not through Upload here — this lights up until that folder has been reviewed and tagged.'
      : count === 1
        ? '1 folder was added straight to Google Drive and nobody has reviewed it yet. Click to open it.'
        : `${count} folders were added straight to Google Drive and nobody has reviewed them yet. Click to list them.`;

  const onClick = () => {
    if (listing) { onList(false); return; }
    if (count === 0) { setTipOpen((v) => !v); return; }
    const only = count === 1 ? data?.data?.[0] : null;
    if (only) { navigate(`/folders/${only._id}`); return; }
    onList(true);
  };

  return (
    <span className={`tip ${tipOpen ? 'open' : ''}`}>
      <button
        type="button"
        className={`new-pill ${count > 0 ? 'on' : ''}`}
        aria-disabled={count === 0 && !listing}
        aria-pressed={listing}
        aria-describedby="new-from-drive-tip"
        onClick={onClick}
        onBlur={() => setTipOpen(false)}
      >
        New
        {count > 0 && <span className="new-pill-count">{count}</span>}
        {listing && <X size={12} aria-hidden />}
      </button>
      <span className="tip-bubble" role="tooltip" id="new-from-drive-tip">{tip}</span>
    </span>
  );
}

export function FolderList() {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<FolderSort>('name');
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();
  const debounced = useDebounced(q);
  const navigate = useNavigate();
  const can = useSession((s) => s.can);

  // Folders put straight into Drive and not reviewed yet, wherever they sit —
  // so this one lists every level, not just the top.
  const pendingOnly = params.get('review') === 'pending';
  const setPending = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set('review', 'pending');
    else next.delete('review');
    setParams(next, { replace: true });
  };

  const { data, isLoading } = useQuery({
    queryKey: ['folders', debounced, pendingOnly],
    queryFn: () => api<{ data: Folder[] }>(
      pendingOnly
        ? `/folders?review=pending${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`
        : debounced ? `/folders?q=${encodeURIComponent(debounced)}` : '/folders?parentId=root',
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

  const paged = usePaged(folders, { initialSize: 24, resetKey: `${sort}|${debounced}|${pendingOnly}` });

  return (
    <div className="page stack-4">
      <div className="spread page-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div className="row tip-host" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <h1 className="t-h1">Folders</h1>
          <NewFromDriveButton listing={pendingOnly} onList={setPending} />
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
        <Select
          style={{ width: 'auto' }}
          value={sort}
          onChange={(v) => setSort(v as FolderSort)}
          options={pairs(FOLDER_SORTS)}
          ariaLabel="Sort folders"
        />
        {!isLoading && <span className="t-small">{pluralise(folders.length, 'folder')}</span>}
      </div>

      {pendingOnly && (
        <div className="note">
          <Inbox size={15} />
          <div className="grow">
            <b>Only folders added straight to Google Drive</b> that nobody has reviewed yet, at every
            level. Open one to tag it — and its files, in one go.
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setPending(false)}>Show every folder</button>
        </div>
      )}

      {isLoading ? (
        <RowSkeletons n={4} />
      ) : (data?.data.length ?? 0) === 0 ? (
        <EmptyState
          icon={<FolderIcon size={26} />}
          title={q ? 'No folder matches that' : pendingOnly ? 'Nothing new from Drive' : 'No folders yet'}
          body={
            q
              ? 'Folders can be searched by name, description or tag. Try a shorter term.'
              : pendingOnly
                ? 'Every folder added straight to Google Drive has been reviewed.'
                : 'Group related files into a folder — or drop an entire folder on the upload screen and one will be made for you.'
          }
          action={can('asset:upload') ? <button className="btn btn-primary" onClick={() => setCreating(true)}>Create a folder</button> : undefined}
        />
      ) : (
        <>
          <div className="panel rows">
            {paged.rows.map((f) => (
              <FolderRow key={f._id} folder={f} onOpen={() => navigate(`/folders/${f._id}`)} />
            ))}
          </div>
          <Pagination {...paged.bind} noun="folder" sizes={LIST_PAGE_SIZES} />
        </>
      )}

      {creating && <NewFolderDialog onClose={() => setCreating(false)} onCreated={(f) => navigate(`/folders/${f._id}`)} />}
    </div>
  );
}

type FolderTab = 'all' | 'folders' | Family;

export function FolderDetail() {
  const { id } = useParams();
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const [tab, setTab] = useState<FolderTab>('all');
  const navigate = useNavigate();
  const can = useSession((s) => s.can);

  const { data, isLoading } = useQuery({
    queryKey: ['folder', id],
    queryFn: () => api<Folder>(`/folders/${id}`),
  });

  const { actions, dialogs, openNewChild, openEdit } = useFolderActions(data ?? null, {
    onDeleted: () => navigate('/folders'),
  });
  const qc = useQueryClient();
  const toast = useToast();

  const review = useMutation({
    mutationFn: (files: boolean) =>
      api<{ folderReviewed: boolean; filesReviewed: number }>(`/folders/${id}/review`, { method: 'POST', body: { files } }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      const parts = [
        ...(r.folderReviewed ? ['the folder'] : []),
        ...(r.filesReviewed ? [pluralise(r.filesReviewed, 'file')] : []),
      ];
      toast({
        kind: 'ok',
        title: 'Marked as reviewed',
        body: parts.length ? `The New badge is off ${parts.join(' and ')}. Nothing else changed.` : 'Nothing here was still waiting.',
      });
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not mark them reviewed', body: e.message }),
  });

  const visibleAssets = useMemo(() => {
    if (!data || tab === 'folders') return [];
    if (tab !== 'all') return data.assetsByFamily?.[tab] ?? [];
    return FAMILY_ORDER.flatMap((f) => data.assetsByFamily?.[f] ?? []);
  }, [data, tab]);

  const subfolderRows = useMemo(() => data?.subfolders ?? [], [data]);

  // One page position per tab, reset on every switch: page four of the images
  // tab means nothing once you are looking at documents.
  const pagedAssets = usePaged(visibleAssets, { initialSize: 24, resetKey: `${id}|${tab}` });
  const pagedSubfolders = usePaged(subfolderRows, { initialSize: 24, resetKey: String(id) });

  if (isLoading || !data) {
    return <div className="page stack-3"><Skeleton h={32} w="34%" /><Skeleton h={96} /><RowSkeletons n={4} /></div>;
  }

  const subfolders = data.subfolders ?? [];
  const newFiles = (data.assets ?? []).filter((a) => a.awaitingReview).length;

  const tabs: { id: FolderTab; label: string; count: number }[] = [
    ...(data.assetCount > 0 ? [{ id: 'all' as FolderTab, label: 'All', count: data.assetCount }] : []),
    ...(subfolders.length > 0 ? [{ id: 'folders' as FolderTab, label: 'Folders', count: subfolders.length }] : []),
    ...FAMILY_ORDER
      .filter((f) => data.assetsByFamily?.[f]?.length)
      .map((f) => ({ id: f as FolderTab, label: FAMILY_LABEL[f], count: data.assetsByFamily![f].length })),
  ];

  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id;

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
              {data.awaitingReview && <NewFromDriveBadge long />}
              {data.songTitle && (
                <span className="t-small">· <Link to={`/songs/${data.songId}`}>{data.songTitle}</Link></span>
              )}
            </div>
            <h1 className="t-h1">{data.name}</h1>
            {data.description && <p className="t-body" style={{ marginTop: 8, maxWidth: '62ch' }}>{data.description}</p>}

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

      <div className="note indigo">
        <Info size={15} />
        <div>
          <b>This is a real Google Drive folder.</b> Every file listed here sits inside it in the
          Drive as well, so the two never disagree and anybody who opens drive.google.com finds
          what they expect. Moving files in and out re-parents them in Drive — no bytes are copied,
          which is why it is instant and completely safe.
        </div>
      </div>

      {(data.awaitingReview || newFiles > 0) && (
        <div className="note">
          <Inbox size={15} />
          <div className="grow">
            <b>
              {data.awaitingReview
                ? 'New — this folder was added straight to Google Drive.'
                : `${pluralise(newFiles, 'file in here was', 'files in here were')} added straight to Google Drive.`}
            </b>{' '}
            {data.awaitingReview && newFiles > 0 && `So ${newFiles === 1 ? 'was 1 file' : `were ${newFiles} files`} inside it. `}
            {data.awaitingReview && !newFiles
              ? 'Nobody has reviewed it yet and it has no real tags. Tag it, or mark it reviewed if it is right as it is.'
              : 'Nobody has reviewed them yet — types were guessed and there are no real tags. Open anything marked New to tag it, or mark them reviewed if they are right as they are.'}
            {can('asset:edit') && (
              <div className="row-tight" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                {data.awaitingReview && (
                  <button className="btn btn-primary btn-sm" onClick={() => openEdit(newFiles > 0 ? 'files' : 'folder')}>
                    <Pencil size={13} /> {newFiles > 0 ? 'Tag this folder and its files' : 'Tag this folder'}
                  </button>
                )}
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={review.isPending}
                  onClick={() => review.mutate(newFiles > 0)}
                >
                  {review.isPending && <Loader2 size={13} />}
                  {data.awaitingReview && newFiles > 0
                    ? `Mark the folder and its ${pluralise(newFiles, 'new file')} reviewed`
                    : newFiles > 0 ? `Mark ${newFiles === 1 ? 'the file' : `all ${newFiles}`} reviewed` : 'Mark reviewed'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {data.needsAttention > 0 && (
        <div className="note danger">
          <AlertTriangle size={15} />
          <div>
            <b>{pluralise(data.needsAttention, 'file in here needs', 'files in here need')} attention.</b>{' '}
            Their stored object is missing or does not match the catalogue record.
          </div>
        </div>
      )}

      {tabs.length === 0 ? (
        <EmptyState
          icon={<UploadCloud size={26} />}
          title="This folder is empty"
          body="Add files to it from here, make a folder inside it, or open any file and move it in from its details panel."
          action={can('asset:upload') ? <Link className="btn btn-spark" to={`/upload?folderId=${data._id}`}>Add the first file</Link> : undefined}
        />
      ) : (
        <section className="stack-3">
          <div className="tabs" style={{ overflowX: 'auto' }}>
            {tabs.map((t) => (
              <button
                key={t.id}
                className={`tab ${active === t.id ? 'on' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                <span className="badge-count" style={{ marginLeft: 7 }}>{t.count}</span>
              </button>
            ))}
          </div>

          {active === 'folders' ? (
            <>
              <div className="panel rows">
                {pagedSubfolders.rows.map((sub) => (
                  <FolderRow key={sub._id} folder={sub} onOpen={() => navigate(`/folders/${sub._id}`)} />
                ))}
              </div>
              <Pagination {...pagedSubfolders.bind} noun="folder" sizes={LIST_PAGE_SIZES} />
            </>
          ) : (
            <>
              <AssetList assets={pagedAssets.rows} selectedId={openAsset} onOpen={(a) => setOpenAsset(a.assetId)} />
              <Pagination {...pagedAssets.bind} noun="file" sizes={LIST_PAGE_SIZES} />
            </>
          )}
        </section>
      )}
      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
      {dialogs}
    </div>
  );
}
/**
 * Name, description and tags — and, for the tags, where they go. A folder's
 * tags used to stay on the folder, so tagging a folder dropped into Drive left
 * every file in it untagged. Now the folder can hand its tags to the files in
 * it, or to every file below it.
 */
function EditFolderDialog({
  folder, onClose, defaultScope = 'folder',
}: { folder: Folder; onClose: () => void; defaultScope?: TagScope }) {
  const [name, setName] = useState(folder.name);
  const [description, setDescription] = useState(folder.description);
  const [tags, setTags] = useState<string[]>(folder.tags);

  const direct = folder.assetCount ?? 0;
  const deep = Math.max(direct, folder.totalAssetCount ?? direct);
  const reachesDeeper = folder.subfolderCount > 0 && deep > direct;
  const scopes: { value: TagScope; label: string; hint: string; icon: typeof FolderIcon }[] = [
    { value: 'folder', label: 'Only this folder', hint: 'Its files keep exactly the tags they have now.', icon: FolderIcon },
    ...(direct > 0 ? [{
      value: 'files' as TagScope,
      label: `This folder and the ${pluralise(direct, 'file')} in it`,
      hint: 'Every file gets the folder’s tags. A tag you take off the folder comes off them too; tags a file has of its own stay.',
      icon: Files,
    }] : []),
    ...(reachesDeeper ? [{
      value: 'tree' as TagScope,
      label: direct > 0
        ? `…and every file in its subfolders — ${deep} in all`
        : `This folder and the ${pluralise(deep, 'file')} in its subfolders`,
      hint: 'The same, reaching down through every folder inside this one.',
      icon: FolderTree,
    }] : []),
  ];
  const [scope, setScope] = useState<TagScope>(
    scopes.some((o) => o.value === defaultScope) ? defaultScope : 'folder',
  );
  const reach = scope === 'tree' ? deep : direct;
  const dropped = folder.tags.filter((t) => !tags.some((x) => isSameTag(x, t)));

  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api<Folder & { filesTagged: number }>(`/folders/${folder._id}`, {
      method: 'PATCH',
      body: { name, description, tags, tagScope: scope },
    }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: 'Folder updated',
        body: scope === 'folder'
          ? 'Renamed here and in Google Drive. No file moved and no bytes were copied.'
          : r.filesTagged
            ? `The tags went onto ${pluralise(r.filesTagged, 'file')} in it as well.`
            : 'Its files already carried these tags.',
      });
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

        {scopes.length > 1 ? (
          <div className="field">
            <label className="label" id="tag-scope-label">Where do these tags go?</label>
            <div className="stack-2" role="radiogroup" aria-labelledby="tag-scope-label">
              {scopes.map(({ value, label, hint, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={scope === value}
                  className={`choice ${scope === value ? 'on' : ''}`}
                  onClick={() => setScope(value)}
                >
                  <span className="choice-mark"><Icon size={15} /></span>
                  <span>
                    <span className="label">{label}</span>
                    <span className="hint">{hint}</span>
                  </span>
                </button>
              ))}
            </div>
            {scope !== 'folder' && (
              <div className="bulk-verdict set" aria-live="polite">
                <TagIcon size={14} aria-hidden />
                <span>
                  {tags.length > 0 ? (
                    <>
                      Each of the {pluralise(reach, 'file')} gets{' '}
                      <span className="wrap-gap" style={{ display: 'inline-flex', verticalAlign: 'middle', gap: 6 }}>
                        {tags.map((t) => <TagChip key={t} name={t} />)}
                      </span>
                    </>
                  ) : (
                    <>The folder has no tags to hand on.</>
                  )}
                  {dropped.length > 0 && <> — and loses {dropped.map((t) => `“${t}”`).join(', ')}</>}
                  .
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="hint">There are no files in this folder yet, so the tags stay on the folder.</div>
        )}
      </div>
    </Modal>
  );
}