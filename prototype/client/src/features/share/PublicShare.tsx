// The page a partner sees. No account, no navigation, no clutter — just the file, who
// sent it, how long the link lasts, and one button.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download, Clock, ShieldOff, Loader2 } from 'lucide-react';
import { Brandmark, ThemeToggle } from '../../components/ui';
import { api } from '../../lib/api';
import { bytes, countdown } from '../../lib/format';

interface Resolved {
  asset: { displayName: string; type: string; family: string; sizeBytes: number; mimeType: string; version: string; songTitle: string; artistName: string | null };
  share: { canDownload: boolean; expiresAt: string; note: string; sharedBy: string; downloadsRemaining: number | null };
  previewUrl: string;
  availability: string;
}

export function PublicShare() {
  const { token } = useParams();
  const [data, setData] = useState<Resolved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Resolved>(`/s/${token}`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [token]);

  const download = async () => {
    setBusy(true);
    try {
      const r = await api<{ url: string; downloadsRemaining: number | null }>(`/s/${token}/download`, { method: 'POST' });
      const a = document.createElement('a');
      a.href = r.url;
      a.download = data!.asset.displayName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setData((d) => (d ? { ...d, share: { ...d.share, downloadsRemaining: r.downloadsRemaining } } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 20px' }}>
      <div className="theme-toggle-float"><ThemeToggle /></div>
      <div style={{ width: '100%', maxWidth: 560 }}>
        <div style={{ marginBottom: 26 }}><Brandmark /></div>

        {error ? (
          <div className="panel">
            <div className="panel-body col" style={{ alignItems: 'center', textAlign: 'center', gap: 12, padding: 40 }}>
              <span style={{ width: 54, height: 54, borderRadius: 16, background: 'var(--danger-soft)', color: 'var(--danger)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ShieldOff size={24} />
              </span>
              <h1 className="t-h2">This link is not available</h1>
              <p className="t-body" style={{ maxWidth: '38ch', margin: 0 }}>{error}</p>
              <p className="t-small" style={{ margin: 0 }}>Ask whoever sent it to issue a new one.</p>
            </div>
          </div>
        ) : !data ? (
          <div className="panel"><div className="panel-body col" style={{ alignItems: 'center', padding: 50 }}><Loader2 size={22} color="var(--ink-3)" /></div></div>
        ) : (
          <div className="panel">
            <div className="card-art" data-family={data.asset.family} style={{ height: 168, borderRadius: 0 }}>
              {data.asset.family === 'Image' && <img src={data.previewUrl} alt="" />}
              <span className="type-badge">{data.asset.type}</span>
              <span className="ver-badge">{data.asset.version}</span>
            </div>

            <div className="panel-body stack-3">
              <div>
                <h1 className="t-h2" style={{ wordBreak: 'break-word' }}>{data.asset.displayName}</h1>
                <div className="t-small" style={{ marginTop: 3 }}>
                  {data.asset.songTitle}{data.asset.artistName ? ` · ${data.asset.artistName}` : ''} · {bytes(data.asset.sizeBytes)}
                </div>
              </div>

              {data.share.note && <p className="t-body" style={{ margin: 0 }}>{data.share.note}</p>}

              {data.asset.family === 'Audio' && (
                <audio controls src={data.previewUrl} style={{ width: '100%' }} />
              )}

              <div className="note neutral">
                <Clock size={15} />
                <div>
                  Shared by <b>{data.share.sharedBy}</b> · {countdown(Date.parse(data.share.expiresAt) - Date.now())}
                  {data.share.downloadsRemaining != null && ` · ${data.share.downloadsRemaining} downloads left`}
                </div>
              </div>

              {data.share.canDownload ? (
                <button className="btn btn-spark btn-lg btn-block" onClick={download} disabled={busy || data.share.downloadsRemaining === 0}>
                  {busy ? <Loader2 size={16} /> : <Download size={16} />}
                  {data.share.downloadsRemaining === 0 ? 'Download limit reached' : 'Download'}
                </button>
              ) : (
                <div className="note indigo"><span>This link is preview-only — downloading is not permitted.</span></div>
              )}
            </div>
          </div>
        )}

        <p className="t-small" style={{ textAlign: 'center', marginTop: 22 }}>
          Delivered by Maestro. This link expires on its own and can be revoked at any time.
        </p>
      </div>
    </div>
  );
}
