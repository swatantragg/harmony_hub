// One viewer for every file type the product stores, used identically inside the app and
// on the public share page — so what a partner sees before downloading is exactly what the
// person who sent it saw before sharing.
//
// Every byte here arrives over a short-lived signed URL. The
// API never proxies content, and nothing is transcoded: audio and video seek with HTTP
// Range, the PDF is handed to the browser's own viewer, and the office formats are
// unpacked in the page by lib/ooxml.ts.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Film, Pause, Play, FileSpreadsheet, Presentation, FileArchive,
  File as FileIcon, Download, Loader2, TriangleAlert,
} from 'lucide-react';
import { duration, bytes } from '../../lib/format';
import { previewKind, isOoxml, extensionOf, KIND_LABEL } from '../../lib/previewKind';
import type { PreviewKind } from '../../lib/previewKind';
import { canReadOoxml, readXlsx, readDocx, readPptx, readDelimited } from '../../lib/ooxml';
import type { DocBlock, SheetData, Slide } from '../../lib/ooxml';

export interface PreviewFile {
  displayName: string;
  mimeType: string;
  sizeBytes?: number;
  durationSec?: number | null;
  dimensions?: string | null;
  seed?: string;
}

export function FilePreview({
  file, url, height = 320, onDownload,
}: {
  file: PreviewFile;
  url: string | null;
  height?: number;
  onDownload?: () => void;
}) {
  const kind = previewKind(file.mimeType, file.displayName);

  if (!url) {
    return (
      <div className="preview-stage" style={{ minHeight: 120 }}>
        <div className="row-tight t-small"><Loader2 size={14} /> Requesting a preview link…</div>
      </div>
    );
  }

  switch (kind) {
    case 'image':
      return (
        <div className="preview-stage" style={{ maxHeight: height + 60 }}>
          <img src={url} alt={file.displayName} style={{ maxHeight: height + 40 }} />
        </div>
      );
    case 'audio':
      return <AudioPreview url={url} file={file} />;
    case 'video':
      return <VideoPreview url={url} file={file} />;
    case 'pdf':
      return <PdfPreview url={url} file={file} height={height} onDownload={onDownload} />;
    case 'text':
      return <TextPreview url={url} file={file} height={height} />;
    case 'table':
      return <DelimitedPreview url={url} file={file} height={height} />;
    case 'sheet':
      return <SheetPreview url={url} file={file} height={height} onDownload={onDownload} />;
    case 'word':
      return <WordPreview url={url} file={file} height={height} onDownload={onDownload} />;
    case 'slides':
      return <SlidesPreview url={url} file={file} height={height} onDownload={onDownload} />;
    default:
      return <Unsupported file={file} kind={kind} onDownload={onDownload} />;
  }
}

/* ── Shared shells ───────────────────────────────────────────────────────── */

