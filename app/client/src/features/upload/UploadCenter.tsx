// Upload manager. Drop files or a whole folder, describe them, send them.
//
// Only one question is compulsory — what kind of file this is — because that is what
// makes it findable. Song and folder are both optional: plenty of files belong to the
// library without belonging to a release.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UploadCloud, X, Play, Pause, RotateCw, CheckCircle2, AlertTriangle, FileUp,
  Loader2, Info, CopyCheck, FolderUp, Folder as FolderIcon, Layers,
} from 'lucide-react';
import { api } from '../../lib/api';
import { VERSION_LABELS } from '../../lib/assetTypes';
import { useAssetTypes } from '../../lib/vocabulary';
import { bytes } from '../../lib/format';
import { EmptyState, useToast } from '../../components/ui';
import { TagPicker } from './TagPicker';
import { TypePicker } from './TypePicker';
import { FolderPicker } from '../folders/FolderPicker';
import { abortUpload, checksum, runUpload, useQueue } from './useUploadQueue';
import type { QueueItem } from './useUploadQueue';
import type { Folder, SongRow } from '../../lib/types';

export function UploadCenter() {
  const [params] = useSearchParams();
  const { items, add, update, remove, clearDone } = useQueue();
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const toast = useToast();
  const qc = useQueryClient();
  const { data: typeData } = useAssetTypes();

  const { data: songs } = useQuery({
    queryKey: ['songs', ''],
    queryFn: () => api<{ data: SongRow[] }>('/songs'),
  });

  const defaultSongId = params.get('songId') ?? '';
  const defaultFolderId = params.get('folderId') ?? '';

  // Hash each newly added file so duplicates can be flagged before anything is sent.
  useEffect(() => {
    for (const item of items) {
      if (item.state !== 'HASHING' || item.checksum) continue;
      checksum(item.file)
        .then((sum) => update(item.id, { checksum: sum, state: 'READY' }))
        .catch(() => update(item.id, { state: 'READY' }));
    }
  }, [items, update]);

  const accept = (files: File[], folderId = defaultFolderId) => {
    if (!files.length) return;
    add(files, { songId: defaultSongId, folderId, assetType: guessType(files[0]) });
  };

  // Dropping or choosing a directory: every file carries a webkitRelativePath, so the
  // top-level directory name becomes the folder and each file joins it. In storage they
  // remain individual objects — the folder exists only in the catalogue.
  const acceptDirectory = async (files: File[]) => {
    if (!files.length) return;
    const first = files[0] as File & { webkitRelativePath?: string };
    const rootName = (first.webkitRelativePath || '').split('/')[0] || 'Uploaded folder';
    try {
      const folder = await api<Folder>('/folders', {
        method: 'POST',
        body: { name: rootName, description: `Created from an uploaded folder of ${files.length} files.`, tags: [], allowDuplicateName: true },
      });
      qc.invalidateQueries({ queryKey: ['folder-options'] });
      add(files, { songId: defaultSongId, folderId: folder._id, assetType: '' });
      toast({
        kind: 'ok',
        title: `Folder “${folder.name}” created`,
        body: `${files.length} files queued. Each is stored as its own object — the folder is a grouping, not a location.`,
      });
    } catch (err) {
      toast({ kind: 'danger', title: 'Could not create the folder', body: err instanceof Error ? err.message : '' });
    }
  };

  const start = async (item: QueueItem) => {
    const controller = new AbortController();
    controllers.current.set(item.id, controller);
    const asset = await runUpload(item, controller);
    controllers.current.delete(item.id);
    if (asset) {
      qc.invalidateQueries();
      toast({ kind: 'ok', title: 'Uploaded', body: `${asset.displayName} is in storage and verified.` });
    }
  };

  const pause = (item: QueueItem) => controllers.current.get(item.id)?.abort();

  // Only the type and at least one tag gate an upload now.
  const isReady = (i: QueueItem) => i.state === 'READY' && Boolean(i.assetType) && i.tags.length > 0;
  const ready = items.filter(isReady);
  const active = items.filter((i) => ['UPLOADING', 'FINALISING'].includes(i.state));
  const done = items.filter((i) => i.state === 'DONE');

  // Every tag anywhere in the queue. Passed to each picker so a tag typed on one file is
  // immediately part of the duplicate check on all the others.
  const sessionTags = useMemo(
    () => [...new Set(items.flatMap((i) => i.tags))],
    [items],
  );

  // Apply one choice to the whole queue — the point of dropping a folder is not to fill
  // the same form forty times.
  const applyToAll = (patch: Partial<QueueItem>) => {
    for (const i of items) if (!['DONE', 'UPLOADING', 'FINALISING'].includes(i.state)) update(i.id, patch);
  };

  return (
    <div className="page stack-4">
      <div className="page-head">
        <h1 className="t-h1">Upload files</h1>
        <p className="t-body" style={{ maxWidth: '64ch', marginTop: 6 }}>
          Files travel from this browser straight into storage — they never pass through the
          application server. Large files are split into parts that upload in parallel, so a
          dropped connection only costs you one part.
        </p>
      </div>

      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); accept([...e.dataTransfer.files]); }}
        role="group"
        aria-label="Add files"
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => { accept([...(e.target.files ?? [])]); e.target.value = ''; }}
        />
        {/* webkitdirectory lets the browser hand over an entire directory tree at once. */}
        <input
          ref={dirRef}
          type="file"
          multiple
          hidden
          // @ts-expect-error — non-standard but supported everywhere this ships
          webkitdirectory=""
          directory=""
          onChange={(e) => { void acceptDirectory([...(e.target.files ?? [])]); e.target.value = ''; }}
        />

        <div className="col" style={{ alignItems: 'center', gap: 14 }}>
          <span
            style={{
              width: 56, height: 56, borderRadius: 17, background: 'var(--indigo-soft)',
              color: 'var(--indigo)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <FileUp size={25} />
          </span>
          <div>
            <div className="t-h2">Drop files here</div>
            <div className="t-small" style={{ marginTop: 4 }}>any size, any format</div>
          </div>
          <div className="row-tight" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}>
              <FileUp size={15} /> Choose files
            </button>
            <button className="btn btn-secondary" onClick={() => dirRef.current?.click()}>
              <FolderUp size={15} /> Upload a whole folder
            </button>
          </div>
          <div className="t-small" style={{ maxWidth: '54ch' }}>
            Uploading a folder creates a folder here with the same name and puts every file in
            it. Storage still keeps each file separately — the folder is a grouping, not a place.
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<UploadCloud size={26} />}
          title="Nothing queued"
          body="Add a file to get started. You will be asked what kind of file it is and how to tag it — that is what makes it findable later. Attaching it to a song or a folder is optional."
        />
      ) : (
        <>
          <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
            <h2 className="t-h2">
              {items.length} in the queue
              {active.length > 0 && <span className="t-small" style={{ fontWeight: 500 }}> · {active.length} uploading</span>}
            </h2>
            <div className="row-tight">
              {done.length > 0 && <button className="btn btn-ghost btn-sm" onClick={clearDone}>Clear {done.length} finished</button>}
              {ready.length > 0 && (
                <button className="btn btn-spark" onClick={() => ready.forEach(start)}>
                  <UploadCloud size={15} /> Upload {ready.length} {ready.length === 1 ? 'file' : 'files'}
                </button>
              )}
            </div>
          </div>

          {/* Bulk apply — the difference between filing 40 files and abandoning the job. */}
          {items.filter((i) => i.state === 'READY').length > 1 && (
            <div className="panel" style={{ borderStyle: 'dashed' }}>
              <div className="panel-body stack-3">
                <div className="row-tight">
                  <Layers size={14} color="var(--indigo)" />
                  <span className="t-h3">Apply to every file in the queue</span>
                </div>
                <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <TypePicker value="" onChange={(assetType) => applyToAll({ assetType })} label="Set the type for all" />
                  <div className="field grow" style={{ minWidth: 190 }}>
                    <label className="label">Attach all to a song</label>
                    <select className="select" defaultValue="" onChange={(e) => applyToAll({ songId: e.target.value })}>
                      <option value="">No song</option>
                      {songs?.data.map((s) => <option key={s._id} value={s._id}>{s.title} — {s.artistName}</option>)}
                    </select>
                    <div className="hint">Optional — leave as “No song” for files that are not tied to a release.</div>
                  </div>
                  <FolderPicker value="" onChange={(folderId) => applyToAll({ folderId })} label="Put all in a folder" />
                </div>
                <TagPicker
                  value={[]}
                  onChange={(tags) => applyToAll({ tags })}
                  label="Tag them all"
                  knownTags={sessionTags}
                  hint="Picking a tag here applies it to every file in the queue. Each file keeps its own tags below, which you can still adjust individually."
                />
              </div>
            </div>
          )}

          <div className="stack-3">
            {items.map((item) => (
              <UploadRow
                key={item.id}
                item={item}
                songs={songs?.data ?? []}
                knownTags={sessionTags}
                onChange={(patch) => update(item.id, patch)}
                onStart={() => start(item)}
                onPause={() => pause(item)}
                onRemove={() => {
                  controllers.current.get(item.id)?.abort();
                  if (item.state !== 'DONE') void abortUpload(item);
                  remove(item.id);
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function guessType(file: File): string {
  const t = file.type;
  if (t.startsWith('audio')) return 'Master Audio';
  if (t.startsWith('video')) return 'Horizontal Video';
  if (t.startsWith('image')) return 'Song Cover';
  if (t.startsWith('text')) return 'Lyrics';
  return '';
}

function UploadRow({
  item, songs, knownTags, onChange, onStart, onPause, onRemove,
}: {
  item: QueueItem;
  songs: SongRow[];
  knownTags: string[];
  onChange: (patch: Partial<QueueItem>) => void;
  onStart: () => void;
  onPause: () => void;
  onRemove: () => void;
}) {
  const complete = item.state === 'DONE';
  const busy = ['UPLOADING', 'FINALISING'].includes(item.state);

  // Song and folder are deliberately absent from this list.
  const blockers = useMemo(() => {
    const out: string[] = [];
    if (!item.assetType) out.push('choose the kind of file');
    if (item.tags.length === 0) out.push('add at least one tag');
    return out;
  }, [item.assetType, item.tags.length]);

  const speed = item.startedAt && item.bytesSent
    ? item.bytesSent / Math.max(1, (Date.now() - item.startedAt) / 1000)
    : 0;

  return (
    <div className="panel">
      <div className="panel-body stack-3">
        <div className="spread" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row-tight" style={{ marginBottom: 3 }}>
              {complete ? <CheckCircle2 size={15} color="var(--ok)" />
                : item.state === 'FAILED' ? <AlertTriangle size={15} color="var(--danger)" />
                : busy ? <Loader2 size={15} color="var(--indigo)" />
                : <FileUp size={15} color="var(--ink-3)" />}
              <input
                className="input"
                style={{ fontFamily: 'var(--mono)', fontSize: 13, border: 'none', padding: '2px 0', background: 'transparent', fontWeight: 600 }}
                value={item.displayName}
                onChange={(e) => onChange({ displayName: e.target.value })}
                disabled={busy || complete}
                aria-label="File name"
              />
            </div>
            <div className="t-small">
              {bytes(item.file.size)} · {item.file.type || 'unknown type'}
              {item.state === 'HASHING' && ' · fingerprinting…'}
              {busy && speed > 0 && ` · ${bytes(speed)}/s`}
            </div>
          </div>

          <div className="row-tight">
            {item.state === 'READY' && (
              <button className="btn btn-primary btn-sm" disabled={blockers.length > 0} onClick={onStart}>
                <Play size={13} /> Upload
              </button>
            )}
            {busy && <button className="btn btn-secondary btn-sm" onClick={onPause}><Pause size={13} /> Pause</button>}
            {(item.state === 'PAUSED' || item.state === 'FAILED') && (
              <button className="btn btn-primary btn-sm" onClick={onStart}><RotateCw size={13} /> Resume</button>
            )}
            {!busy && <button className="btn btn-ghost btn-icon" onClick={onRemove} aria-label="Remove"><X size={15} /></button>}
          </div>
        </div>

        {item.duplicate && (
          <div className="note">
            <CopyCheck size={15} />
            <div>
              <b>This looks like a file already in the library.</b> The same contents were uploaded as{' '}
              <b>{item.duplicate.displayName}</b>{item.duplicate.songTitle ? ` on ${item.duplicate.songTitle}` : ''}.
              Uploading again creates a second, independent copy — usually you want a new version instead.
            </div>
          </div>
        )}

        {!complete && !busy && (
          <div className="stack-3" style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <TypePicker value={item.assetType} onChange={(assetType) => onChange({ assetType })} />

              <div className="field grow" style={{ minWidth: 190 }}>
                <label className="label">Which song?</label>
                <select className="select" value={item.songId} onChange={(e) => onChange({ songId: e.target.value })}>
                  <option value="">Not tied to a song</option>
                  {songs.map((s) => <option key={s._id} value={s._id}>{s.title} — {s.artistName}</option>)}
                </select>
                <div className="hint">
                  Optional. Contracts, brand assets and press kits usually belong to no single release.
                </div>
              </div>

              <FolderPicker value={item.folderId} onChange={(folderId) => onChange({ folderId })} />

              <div className="field" style={{ width: 150 }}>
                <label className="label">Version</label>
                <select className="select" value={item.version} onChange={(e) => onChange({ version: e.target.value })}>
                  {VERSION_LABELS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            </div>

            <TagPicker required value={item.tags} knownTags={knownTags} onChange={(tags) => onChange({ tags })} />

            {blockers.length > 0 && (
              <div className="note neutral">
                <Info size={15} />
                <div>Before uploading, {blockers.join(' and ')}.</div>
              </div>
            )}
          </div>
        )}

        {(busy || item.state === 'PAUSED') && (
          <div className="stack-2">
            <div className="bar"><i style={{ width: `${item.progress}%` }} /></div>
            <div className="spread">
              <span className="t-small">
                {item.state === 'FINALISING'
                  ? 'Confirming with Google Drive…'
                  : `${item.progress}% · ${bytes(item.bytesSent)} of ${bytes(item.file.size)}`}
              </span>
              <span className="t-small">
                {item.state === 'PAUSED' && item.uploadedBytes > 0
                  ? `Google is holding ${bytes(item.uploadedBytes)} — resuming continues from there`
                  : 'straight to Google Drive'}
              </span>
            </div>
          </div>
        )}

        {item.state === 'FAILED' && (
          <div className="note danger">
            <AlertTriangle size={15} />
            <div>
              <b>Upload stopped.</b> {item.error}
              {item.uploadedBytes > 0
                ? ` — Resume picks up from the ${bytes(item.uploadedBytes)} Google already has, not from the beginning.`
                : ' — press Resume to try again.'}
            </div>
          </div>
        )}

        {complete && item.result && (
          <div className="note ok">
            <CheckCircle2 size={15} />
            <div className="grow">
              <b>In Google Drive and verified.</b> Saved as{' '}
              <span className="keytext">{item.result.drive.path ?? item.result.drive.name}</span>
              {item.result.driveWebViewLink && (
                <>
                  {' · '}
                  <a href={item.result.driveWebViewLink} target="_blank" rel="noreferrer">Open in Drive</a>
                </>
              )}
              {item.result.folderName && (
                <div className="t-small" style={{ marginTop: 4 }}>
                  <FolderIcon size={11} style={{ verticalAlign: -1 }} /> Filed in the “{item.result.folderName}” folder — in Harmony Hub and in Drive.
                </div>
              )}
            </div>
            {item.result.songId ? (
              <Link className="btn btn-secondary btn-sm" to={`/songs/${item.result.songId}`}>Open song</Link>
            ) : item.result.folderId ? (
              <Link className="btn btn-secondary btn-sm" to={`/folders/${item.result.folderId}`}>Open folder</Link>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
