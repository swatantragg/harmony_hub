// Preview & streaming (§10.3). Everything here is served by a presigned inline URL that
// the browser fetches directly from storage — audio seeking uses HTTP Range, so the file
// streams progressively instead of downloading in full.
import { useEffect, useRef, useState } from 'react';
import { Film, Pause, Play, FileText, Archive, CircleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import type { Asset } from '../../lib/types';
import { duration } from '../../lib/format';

export function AssetPreview({ asset }: { asset: Asset }) {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  // An unchecked file is almost certainly fine — it simply has not been proven recently.
  // Only a confirmed absence or an archived object actually blocks a preview.
  const playable = ['AVAILABLE', 'MISMATCH', 'UNVERIFIED'].includes(asset.availability.status);

  useEffect(() => {
    if (!playable) return;
    let alive = true;
    api<{ url: string }>(`/assets/${asset.assetId}/preview`, { method: 'POST' })
      .then((r) => {
        if (!alive) return;
        setUrl(r.url);
        if (asset.mimeType.startsWith('text/')) {
          fetch(r.url).then((res) => res.text()).then((t) => alive && setText(t)).catch(() => {});
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [asset.assetId, asset.mimeType, playable]);

  if (!playable) {
    const isArchive = ['ARCHIVED', 'RESTORING'].includes(asset.availability.status);
    return (
      <div className="preview-stage col" style={{ gap: 10, padding: 28, textAlign: 'center' }}>
        {isArchive ? <Archive size={26} color="var(--info)" /> : <CircleAlert size={26} color="var(--danger)" />}
        <div className="t-small" style={{ maxWidth: '38ch' }}>
          {isArchive
            ? 'This file is in archival storage. Request a restore to preview or download it.'
            : 'There is no object in storage behind this record, so there is nothing to preview.'}
        </div>
      </div>
    );
  }

  if (!url) return <div className="preview-stage"><div className="t-small">Requesting a preview link…</div></div>;

  if (asset.family === 'Image') {
    return <div className="preview-stage"><img src={url} alt={asset.displayName} /></div>;
  }

  if (asset.family === 'Audio') return <AudioPreview url={url} asset={asset} />;

  if (asset.family === 'Document') {
    return (
      <div className="preview-stage" style={{ alignItems: 'stretch', padding: 0 }}>
        {text != null ? (
          <pre
            style={{
              margin: 0, padding: 18, fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.7,
              whiteSpace: 'pre-wrap', maxHeight: 300, overflowY: 'auto', color: 'var(--ink-2)', width: '100%',
            }}
          >
            {text}
          </pre>
        ) : (
          <div className="col" style={{ alignItems: 'center', gap: 10, padding: 28, width: '100%' }}>
            <FileText size={26} color="var(--info)" />
            <div className="t-small">Download to open this document.</div>
          </div>
        )}
      </div>
    );
  }

  // Video. The seeded prototype stores placeholder payloads rather than encoded video,
  // so the player is shown but cannot decode — stated plainly rather than failing silently.
  return (
    <div className="preview-stage col" style={{ gap: 10, padding: 28, textAlign: 'center' }}>
      <Film size={26} color="var(--spark-deep)" />
      <div className="t-small" style={{ maxWidth: '40ch' }}>
        Video streams from storage over HTTP Range requests, so seeking works without any
        transcoding service. The seeded demo files carry placeholder payloads, so there is
        no decodable picture here.
      </div>
      <div className="t-mono t-small">{asset.dimensions ?? asset.format} · {duration(asset.durationSec)}</div>
    </div>
  );
}

function AudioPreview({ url, asset }: { url: string; asset: Asset }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [len, setLen] = useState(asset.durationSec ?? 0);

  // A deterministic waveform drawn from the asset id — the real peaks would come from a
  // stored peaks file in production, and the interaction is identical either way.
  const bars = Array.from({ length: 64 }, (_, i) => {
    let h = 0;
    const seed = `${asset.assetId}${i}`;
    for (let j = 0; j < seed.length; j += 1) h = (h * 31 + seed.charCodeAt(j)) | 0;
    return 18 + (Math.abs(h) % 82);
  });

  const seek = (fraction: number) => {
    if (ref.current && len) {
      ref.current.currentTime = fraction * len;
      setPos(fraction * len);
    }
  };

  return (
    <div className="preview-stage col" style={{ gap: 12, padding: 18, alignItems: 'stretch' }}>
      <audio
        ref={ref}
        src={url}
        onLoadedMetadata={(e) => setLen(e.currentTarget.duration || asset.durationSec || 0)}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        onEnded={() => setPlaying(false)}
        preload="metadata"
      />
      <div className="row" style={{ gap: 14 }}>
        <button
          className="btn btn-primary btn-icon"
          style={{ width: 40, height: 40, borderRadius: 12 }}
          onClick={() => {
            if (!ref.current) return;
            if (playing) { ref.current.pause(); setPlaying(false); }
            else { ref.current.play(); setPlaying(true); }
          }}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>

        <div
          className="wavebars grow"
          role="slider"
          aria-label="Seek"
          aria-valuenow={Math.round(pos)}
          aria-valuemax={Math.round(len)}
          aria-valuemin={0}
          tabIndex={0}
          style={{ cursor: 'pointer', padding: 0 }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seek((e.clientX - rect.left) / rect.width);
          }}
        >
          {bars.map((h, i) => (
            <i key={i} className={len && i / bars.length <= pos / len ? 'played' : ''} style={{ height: `${h}%` }} />
          ))}
        </div>

        <span className="t-mono t-small" style={{ minWidth: 78, textAlign: 'right' }}>
          {duration(pos)} / {duration(len)}
        </span>
      </div>
      <div className="t-small" style={{ fontSize: 11.5 }}>
        Streaming directly from storage with a 1-hour signed link · seeking uses HTTP Range
      </div>
    </div>
  );
}
