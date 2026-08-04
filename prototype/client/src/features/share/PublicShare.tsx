// The page a recipient sees. No navigation, no clutter — the file or the folder, who sent
// it, how long the link lasts, and the preview before any decision to download.
//
// Three link types resolve here through one URL. An "Open to all" link needs no account.
// An "Editor" or "Specific allocation" link is refused with 401 until the visitor signs
// in, and every gate — expiry, revocation, download cap, recipient list, and whether the
// object is still really in storage — is decided by the server on each request.
import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  Download, Clock, ShieldOff, Loader2, LogIn, Users, Globe, PenLine,
  UserCheck, FolderOpen, DownloadCloud,
} from 'lucide-react';
import { Brandmark, ThemeToggle } from '../../components/ui';
import { FilePreview } from '../preview/FilePreview';
import { api, ApiError, auth } from '../../lib/api';
import { bytes, countdown, pluralise } from '../../lib/format';
import { KIND_LABEL, previewKind } from '../../lib/previewKind';
import type { ShareAudience } from '../../lib/types';

interface SharedFile {
  assetId: string;
  displayName: string;
  type: string;
  family: string;
  mimeType: string;
  sizeBytes: number;
  version: string;
  durationSec: number | null;
  dimensions: string | null;
  songTitle: string | null;
  artistName: string | null;
  availability: string;
  previewUrl: string | null;
}

interface Resolved {
  kind: 'ASSET' | 'FOLDER';
  share: {
    target: string;
    audience: ShareAudience;
    audienceLabel: string;
    canDownload: boolean;
    canEdit: boolean;
    expiresAt: string;
    note: string;
    sharedBy: string;
    downloadsRemaining: number | null;
    recipientCount: number | null;
  };
  viewer: { name: string; email: string; role: string } | null;
  asset?: Omit<SharedFile, 'availability' | 'previewUrl'> & { description: string };
  previewUrl?: string;
  availability?: string;
  folder?: { name: string; description: string; tags: string[]; fileCount: number; totalBytes: number };
  files?: SharedFile[];
}

const AUDIENCE_ICON: Record<ShareAudience, typeof Globe> = {
  PUBLIC: Globe, EDITOR: PenLine, RESTRICTED: UserCheck,
};

export function PublicShare() {
  const { token } = useParams();
  const location = useLocation();
  const [data, setData] = useState<Resolved | null>(null);
  const [error, setError] = useState<{ message: string; needsSignIn: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api<Resolved>(`/s/${token}`)
      .then((r) => {
        setData(r);
        if (r.kind === 'FOLDER' && r.files?.length) setOpen(r.files[0].assetId);
      })
      .catch((e: Error) =>
        setError({
          message: e.message,
          needsSignIn: e instanceof ApiError && e.status === 401,
        }),
      );
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const start = (url: string, name: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const download = async (assetId?: string, name?: string) => {
    setBusy(assetId ?? 'one');
    try {
      const r = await api<{ url: string; downloadAs: string; downloadsRemaining: number | null }>(
        `/s/${token}/download`,
        { method: 'POST', body: assetId ? { assetId } : {} },
      );
      start(r.url, name ?? r.downloadAs);
      setData((d) => (d ? { ...d, share: { ...d.share, downloadsRemaining: r.downloadsRemaining } } : d));
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : 'Download failed', needsSignIn: false });
    } finally {
      setBusy(null);
    }
  };

  // One signed URL per file — Amazon S3 does not zip on the server side, and this does not
  // pretend otherwise. Each file comes straight from storage.
  const downloadAll = async () => {
    setBusy('all');
    try {
      const r = await api<{ files: { name: string; url: string }[]; skipped: number; downloadsRemaining: number | null }>(
        `/s/${token}/download-all`,
        { method: 'POST' },
      );
      r.files.forEach((f, i) => setTimeout(() => start(f.url, f.name), i * 350));
      setData((d) => (d ? { ...d, share: { ...d.share, downloadsRemaining: r.downloadsRemaining } } : d));
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : 'Download failed', needsSignIn: false });
    } finally {
      setBusy(null);
    }
  };

  const wide = data?.kind === 'FOLDER';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 20px' }}>
      <div className="theme-toggle-float"><ThemeToggle /></div>
      <div style={{ width: '100%', maxWidth: wide ? 940 : 560 }}>
        <div style={{ marginBottom: 26 }}><Brandmark /></div>

        {error ? (
          <div className="panel">
            <div className="panel-body col" style={{ alignItems: 'center', textAlign: 'center', gap: 12, padding: 40 }}>
              <span
                style={{
                  width: 54, height: 54, borderRadius: 16,
                  background: error.needsSignIn ? 'var(--indigo-soft)' : 'var(--danger-soft)',
                  color: error.needsSignIn ? 'var(--indigo-deep)' : 'var(--danger)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {error.needsSignIn ? <LogIn size={24} /> : <ShieldOff size={24} />}
              </span>
              <h1 className="t-h2">{error.needsSignIn ? 'Sign in to open this' : 'This link is not available'}</h1>
              <p className="t-body" style={{ maxWidth: '40ch', margin: 0 }}>{error.message}</p>
              {error.needsSignIn ? (
                <>
                  <Link className="btn btn-primary" to="/login" state={{ from: location }}>
                    <LogIn size={15} /> Sign in
                  </Link>
                  {auth.get() && (
                    <button className="btn btn-ghost btn-sm" onClick={load}>Already signed in — try again</button>
                  )}
                </>
              ) : (
                <p className="t-small" style={{ margin: 0 }}>Ask whoever sent it to issue a new one.</p>
              )}
            </div>
          </div>
        ) : !data ? (
          <div className="panel"><div className="panel-body col" style={{ alignItems: 'center', padding: 50 }}><Loader2 size={22} color="var(--ink-3)" /></div></div>
        ) : data.kind === 'FOLDER' ? (
          <FolderShare
            data={data}
            open={open}
            setOpen={setOpen}
            busy={busy}
            onDownload={download}
            onDownloadAll={downloadAll}
          />
        ) : (
          <AssetShare data={data} busy={busy} onDownload={() => download(undefined, data.asset!.displayName)} />
        )}

        <p className="t-small" style={{ textAlign: 'center', marginTop: 22 }}>
          Delivered by SK-V2.2. This link expires on its own and can be revoked at any time.
        </p>
      </div>
    </div>
  );
}

