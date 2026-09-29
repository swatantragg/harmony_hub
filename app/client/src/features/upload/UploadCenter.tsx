import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UploadCloud, X, Play, Pause, RotateCw, CheckCircle2, AlertTriangle, FileUp,
  Loader2, Info, CopyCheck, FolderUp, Folder as FolderIcon, Layers, Tag as TagIcon, Trash2,
} from 'lucide-react';
import { api } from '../../lib/api';
import { VERSION_LABELS } from '../../lib/assetTypes';
import { isSameTag, useAssetTypes } from '../../lib/vocabulary';
import { carriesLanguage, familyOf } from '../../lib/assetTypes';
import { bytes, pluralise } from '../../lib/format';
import { ConfirmDialog, EmptyState, TagChip, useToast } from '../../components/ui';
import { Select } from '../../components/Select';
import { TagPicker } from './TagPicker';
import { TypePicker } from './TypePicker';
import { LanguagePicker } from '../../components/LanguagePicker';
import { FolderPicker, FolderSearchPicker } from '../folders/FolderPicker';
import { abortUpload, checksum, runUpload, useQueue } from './useUploadQueue';
import type { QueueItem, UploadState } from './useUploadQueue';
import type { Folder, SongRow } from '../../lib/types';

/** What a bulk control holds when the files in the queue disagree. Matches no option. */
const MIXED = '__mixed__';

/** Files "Apply to every file" no longer reaches: finished, or mid-upload. */
const LOCKED: UploadState[] = ['DONE', 'UPLOADING', 'FINALISING'];

