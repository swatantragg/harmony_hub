// Synthetic media generation for the seeded library. The prototype stores REAL bytes in
// the object store, so preview, waveform scrubbing, Range streaming and checksum drift
// detection all exercise the genuine code path rather than a mock.
import { CONTROLLED_TAGS } from '../catalogue.js';

// ── Cover art / banners: deterministic SVG in the brand palette ──────────────
const PALETTES = [
  ['#5546E8', '#8B6CFF'],
  ['#FF9E44', '#E07A18'],
  ['#12A150', '#4ED08B'],
  ['#2F72E6', '#7FB0FF'],
  ['#171723', '#55566A'],
];

function hashInt(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function coverSvg({ title, subtitle, seed, width = 1200, height = 1200 }) {
  const h = hashInt(seed || title);
  const [a, b] = PALETTES[h % PALETTES.length];
  const bars = Array.from({ length: 18 }, (_, i) => {
    const bh = 18 + ((hashInt(`${seed}${i}`) % 62) / 100) * height * 0.42;
    const x = width * 0.08 + i * (width * 0.048);
    return `<rect x="${x.toFixed(0)}" y="${(height * 0.74 - bh).toFixed(0)}" width="${(width * 0.026).toFixed(0)}" height="${bh.toFixed(0)}" rx="${(width * 0.013).toFixed(0)}" fill="rgba(255,255,255,${i % 5 === 2 ? 0.95 : 0.42})"/>`;
  }).join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
  </linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  ${bars}
  <text x="${width * 0.08}" y="${height * 0.88}" fill="#fff" font-family="Space Grotesk, sans-serif" font-size="${width * 0.072}" font-weight="600">${escapeXml(title)}</text>
  <text x="${width * 0.08}" y="${height * 0.94}" fill="rgba(255,255,255,.78)" font-family="Plus Jakarta Sans, sans-serif" font-size="${width * 0.036}">${escapeXml(subtitle)}</text>
</svg>`,
    'utf8',
  );
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// ── Audio: a real, playable 8-bit PCM WAV so <audio> and the waveform work ───
export function wav({ seconds = 6, seed = 'x', sampleRate = 8000 }) {
  const n = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(n);
  const h = hashInt(seed);
  const root = 174 + (h % 8) * 24;
  const notes = [1, 1.122, 1.26, 1.335, 1.498, 1.682, 1.888, 2];
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const step = Math.floor(t * 2) % notes.length;
    const f = root * notes[(step + (h % 3)) % notes.length];
    const env = Math.min(1, t * 4) * Math.max(0, 1 - (t % 0.5) * 1.4);
    const s = Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f * 2 * t) * 0.2;
    data[i] = Math.max(0, Math.min(255, Math.round(128 + s * env * 92)));
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + n, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(n, 40);
  return Buffer.concat([header, data]);
}

// ── Documents: plain-text lyric and credit sheets ────────────────────────────
export function lyricsDoc({ title, artist }) {
  const lines = [
    `${title.toUpperCase()}`,
    `Written and performed by ${artist}`,
    '',
    '[Verse 1]',
    'Slow light on the studio floor,',
    'every take a little closer than before.',
    '',
    '[Chorus]',
    `${title}, ${title} — hold the note and let it go,`,
    'we were only ever here to make it show.',
    '',
    '[Bridge]',
    'Count it in, four on the floor,',
    'the room remembers what the tape is for.',
    '',
    '— end —',
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function creditsDoc({ title, artist, isrc }) {
  return Buffer.from(
    [
      `CREDITS — ${title}`,
      `Primary artist   ${artist}`,
      `ISRC             ${isrc}`,
      'Producer         A. Mehra',
      'Mix engineer     S. Kulkarni',
      'Master engineer  R. D’Souza',
      'Label            Northlight Records',
    ].join('\n'),
    'utf8',
  );
}

// ── Video: a tiny placeholder payload. Bytes are real (so size/ETag/Range/drift
// all behave), but no decodable stream is synthesised — the UI shows a poster.
export function videoPlaceholder({ seed, sizeKb = 96 }) {
  const h = hashInt(seed);
  const buf = Buffer.alloc(sizeKb * 1024);
  buf.write('MAESTRO-PROTOTYPE-VIDEO-PAYLOAD', 0);
  for (let i = 40; i < buf.length; i += 1) buf[i] = (i * 37 + h) % 256;
  return buf;
}

export const ALL_CONTROLLED_TAGS = Object.values(CONTROLLED_TAGS).flat();
