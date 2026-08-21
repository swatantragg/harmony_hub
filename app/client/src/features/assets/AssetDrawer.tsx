import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Download, Pencil, RefreshCw, Share2, Trash2, X, ShieldCheck, Archive,
  History, Info, ScrollText, Loader2, ExternalLink, Undo2, Folder as FolderIcon, FolderInput,
} from 'lucide-react';
import {
  AvailabilityBadge, ConfirmDialog, CopyButton, Drawer, Skeleton, TagChip, useToast,
} from '../../components/ui';
import { api } from '../../lib/api';
import { bytes, date, duration, relative } from '../../lib/format';
import { ACTION_COPY, STATUS_COPY } from '../../lib/assetTypes';
import type { Asset } from '../../lib/types';
import { useSession } from '../../app/session';
import { RenameDialog } from './RenameDialog';
import { AssetPreview } from './AssetPreview';
import { ShareDialog } from '../shares/ShareDialog';
import { MoveDialog } from '../folders/MoveDialog';
import { EditMetadataDialog } from './EditMetadataDialog';

type Tab = 'overview' | 'storage' | 'versions' | 'activity';

export function AssetDrawer({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [renaming, setRenaming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [purging, setPurging] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const can = useSession((s) => s.can);

  const { data: asset, isLoading } = useQuery({
    queryKey: ['asset', assetId],
    queryFn: () => api<Asset>(`/assets/${assetId}`),
    // Poll while a restore from the Drive bin is in flight so the badge settles on its own.
    refetchInterval: (q) => ((q.state.data as Asset | undefined)?.availability.status === 'RESTORING' ? 3000 : false),
  });

  const verify = useMutation({
    mutationFn: () => api<{ status: string; detail: string | null }>(`/assets/${assetId}/verify`, { method: 'POST' }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      const copy = STATUS_COPY[r.status as keyof typeof STATUS_COPY];
      toast({
        kind: r.status === 'AVAILABLE' ? 'ok' : r.status === 'MISSING' ? 'danger' : 'warn',
        title: `Checked against storage — ${copy.label}`,
        body: r.detail || copy.meaning,
      });
    },
  });

  const download = useMutation({
    mutationFn: () => api<{ url: string; downloadAs: string }>(`/assets/${assetId}/download`, { method: 'POST' }),
    onSuccess: (r) => {
      const a = document.createElement('a');
      a.href = r.url;
      a.download = r.downloadAs;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast({ kind: 'ok', title: 'Download started', body: `Signed for 5 minutes, straight from storage as ${r.downloadAs}.` });
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Download blocked', body: e.message }),
  });

  // Pulling a file back out of the Google Drive bin. Instant and free — but on a 30-day
  // clock, which the copy says plainly.
  const restore = useMutation({
    mutationFn: () => api(`/assets/${assetId}/restore`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({ kind: 'ok', title: 'Restored', body: 'Out of the Google Drive bin and downloadable again.' });
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not restore', body: e.message }),
  });

  const softDelete = useMutation({
    mutationFn: () => api(`/assets/${assetId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({ kind: 'ok', title: 'Moved to the bin', body: 'Hidden here and trashed in Google Drive. Recoverable from either side for 30 days.' });
      onClose();
    },
  });

  const purge = useMutation({
    mutationFn: () => api(`/assets/${assetId}/purge`, { method: 'DELETE', body: { confirm: asset?.displayName } }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({ kind: 'warn', title: 'Purged permanently', body: 'Every stored version was destroyed. This cannot be undone.' });
      onClose();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Purge failed', body: e.message }),
  });

  if (isLoading || !asset) {
    return (
      <Drawer onClose={onClose}>
        <div className="drawer-body stack-3">
          <Skeleton h={26} w="65%" /><Skeleton h={190} /><Skeleton h={15} /><Skeleton h={15} w="80%" />
        </div>
      </Drawer>
    );
  }

  const status = asset.availability.status;
  const copy = STATUS_COPY[status];
  // Downloading is blocked only when the object is confirmed absent or sitting in archive.
  // An unverified file downloads normally — the API re-checks storage before signing anyway.
  const canDownload = can('asset:download') && ['AVAILABLE', 'MISMATCH', 'UNVERIFIED'].includes(status);

  return (
    <>
      <Drawer onClose={onClose}>
        <div className="drawer-head">
          <div className="spread" style={{ alignItems: 'flex-start' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row-tight" style={{ marginBottom: 6 }}>
                <span className="eyebrow">{asset.type}</span>
                <span className={`vchip ${asset.isCurrent ? 'current' : ''}`}>{asset.version}</span>
              </div>
              <h2 className="t-h2" style={{ wordBreak: 'break-word' }}>{asset.displayName}</h2>
              <div className="t-small" style={{ marginTop: 3 }}>
                {asset.songId ? (
                  <>
                    <Link to={`/songs/${asset.songId}`} onClick={onClose}>{asset.songTitle}</Link>
                    {' · '}
                    <Link to={`/artists/${asset.artistId}`} onClick={onClose}>{asset.artistName}</Link>
                  </>
                ) : (
                  <span className="muted">Not tied to a song</span>
                )}
                {asset.folderName && (
                  <>
                    {' · '}
                    <Link to={`/folders/${asset.folderId}`} onClick={onClose}>
                      <FolderIcon size={11} style={{ verticalAlign: -1 }} /> {asset.folderName}
                    </Link>
                  </>
                )}
              </div>
            </div>
            <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><X size={17} /></button>
          </div>

          <div className="tabs" style={{ marginTop: 14, borderBottom: 'none' }}>
            {([
              ['overview', 'Overview', Info],
              ['storage', 'Storage', ShieldCheck],
              ['versions', 'Versions', History],
              ['activity', 'Activity', ScrollText],
            ] as const).map(([key, label, Icon]) => (
              <button key={key} className={`tab ${tab === key ? 'on' : ''}`} onClick={() => setTab(key)}>
                <span className="row-tight"><Icon size={13} /> {label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="drawer-body stack-4">
          {/* The status explanation sits above every tab — it is the first thing to read. */}
          <div className="panel" data-status={status} style={{ borderColor: 'var(--st)', background: 'var(--st-soft)', boxShadow: 'none' }}>
            <div className="panel-body" style={{ padding: 15 }}>
              <div className="spread" style={{ marginBottom: 7 }}>
                <AvailabilityBadge status={status} size="lg" />
                <button className="btn btn-secondary btn-sm" disabled={verify.isPending} onClick={() => verify.mutate()}>
                  {verify.isPending ? <Loader2 size={13} /> : <RefreshCw size={13} />} Verify now
                </button>
              </div>
              <div className="t-small" style={{ color: 'var(--st-ink)', fontWeight: 500 }}>
                {asset.availability.detail || copy.meaning}
              </div>
              <div className="t-small" style={{ marginTop: 4, fontSize: 14 }}>
                {copy.next} · Last checked {relative(asset.availability.lastCheckedAt)}
                {asset.availability.checkMethod ? ` (${asset.availability.checkMethod === 'HEAD_OBJECT' ? 'live probe' : 'nightly reconciliation'})` : ''}
              </div>
            </div>
          </div>

          {tab === 'overview' && (
            <>
              <AssetPreview asset={asset} />

              {asset.description && <p className="t-body" style={{ margin: 0 }}>{asset.description}</p>}

              {asset.tags.length > 0 && (
                <div>
                  <div className="eyebrow" style={{ marginBottom: 7 }}>Tags</div>
                  <div className="wrap-gap">{asset.tags.map((t) => <TagChip key={t} name={t} />)}</div>
                </div>
              )}

              <dl style={{ margin: 0 }}>
                <div className="def"><dt>Type</dt><dd>{asset.type} <span className="muted">· {asset.family}</span></dd></div>
                <div className="def"><dt>Size</dt><dd>{bytes(asset.drive.sizeBytes)}</dd></div>
                {asset.durationSec != null && <div className="def"><dt>Duration</dt><dd>{duration(asset.durationSec)}</dd></div>}
                {asset.dimensions && <div className="def"><dt>Dimensions</dt><dd>{asset.dimensions}</dd></div>}
                {asset.format && <div className="def"><dt>Format</dt><dd>{asset.format}</dd></div>}
                <div className="def">
                  <dt>Folder</dt>
                  <dd>
                    {asset.folderName ? (
                      <Link to={`/folders/${asset.folderId}`} onClick={onClose}>{asset.folderName}</Link>
                    ) : (
                      <span className="muted">Not in a folder</span>
                    )}
                    <div className="hint">
                      A real Google Drive folder. Moving the file between folders re-parents it in
                      Drive without copying a byte, however large it is.
                    </div>
                  </dd>
                </div>
                <div className="def"><dt>Uploaded</dt><dd>{date(asset.createdAt, true)} by {asset.uploadedByName}</dd></div>
                {asset.renamedAt && <div className="def"><dt>Last renamed</dt><dd>{relative(asset.renamedAt)}</dd></div>}
                <div className="def">
                  <dt>Original filename</dt>
                  <dd><span className="t-mono">{asset.originalName}</span>
                    <div className="hint">Recorded once at upload and never changed — a forensic record of what arrived.</div>
                  </dd>
                </div>
              </dl>
            </>
          )}

          {tab === 'storage' && (
            <>
              <div className="note indigo">
                <Info size={15} />
                <div>
                  <b>Where the bytes actually live.</b> Google Drive addresses a file by an immutable
                  id, and its name is ordinary metadata — which is why renaming here renames it in
                  Drive too, instantly, without copying anything or breaking a single share link.
                </div>
              </div>

              {asset.isLinkedCopy && (
                <div className="note neutral">
                  <Info size={15} />
                  <div>
                    <b>This entry shares its file with another.</b> De-duplication pointed both at one
                    Drive file, so it appears in two places and occupies space once. Deleting this
                    entry will not remove the bytes while the other still points at them.
                  </div>
                </div>
              )}

              <dl style={{ margin: 0 }}>
                <div className="def">
                  <dt>Drive file id</dt>
                  <dd>
                    <div className="keytext">{asset.drive.fileId}</div>
                    <div style={{ marginTop: 5 }}>
                      <CopyButton value={asset.drive.fileId} label="Copy id" />
                      {asset.drive.webViewLink && (
                        <a
                          className="btn btn-ghost btn-sm"
                          href={asset.drive.webViewLink}
                          target="_blank"
                          rel="noreferrer"
                          style={{ marginLeft: 6 }}
                        >
                          <ExternalLink size={13} /> Open in Drive
                        </a>
                      )}
                    </div>
                  </dd>
                </div>
                <div className="def">
                  <dt>Path in Drive</dt>
                  <dd><span className="t-mono">{asset.drive.path ?? asset.drive.name}</span></dd>
                </div>
                <div className="def">
                  <dt>Drive</dt>
                  <dd className="t-mono">{asset.drive.driveId ? `Shared Drive ${asset.drive.driveId}` : 'My Drive'}</dd>
                </div>
                <div className="def"><dt>Revision</dt><dd className="t-mono">{asset.drive.revisionId ?? '—'}</dd></div>
                {asset.drive.sha256 && (
                  <div className="def">
                    <dt>SHA-256</dt>
                    <dd>
                      <span className="t-mono" style={{ wordBreak: 'break-all' }}>{asset.drive.sha256}</span>
                      <div className="hint">
                        Computed by Google on arrival, not by us. It is what makes duplicate detection
                        exact rather than a guess.
                      </div>
                    </dd>
                  </div>
                )}
                {asset.drive.md5 && (
                  <div className="def">
                    <dt>MD5</dt>
                    <dd><span className="t-mono" style={{ wordBreak: 'break-all' }}>{asset.drive.md5}</span></dd>
                  </div>
                )}
                <div className="def"><dt>Content type</dt><dd className="t-mono">{asset.drive.mimeType}</dd></div>
                <div className="def"><dt>In Drive since</dt><dd>{date(asset.drive.uploadedAt, true)}</dd></div>
                {asset.drive.modifiedAt && (
                  <div className="def"><dt>Last modified in Drive</dt><dd>{relative(asset.drive.modifiedAt)}</dd></div>
                )}
                {asset.drive.trashed && (
                  <div className="def">
                    <dt>Trash</dt>
                    <dd><span className="tag danger">In the Google Drive bin</span></dd>
                  </div>
                )}
              </dl>

              {asset.shares && asset.shares.length > 0 && (
                <div>
                  <div className="eyebrow" style={{ marginBottom: 8 }}>Active share links</div>
                  <div className="stack-2">
                    {asset.shares.map((s) => (
                      <div key={s._id} className="panel" style={{ boxShadow: 'none' }}>
                        <div className="panel-body spread" style={{ padding: 12 }}>
                          <div className="t-small">
                            {s.downloadCount}{s.maxDownloads ? ` / ${s.maxDownloads}` : ''} downloads · expires {relative(s.expiresAt)}
                          </div>
                          <CopyButton value={s.url} label="Copy link" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'versions' && (
            <>
              <div className="note neutral">
                <History size={15} />
                <div>
                  Each version is its own file with its own history — nothing is overwritten. Upload a
                  new version from the song page to add to this lineage.
                </div>
              </div>
              <div className="timeline">
                {(asset.versions ?? []).map((v) => (
                  <div key={v.assetId} className={`tl-item ${v.isCurrent ? 'on' : ''}`}>
                    <div className="spread">
                      <div style={{ minWidth: 0 }}>
                        <div className="row-tight">
                          <span className={`vchip ${v.isCurrent ? 'current' : ''}`}>{v.version}</span>
                          {v.isCurrent && <span className="t-small" style={{ color: 'var(--indigo-deep)', fontWeight: 700 }}>current</span>}
                        </div>
                        <div className="t-mono truncate" style={{ marginTop: 3 }} title={v.displayName}>{v.displayName}</div>
                        <div className="t-small">{date(v.createdAt)} · {bytes(v.sizeBytes)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'activity' && (
            <div className="stack-3">
              {(asset.activity ?? []).length === 0 ? (
                <div className="t-small">Nothing has happened to this file yet beyond its upload.</div>
              ) : (
                (asset.activity ?? []).map((e) => (
                  <div key={e._id} className="panel" style={{ boxShadow: 'none' }}>
                    <div className="panel-body" style={{ padding: 13 }}>
                      <div className="spread">
                        <span style={{ fontSize: 15 }}>
                          <b>{e.userName}</b> {ACTION_COPY[e.action] ?? e.action.toLowerCase()}
                        </span>
                        <span className="t-small">{relative(e.timestamp)}</span>
                      </div>
                      {Boolean(e.before) && (
                        <div className="t-small t-mono" style={{ marginTop: 5, fontSize: 13.5 }}>
                          {JSON.stringify(e.before)} → {JSON.stringify(e.after)}
                        </div>
                      )}
                      <div className="t-small" style={{ fontSize: 13.5, marginTop: 3 }}>{e.userRole} · {e.ip}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Actions. Exactly one primary per state — spark is reserved for the single most
            important next step, which changes with the file's status. */}
        <div className="drawer-foot">
          <div className="wrap-gap">
            {status === 'TRASHED' && can('asset:restore') ? (
              <button className="btn btn-spark" disabled={restore.isPending} onClick={() => restore.mutate()}>
                <Undo2 size={15} /> Restore from the Drive bin
              </button>
            ) : (
              <button className="btn btn-primary" disabled={!canDownload || download.isPending} onClick={() => download.mutate()}>
                <Download size={15} /> Download
              </button>
            )}

            {can('asset:rename') && (
              <button className="btn btn-secondary" onClick={() => setRenaming(true)}>
                <Pencil size={14} /> Rename
              </button>
            )}
            {can('asset:edit') && (
              <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit details</button>
            )}
            {can('share:create') && (
              <button className="btn btn-secondary" onClick={() => setSharing(true)} disabled={status === 'MISSING'}>
                <Share2 size={14} /> Share
              </button>
            )}
            {/* The folder screens send people here to file a loose file — "open any file and
                move it in from its details panel" — so the verb has to actually be here.
                It was only ever on the row menu, which is not where that sentence points. */}
            {can('asset:edit') && (
              <button className="btn btn-secondary" onClick={() => setMoving(true)}>
                <FolderInput size={14} /> Move
              </button>
            )}
            {asset.songId ? (
              <Link className="btn btn-ghost" to={`/songs/${asset.songId}`} onClick={onClose}>
                <ExternalLink size={14} /> Open song
              </Link>
            ) : asset.folderId ? (
              <Link className="btn btn-ghost" to={`/folders/${asset.folderId}`} onClick={onClose}>
                <ExternalLink size={14} /> Open folder
              </Link>
            ) : null}
            {can('asset:delete') && (
              <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => setDeleting(true)}>
                <Trash2 size={14} /> Delete
              </button>
            )}
            {can('asset:purge') && (
              <button className="btn btn-danger btn-sm" onClick={() => setPurging(true)}>Purge permanently</button>
            )}
          </div>
        </div>
      </Drawer>

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
              <b>{asset.displayName}</b> disappears from search, from the song page and from its folder.
              <ul style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
                <li>The object in storage is <b>not</b> touched — same key, same bytes, same cost.</li>
                <li>The catalogue record keeps everything; only a <span className="t-mono">deletedAt</span> date is set.</li>
                <li>Anyone with delete rights can put it back for the next 30 days.</li>
                <li>Existing share links stop resolving while it sits in the bin.</li>
              </ul>
            </>
          }
          confirmLabel="Move to recycle bin"
          onConfirm={() => softDelete.mutate()}
          onClose={() => setDeleting(false)}
        />
      )}
      {purging && (
        <ConfirmDialog
          title="Destroy this file permanently?"
          danger
          requireTyped={asset.displayName}
          requirePassword
          body={
            <>
              This is the other delete, and it is the irreversible one.
              <ul style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
                <li>
                  The Google Drive file <span className="t-mono">{asset.drive.fileId}</span> is deleted
                  outright — it does not go to the bin, and every revision goes with it.
                </li>
                <li>The catalogue record is removed outright, not flagged.</li>
                <li>Every share link to this file is deleted with it.</li>
                <li>
                  Nothing here or in Google Drive brings it back. If you only meant to tidy up, use
                  Delete instead — that one goes to the bin and is recoverable for 30 days.
                </li>
              </ul>
            </>
          }
          confirmLabel="Purge permanently"
          onConfirm={() => purge.mutate()}
          onClose={() => setPurging(false)}
        />
      )}
    </>
  );
}