export function UploadCenter() {
  const [params] = useSearchParams();
  const { items, add, update, remove, clearDone } = useQueue();
  const [over, setOver] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
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

  const isReady = (i: QueueItem) => i.state === 'READY' && Boolean(i.assetType) && i.tags.length > 0;
  const ready = items.filter(isReady);
  const active = items.filter((i) => ['UPLOADING', 'FINALISING'].includes(i.state));
  const done = items.filter((i) => i.state === 'DONE');
  const needsDetails = items.filter((i) => i.state === 'READY' && !isReady(i)).length;
  const fingerprinting = items.filter((i) => i.state === 'HASHING').length;
  const stopped = items.filter((i) => i.state === 'PAUSED' || i.state === 'FAILED').length;

  // Everything except what is on its way to Drive this second. An upload that
  // was started and then paused or failed holds a Drive session open; clearing
  // it cancels that session, the way removing a single file does.
  const clearable = items.filter((i) => !['UPLOADING', 'FINALISING'].includes(i.state));
  const clearQueue = () => {
    for (const item of clearable) {
      controllers.current.get(item.id)?.abort();
      if (item.state !== 'DONE') void abortUpload(item);
      remove(item.id);
    }
  };
  const uploadReady = () => ready.forEach(start);

  const sessionTags = useMemo(
    () => [...new Set(items.flatMap((i) => i.tags))],
    [items],
  );

  // Every file "Apply to every file" reaches.
  const editable = useMemo(() => items.filter((i) => !LOCKED.includes(i.state)), [items]);

  const applyToAll = (patch: Partial<QueueItem>) => {
    for (const i of editable) update(i.id, patch);
  };

  const familyOfType = (type: string) =>
    typeData?.data.find((t) => t.type === type)?.family ?? familyOf(type);

  const speaks = (i: QueueItem) => carriesLanguage(familyOfType(i.assetType));

  const applyLanguageToAll = (language: string) => {
    for (const i of editable) if (speaks(i)) update(i.id, { language });
  };

  const spokenInQueue = items.filter((i) => i.state === 'READY' && speaks(i)).length;

  // What every file already shares. The bulk controls used to sit blank after
  // they were used — the folder one read "No folder" even with every file
  // filed — so the only way to check where a queue was going was to read each
  // file. They show the shared value now, and MIXED when the files disagree.
  const shared = <K extends 'assetType' | 'songId' | 'folderId' | 'language'>(rows: QueueItem[], key: K) =>
    rows.length > 0 && rows.every((i) => i[key] === rows[0][key]) ? rows[0][key] : MIXED;

  const commonType = shared(editable, 'assetType');
  const commonSong = shared(editable, 'songId');
  const commonFolder = shared(editable, 'folderId');
  const commonLanguage = shared(editable.filter(speaks), 'language');

  // A tag counts as shared only when every file carries it.
  const commonTags = useMemo(
    () => (editable[0]?.tags ?? []).filter((t) => editable.every((i) => i.tags.some((x) => isSameTag(x, t)))),
    [editable],
  );

  // The bulk tag picker used to hand every file the picker's whole value — and
  // that value was always empty, so each click replaced every file's tags with
  // the one tag just clicked. Now a click adds or removes that one tag on every
  // file, and each file's other tags are left alone.
  const applyTagsToAll = (next: string[]) => {
    const added = next.filter((t) => !commonTags.some((c) => isSameTag(c, t)));
    const removed = commonTags.filter((c) => !next.some((t) => isSameTag(t, c)));
    for (const i of editable) {
      const kept = i.tags.filter((t) => !removed.some((r) => isSameTag(r, t)));
      const extra = added.filter((a) => !kept.some((t) => isSameTag(t, a)));
      if (extra.length || kept.length !== i.tags.length) update(i.id, { tags: [...kept, ...extra] });
    }
  };

  return (
    <div className="page stack-4">
      <div className="page-head">
        <h1 className="t-h1">Upload files</h1>
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
        <input
          ref={dirRef}
          type="file"
          multiple
          hidden
          {...{ webkitdirectory: '', directory: '' }}
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
          body="Add a file to get started."
        />
      ) : (
        <>
          <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
            <h2 className="t-h2">
              {items.length} in the queue
              {active.length > 0 && <span className="t-small" style={{ fontWeight: 500 }}> · {active.length} uploading</span>}
            </h2>
            <div className="row-tight" style={{ flexWrap: 'wrap' }}>
              {done.length > 0 && <button className="btn btn-ghost btn-sm" onClick={clearDone}>Clear {done.length} finished</button>}
              {clearable.length > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmClear(true)}>
                  <Trash2 size={14} /> Clear queue
                </button>
              )}
              {ready.length > 0 && (
                <button className="btn btn-spark" onClick={uploadReady}>
                  <UploadCloud size={15} /> Upload {ready.length} {ready.length === 1 ? 'file' : 'files'}
                </button>
              )}
            </div>
          </div>

          {items.filter((i) => i.state === 'READY').length > 1 && (
            <div className="panel" style={{ borderStyle: 'dashed' }}>
              <div className="panel-body stack-4">
                <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <div className="row-tight">
                    <Layers size={14} color="var(--indigo)" />
                    <span className="t-h3">Apply to every file in the queue</span>
                  </div>
                  <span className="t-small">
                    Reaches {pluralise(editable.length, 'file')} · each control shows what they all share
                  </span>
                </div>
                <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <TypePicker
                    value={commonType === MIXED ? '' : commonType}
                    placeholder={commonType === MIXED ? 'Mixed — choose one for all' : 'Choose a type…'}
                    onChange={(assetType) => applyToAll({ assetType })}
                    label="Set the type for all"
                  />
                  <div className="field grow" style={{ minWidth: 190 }}>
                    <label className="label">Attach all to a song</label>
                    <Select
                      value={commonSong}
                      placeholder="Mixed — choose one for all"
                      onChange={(songId) => applyToAll({ songId })}
                      ariaLabel="Song for all"
                      options={[
                        { value: '', label: 'No song' },
                        ...(songs?.data ?? []).map((s) => ({ value: s._id, label: s.title, hint: s.artistName })),
                      ]}
                    />
                    <div className="hint">Optional — leave as “No song” for files that are not tied to a release.</div>
                  </div>
                  {spokenInQueue > 0 && (
                    <LanguagePicker
                      value={commonLanguage === MIXED ? '' : commonLanguage}
                      placeholder={commonLanguage === MIXED ? 'Mixed — type one for all' : undefined}
                      onChange={(language) => {
                        // Leaving an untouched "Mixed" box must not wipe every file's language.
                        if (!language && commonLanguage === MIXED) return;
                        applyLanguageToAll(language);
                      }}
                      label="Language for all"
                      hint={`Optional, and reaches the ${spokenInQueue} audio and video ${spokenInQueue === 1 ? 'file' : 'files'} only. Anything attached to a song inherits the release’s language.`}
                    />
                  )}
                </div>
                <FolderSearchPicker
                  value={commonFolder === MIXED ? '' : commonFolder}
                  mixed={commonFolder === MIXED}
                  count={editable.length}
                  onChange={(folderId) => applyToAll({ folderId })}
                />
                <TagPicker
                  value={commonTags}
                  onChange={applyTagsToAll}
                  label="Tag them all"
                  knownTags={sessionTags}
                  hint={commonTags.length
                    ? `Lit tags are on all ${editable.length} files. Click one to take it off every file, or any other tag to add it to every file. Tags only some files carry are left as they are — change those on each file below.`
                    : `A tag picked here goes on all ${editable.length} files. Each file keeps its own tags below, which you can still adjust one by one.`}
                  summary={
                    <div className={`bulk-verdict ${commonTags.length ? 'set' : ''}`} style={{ marginTop: 8 }} aria-live="polite">
                      <TagIcon size={14} aria-hidden />
                      <span>
                        {commonTags.length ? (
                          <>
                            On all {editable.length} files:{' '}
                            <span className="wrap-gap" style={{ display: 'inline-flex', verticalAlign: 'middle', gap: 6 }}>
                              {commonTags.map((t) => <TagChip key={t} name={t} />)}
                            </span>
                          </>
                        ) : (
                          <>No tag is on every file yet.</>
                        )}
                      </span>
                    </div>
                  }
                />
              </div>
            </div>
          )}

          <div className="stack-3">
            {items.map((item) => (
              <UploadRow
                key={item.id}
                item={item}
                family={familyOfType(item.assetType)}
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

          <div className="queue-bar" role="region" aria-label="Upload queue">
            <div className="queue-bar-status" aria-live="polite">
              <b>{ready.length} ready to upload</b>
              {active.length > 0 && ` · ${active.length} uploading`}
              {needsDetails > 0 && ` · ${needsDetails} still ${needsDetails === 1 ? 'needs' : 'need'} a type or a tag`}
              {fingerprinting > 0 && ` · ${fingerprinting} being fingerprinted`}
              {stopped > 0 && ` · ${stopped} paused or stopped`}
              {done.length > 0 && ` · ${done.length} done`}
            </div>
            <div className="row-tight">
              {clearable.length > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmClear(true)}>
                  <Trash2 size={14} /> Clear queue
                </button>
              )}
              <button className="btn btn-spark" disabled={ready.length === 0} onClick={uploadReady}>
                <UploadCloud size={15} /> Upload {ready.length} {ready.length === 1 ? 'file' : 'files'}
              </button>
            </div>
          </div>
        </>
      )}

      {confirmClear && (
        <ConfirmDialog
          title={`Clear ${pluralise(clearable.length, 'file')} from the queue?`}
          body={
            <>
              {clearable.length === 1 ? 'It comes' : 'They come'} off this list, along with the type,
              folder and tags chosen for {clearable.length === 1 ? 'it' : 'them'}. Nothing already in Google
              Drive is touched, and anything half-sent to it is cancelled.
              {active.length === 1 && ' The upload running now carries on.'}
              {active.length > 1 && ` The ${active.length} uploads running now carry on.`}
            </>
          }
          confirmLabel="Clear queue"
          onConfirm={clearQueue}
          onClose={() => setConfirmClear(false)}
        />
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
  item, family, songs, knownTags, onChange, onStart, onPause, onRemove,
}: {
  item: QueueItem;
  family: string;
  songs: SongRow[];
  knownTags: string[];
  onChange: (patch: Partial<QueueItem>) => void;
  onStart: () => void;
  onPause: () => void;
  onRemove: () => void;
}) {
  const complete = item.state === 'DONE';
  const busy = ['UPLOADING', 'FINALISING'].includes(item.state);

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
                style={{ fontFamily: 'var(--mono)', fontSize: 15, border: 'none', padding: '2px 0', background: 'transparent', fontWeight: 600 }}
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
                <Select
                  value={item.songId}
                  onChange={(songId) => onChange({ songId })}
                  ariaLabel="Song"
                  options={[
                    { value: '', label: 'Not tied to a song' },
                    ...songs.map((s) => ({ value: s._id, label: s.title, hint: s.artistName })),
                  ]}
                />
                <div className="hint">
                  Optional. Contracts, brand assets and press kits usually belong to no single release.
                </div>
              </div>

              <FolderPicker value={item.folderId} onChange={(folderId) => onChange({ folderId })} />

              <div className="field" style={{ flex: '1 1 150px', minWidth: 150 }}>
                <label className="label">Version</label>
                <Select
                  value={item.version}
                  onChange={(version) => onChange({ version })}
                  ariaLabel="Version"
                  options={VERSION_LABELS.map((v) => ({ value: v, label: v }))}
                />
              </div>

              {carriesLanguage(family) && (
                <LanguagePicker
                  value={item.language}
                  onChange={(language) => onChange({ language })}
                  hint={
                    item.songId
                      ? 'Optional. Leave blank to use the language on the release; fill it in only when this file differs.'
                      : 'Optional, and the only place this file can get one — it is not tied to a release.'
                  }
                />
              )}
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
                  <FolderIcon size={11} style={{ verticalAlign: -1 }} /> Filed in the “{item.result.folderName}” folder — in GCloud and in Drive.
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