function Stage({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="preview-stage col" style={{ gap: 10, padding: 24, textAlign: 'center', ...style }}>{children}</div>;
}

function Loading() {
  return <Stage><Loader2 size={20} color="var(--ink-3)" /><div className="t-small">Opening…</div></Stage>;
}

function Unsupported({
  file, kind, onDownload, reason,
}: { file: PreviewFile; kind: PreviewKind; onDownload?: () => void; reason?: string }) {
  const Icon = kind === 'archive' ? FileArchive : kind === 'sheet' ? FileSpreadsheet : kind === 'slides' ? Presentation : FileIcon;
  return (
    <Stage>
      <Icon size={26} color="var(--info)" />
      <div className="t-small" style={{ maxWidth: '42ch' }}>
        {reason ?? `${KIND_LABEL[kind]} files open in the application they were made for. The file itself is stored and downloadable — only the in-page viewer stops here.`}
      </div>
      <div className="t-mono t-small">
        {extensionOf(file.displayName).toUpperCase() || 'FILE'}
        {file.sizeBytes != null ? ` · ${bytes(file.sizeBytes)}` : ''}
      </div>
      {onDownload && (
        <button className="btn btn-secondary btn-sm" onClick={onDownload}><Download size={13} /> Download to open</button>
      )}
    </Stage>
  );
}

// Everything below fetches its own bytes. The signed URL is the same one the <img> or
// <video> would use — the browser is talking to storage either way.
function useFetched<T>(url: string, read: (buffer: ArrayBuffer) => Promise<T> | T, deps: unknown[] = []) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState({ data: null, error: null });
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Storage returned ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => read(b))
      .then((data) => alive && setState({ data, error: null }))
      .catch((e: Error) => alive && setState({ data: null, error: e.message }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  return state;
}

/* ── PDF ─────────────────────────────────────────────────────────────────── */

function PdfPreview({
  url, file, height, onDownload,
}: { url: string; file: PreviewFile; height: number; onDownload?: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <Unsupported
        file={file}
        kind="pdf"
        onDownload={onDownload}
        reason="This browser blocked the inline PDF viewer. The document is stored and downloads normally."
      />
    );
  }
  return (
    <div className="preview-stage" style={{ padding: 0, alignItems: 'stretch', overflow: 'hidden' }}>
      <object
        data={url}
        type="application/pdf"
        style={{ width: '100%', height: height + 90, border: 0, display: 'block' }}
        onError={() => setFailed(true)}
        aria-label={file.displayName}
      >
        <iframe src={url} title={file.displayName} style={{ width: '100%', height: height + 90, border: 0 }} />
      </object>
    </div>
  );
}

/* ── Text, markdown, JSON ────────────────────────────────────────────────── */

function TextPreview({ url, file, height }: { url: string; file: PreviewFile; height: number }) {
  const { data, error } = useFetched(url, (b) => new TextDecoder().decode(b).slice(0, 200_000));
  if (error) return <Stage><TriangleAlert size={22} color="var(--danger)" /><div className="t-small">{error}</div></Stage>;
  if (data == null) return <Loading />;

  const pretty = file.displayName.endsWith('.json')
    ? (() => { try { return JSON.stringify(JSON.parse(data), null, 2); } catch { return data; } })()
    : data;

  return (
    <div className="preview-stage" style={{ alignItems: 'stretch', padding: 0 }}>
      <pre
        style={{
          margin: 0, padding: 18, fontFamily: 'var(--mono)', fontSize: 14.5, lineHeight: 1.7,
          whiteSpace: 'pre-wrap', maxHeight: height, overflowY: 'auto', color: 'var(--ink-2)', width: '100%',
        }}
      >
        {pretty}
      </pre>
    </div>
  );
}

/* ── Tables: CSV, TSV, and every sheet of an .xlsx ───────────────────────── */