/* ── Shared header strip ─────────────────────────────────────────────────── */

function ShareMeta({ data }: { data: Resolved }) {
  const Icon = AUDIENCE_ICON[data.share.audience] ?? Globe;
  return (
    <div className="note neutral">
      <Clock size={15} />
      <div>
        Shared by <b>{data.share.sharedBy}</b> · {countdown(Date.parse(data.share.expiresAt) - Date.now())}
        {data.share.downloadsRemaining != null && ` · ${data.share.downloadsRemaining} downloads left`}
        <div className="row-tight" style={{ marginTop: 5, fontSize: 11.5 }}>
          <Icon size={12} />
          {data.share.audienceLabel}
          {data.viewer ? ` · opened as ${data.viewer.name}` : ' · no account needed'}
          {data.share.recipientCount ? ` · ${pluralise(data.share.recipientCount, 'named recipient')}` : ''}
        </div>
      </div>
    </div>
  );
}

/* ── One file ────────────────────────────────────────────────────────────── */

function AssetShare({ data, busy, onDownload }: { data: Resolved; busy: string | null; onDownload: () => void }) {
  const asset = data.asset!;
  return (
    <div className="panel">
      <div className="panel-body stack-3">
        <div>
          <div className="row-tight" style={{ marginBottom: 6 }}>
            <span className="eyebrow">{asset.type}</span>
            <span className="vchip current">{asset.version}</span>
            <span className="tag">{KIND_LABEL[previewKind(asset.mimeType, asset.displayName)]}</span>
          </div>
          <h1 className="t-h2" style={{ wordBreak: 'break-word' }}>{asset.displayName}</h1>
          <div className="t-small" style={{ marginTop: 3 }}>
            {asset.songTitle ? `${asset.songTitle} · ` : ''}
            {asset.artistName ? `${asset.artistName} · ` : ''}
            {bytes(asset.sizeBytes)}
          </div>
        </div>

        {data.share.note && <p className="t-body" style={{ margin: 0 }}>{data.share.note}</p>}

        <FilePreview
          url={data.previewUrl ?? null}
          file={{
            displayName: asset.displayName,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes,
            durationSec: asset.durationSec,
            dimensions: asset.dimensions,
            seed: asset.assetId,
          }}
          height={340}
          onDownload={data.share.canDownload ? onDownload : undefined}
        />

        <ShareMeta data={data} />

        {data.share.canDownload ? (
          <button
            className="btn btn-spark btn-lg btn-block"
            onClick={onDownload}
            disabled={Boolean(busy) || data.share.downloadsRemaining === 0}
          >
            {busy ? <Loader2 size={16} /> : <Download size={16} />}
            {data.share.downloadsRemaining === 0 ? 'Download limit reached' : 'Download'}
          </button>
        ) : (
          <div className="note indigo"><span>This link is preview-only — downloading is not permitted.</span></div>
        )}

        {data.share.canEdit && data.viewer && (
          <div className="note indigo">
            <PenLine size={15} />
            <div>
              You have editor access through this link. Open it in the app to rename, re-tag or replace the file.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── A whole folder ──────────────────────────────────────────────────────── */

function FolderShare({
  data, open, setOpen, busy, onDownload, onDownloadAll,
}: {
  data: Resolved;
  open: string | null;
  setOpen: (id: string) => void;
  busy: string | null;
  onDownload: (assetId: string, name: string) => void;
  onDownloadAll: () => void;
}) {
  const folder = data.folder!;
  const files = data.files ?? [];
  const active = files.find((f) => f.assetId === open) ?? files[0] ?? null;

  return (
    <div className="stack-4">
      <div className="panel">
        <div className="panel-body stack-3">
          <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div className="row-tight" style={{ marginBottom: 6 }}>
                <FolderOpen size={15} color="var(--info)" />
                <span className="eyebrow">Shared folder</span>
              </div>
              <h1 className="t-h2" style={{ wordBreak: 'break-word' }}>{folder.name}</h1>
              <div className="t-small" style={{ marginTop: 3 }}>
                {pluralise(folder.fileCount, 'file')} · {bytes(folder.totalBytes)}
              </div>
              {folder.description && <p className="t-body" style={{ marginTop: 8, maxWidth: '60ch' }}>{folder.description}</p>}
            </div>
            {data.share.canDownload && (
              <button className="btn btn-spark" onClick={onDownloadAll} disabled={busy === 'all' || data.share.downloadsRemaining === 0}>
                {busy === 'all' ? <Loader2 size={15} /> : <DownloadCloud size={15} />} Download everything
              </button>
            )}
          </div>

          {data.share.note && <p className="t-body" style={{ margin: 0 }}>{data.share.note}</p>}
          <ShareMeta data={data} />
        </div>
      </div>

      <div className="split">
        <div className="panel" style={{ overflow: 'hidden', alignSelf: 'start' }}>
          <div className="panel-head"><span className="t-h3"><Users size={14} style={{ verticalAlign: -2 }} /> Files in this folder</span></div>
          <div style={{ maxHeight: 460, overflowY: 'auto' }}>
            {files.map((f) => (
              <button
                key={f.assetId}
                className={`nav-item ${active?.assetId === f.assetId ? 'active' : ''}`}
                style={{ borderRadius: 0, alignItems: 'flex-start', padding: '11px 14px', width: '100%' }}
                onClick={() => setOpen(f.assetId)}
              >
                <span className="grow" style={{ minWidth: 0, textAlign: 'left' }}>
                  <span className="truncate" style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                    {f.displayName}
                  </span>
                  <span className="t-small" style={{ display: 'block', fontSize: 11 }}>
                    {KIND_LABEL[previewKind(f.mimeType, f.displayName)]} · {bytes(f.sizeBytes)}
                    {f.availability !== 'AVAILABLE' ? ` · ${f.availability.toLowerCase()}` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="panel">
          {active ? (
            <div className="panel-body stack-3">
              <div>
                <div className="row-tight" style={{ marginBottom: 6 }}>
                  <span className="eyebrow">{active.type}</span>
                  <span className="tag">{KIND_LABEL[previewKind(active.mimeType, active.displayName)]}</span>
                </div>
                <h2 className="t-h3" style={{ wordBreak: 'break-word' }}>{active.displayName}</h2>
                <div className="t-small" style={{ marginTop: 3 }}>
                  {active.songTitle ? `${active.songTitle} · ` : ''}{bytes(active.sizeBytes)}
                </div>
              </div>

              {active.previewUrl ? (
                <FilePreview
                  url={active.previewUrl}
                  file={{
                    displayName: active.displayName,
                    mimeType: active.mimeType,
                    sizeBytes: active.sizeBytes,
                    durationSec: active.durationSec,
                    dimensions: active.dimensions,
                    seed: active.assetId,
                  }}
                  height={300}
                  onDownload={data.share.canDownload ? () => onDownload(active.assetId, active.displayName) : undefined}
                />
              ) : (
                <div className="note danger">
                  <ShieldOff size={15} />
                  <div>This file is not available right now ({active.availability.toLowerCase()}), so it cannot be previewed or downloaded.</div>
                </div>
              )}

              {data.share.canDownload && active.previewUrl && (
                <button
                  className="btn btn-primary btn-block"
                  onClick={() => onDownload(active.assetId, active.displayName)}
                  disabled={busy === active.assetId || data.share.downloadsRemaining === 0}
                >
                  {busy === active.assetId ? <Loader2 size={15} /> : <Download size={15} />} Download this file
                </button>
              )}
            </div>
          ) : (
            <div className="panel-body t-small" style={{ padding: 30 }}>This folder has no files in it.</div>
          )}
        </div>
      </div>
    </div>
  );
}