function Grid({ rows, height }: { rows: string[][]; height: number }) {
  if (rows.length === 0) return <div className="t-small" style={{ padding: 18 }}>This sheet is empty.</div>;
  const [head, ...body] = rows;
  return (
    <div style={{ maxHeight: height, overflow: 'auto', width: '100%' }}>
      <table className="tbl" style={{ fontSize: 14.5 }}>
        <thead>
          <tr>{head.map((cell, i) => <th key={i}>{cell}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} style={{ cursor: 'default' }}>
              {head.map((_, c) => (
                <td key={c} style={{ fontFamily: /^[\d.,₹%-]+$/.test(row[c] ?? '') ? 'var(--mono)' : undefined }}>
                  {row[c] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DelimitedPreview({ url, file, height }: { url: string; file: PreviewFile; height: number }) {
  const delimiter = file.displayName.endsWith('.tsv') ? '\t' : ',';
  const { data, error } = useFetched(url, (b) => readDelimited(new TextDecoder().decode(b), delimiter), [delimiter]);
  if (error) return <Stage><TriangleAlert size={22} color="var(--danger)" /><div className="t-small">{error}</div></Stage>;
  if (!data) return <Loading />;
  return (
    <div className="preview-stage" style={{ alignItems: 'stretch', padding: 0, overflow: 'hidden' }}>
      <Grid rows={data} height={height} />
      <div className="t-small" style={{ padding: '8px 14px', borderTop: '1px solid var(--line)', fontSize: 14 }}>
        {data.length - 1} rows · read in the browser, straight from storage
      </div>
    </div>
  );
}

function SheetPreview({
  url, file, height, onDownload,
}: { url: string; file: PreviewFile; height: number; onDownload?: () => void }) {
  const readable = isOoxml(file.displayName) && canReadOoxml();
  const { data, error } = useFetched<SheetData[]>(url, (b) => (readable ? readXlsx(b) : Promise.resolve([])), [readable]);
  const [active, setActive] = useState(0);

  if (!readable) {
    return (
      <Unsupported
        file={file} kind="sheet" onDownload={onDownload}
        reason={
          canReadOoxml()
            ? 'This is a legacy Excel file (.xls). Save it as .xlsx to preview it here — the file itself downloads and opens normally.'
            : 'This browser cannot unpack Office files in the page. The spreadsheet downloads and opens normally.'
        }
      />
    );
  }
  if (error) return <Unsupported file={file} kind="sheet" onDownload={onDownload} reason={`Could not read the workbook (${error}).`} />;
  if (!data) return <Loading />;
  if (data.length === 0) return <Unsupported file={file} kind="sheet" onDownload={onDownload} reason="No worksheets found in this workbook." />;

  return (
    <div className="preview-stage" style={{ alignItems: 'stretch', padding: 0, overflow: 'hidden' }}>
      {data.length > 1 && (
        <div className="tabs" style={{ padding: '0 10px' }}>
          {data.map((sheet, i) => (
            <button key={sheet.name} className={`tab ${active === i ? 'on' : ''}`} onClick={() => setActive(i)}>
              {sheet.name}
            </button>
          ))}
        </div>
      )}
      <Grid rows={data[active].rows} height={height} />
      <div className="t-small" style={{ padding: '8px 14px', borderTop: '1px solid var(--line)', fontSize: 14 }}>
        {data[active].rows.length} rows · values only — formatting, formulas and charts are not rendered
      </div>
    </div>
  );
}

/* ── Word ────────────────────────────────────────────────────────────────── */

function WordPreview({
  url, file, height, onDownload,
}: { url: string; file: PreviewFile; height: number; onDownload?: () => void }) {
  const readable = isOoxml(file.displayName) && canReadOoxml();
  const { data, error } = useFetched<DocBlock[]>(url, (b) => (readable ? readDocx(b) : Promise.resolve([])), [readable]);

  if (!readable) {
    return (
      <Unsupported
        file={file} kind="word" onDownload={onDownload}
        reason={
          canReadOoxml()
            ? 'This is a legacy Word file (.doc). Save it as .docx to preview it here — the file itself downloads and opens normally.'
            : 'This browser cannot unpack Office files in the page. The document downloads and opens normally.'
        }
      />
    );
  }
  if (error) return <Unsupported file={file} kind="word" onDownload={onDownload} reason={`Could not read the document (${error}).`} />;
  if (!data) return <Loading />;

  return (
    <div className="preview-stage" style={{ alignItems: 'stretch', padding: 0 }}>
      <div style={{ maxHeight: height, overflowY: 'auto', padding: '20px 22px', width: '100%' }}>
        {data.map((block, i) =>
          block.text.trim() === '' ? (
            <div key={i} style={{ height: 10 }} />
          ) : block.heading ? (
            <h3 key={i} className="t-h3" style={{ margin: '14px 0 6px' }}>{block.text}</h3>
          ) : (
            <p key={i} className="t-body" style={{ margin: '0 0 8px' }}>{block.text}</p>
          ),
        )}
      </div>
      <div className="t-small" style={{ padding: '8px 14px', borderTop: '1px solid var(--line)', fontSize: 14 }}>
        Text only — images, tables and styling are not rendered in the preview
      </div>
    </div>
  );
}

/* ── Slides ──────────────────────────────────────────────────────────────── */

function SlidesPreview({
  url, file, height, onDownload,
}: { url: string; file: PreviewFile; height: number; onDownload?: () => void }) {
  const readable = isOoxml(file.displayName) && canReadOoxml();
  const { data, error } = useFetched<Slide[]>(url, (b) => (readable ? readPptx(b) : Promise.resolve([])), [readable]);

  if (!readable || error) {
    return (
      <Unsupported
        file={file} kind="slides" onDownload={onDownload}
        reason={error ? `Could not read the deck (${error}).` : 'This deck cannot be unpacked in the page. It downloads and opens normally.'}
      />
    );
  }
  if (!data) return <Loading />;

  return (
    <div className="preview-stage" style={{ alignItems: 'stretch', padding: 0 }}>
      <div style={{ maxHeight: height, overflowY: 'auto', padding: 16, width: '100%', display: 'grid', gap: 12 }}>
        {data.map((slide) => (
          <div key={slide.index} className="panel" style={{ boxShadow: 'none' }}>
            <div className="panel-body" style={{ padding: 14 }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>Slide {slide.index}</div>
              {slide.lines.map((line, i) => (
                <div key={i} className={i === 0 ? 't-h3' : 't-small'} style={{ marginBottom: 4 }}>{line}</div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Video ───────────────────────────────────────────────────────────────── */

function VideoPreview({ url, file }: { url: string; file: PreviewFile }) {
  const [broken, setBroken] = useState(false);

  // Real uploads play here. The seeded demo library carries placeholder payloads rather
  // than encoded video, so the player reports it plainly instead of showing a black box.
  if (broken) {
    return (
      <Stage>
        <Film size={26} color="var(--spark-deep)" />
        <div className="t-small" style={{ maxWidth: '42ch' }}>
          The browser could not decode this file. Video streams from storage over HTTP Range
          requests with no transcoding service in the path — a real upload plays here; the
          seeded demo files carry placeholder payloads.
        </div>
        <div className="t-mono t-small">
          {file.dimensions ?? extensionOf(file.displayName).toUpperCase()}
          {file.durationSec ? ` · ${duration(file.durationSec)}` : ''}
        </div>
      </Stage>
    );
  }

  return (
    <div className="preview-stage" style={{ padding: 0, alignItems: 'stretch' }}>
      <video
        src={url}
        controls
        preload="metadata"
        onError={() => setBroken(true)}
        style={{ width: '100%', maxHeight: 380, background: '#000', display: 'block' }}
      />
    </div>
  );
}

/* ── Audio ───────────────────────────────────────────────────────────────── */

function AudioPreview({ url, file }: { url: string; file: PreviewFile }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [len, setLen] = useState(file.durationSec ?? 0);

  // A deterministic waveform drawn from the file identity — the real peaks would come from
  // a stored peaks file in production, and the interaction is identical either way.
  const bars = useMemo(() => {
    const seed = file.seed ?? file.displayName;
    return Array.from({ length: 64 }, (_, i) => {
      let h = 0;
      const s = `${seed}${i}`;
      for (let j = 0; j < s.length; j += 1) h = (h * 31 + s.charCodeAt(j)) | 0;
      return 18 + (Math.abs(h) % 82);
    });
  }, [file.seed, file.displayName]);

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
        onLoadedMetadata={(e) => setLen(e.currentTarget.duration || file.durationSec || 0)}
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
            else { void ref.current.play(); setPlaying(true); }
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
      <div className="t-small" style={{ fontSize: 14 }}>
        Streaming directly from storage with a signed link · seeking uses HTTP Range
      </div>
    </div>
  );
}
