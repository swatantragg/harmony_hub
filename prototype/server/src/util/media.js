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
  buf.write('GCLOUD-PROTOTYPE-VIDEO-PAYLOAD', 0);
  for (let i = 40; i < buf.length; i += 1) buf[i] = (i * 37 + h) % 256;
  return buf;
}

// ── PDF: a real, openable PDF 1.4 file ───────────────────────────────────────
// Written by hand rather than pulled from a library, for the same reason localS3 and
// the JWT signer are: the preview panel has to open a genuine document, and the whole
// server still installs with two packages.
const pdfEscape = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);

export function pdfDoc({ title, lines = [], subtitle = '' }) {
  const body = [
    'BT', '/F2 20 Tf', '56 786 Td', `(${pdfEscape(title)}) Tj`, 'ET',
    ...(subtitle ? ['BT', '/F1 11 Tf', '56 764 Td', `(${pdfEscape(subtitle)}) Tj`, 'ET'] : []),
    '0.72 0.72 0.78 RG', '0.8 w', '56 752 m 539 752 l S',
    ...lines.flatMap((line, i) => [
      'BT', `/F1 ${line.startsWith('#') ? 13 : 11} Tf`,
      `56 ${722 - i * 19} Td`, `(${pdfEscape(line.replace(/^#\s*/, ''))}) Tj`, 'ET',
    ]),
  ].join('\n');

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>',
    `<</Length ${Buffer.byteLength(body)}>>\nstream\n${body}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>',
  ];

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ── ZIP writer (stored, no compression) — the container under every OOXML file ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, body } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const crc = crc32(data);

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0, 8); // stored
    head.writeUInt16LE(0x21, 12); // fixed date, so the bytes are deterministic
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += head.length + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirBuf, end]);
}

// ── Excel: a real .xlsx, opened by Excel, Sheets, Numbers and the preview panel ──
export function xlsxDoc({ sheetName = 'Sheet1', rows = [] }) {
  const col = (n) => {
    let s = '';
    for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) s = String.fromCharCode(65 + (i % 26)) + s;
    return s;
  };
  const sheetData = rows
    .map((cells, r) => {
      const body = cells
        .map((value, c) => {
          const ref = `${col(c)}${r + 1}`;
          if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value ?? '')}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${body}</row>`;
    })
    .join('');

  return zip([
    {
      name: '[Content_Types].xml',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`,
    },
  ]);
}

// ── Word: a real .docx ───────────────────────────────────────────────────────
export function docxDoc({ paragraphs = [] }) {
  const body = paragraphs
    .map((text) => {
      const heading = text.startsWith('# ');
      const run = escapeXml(text.replace(/^#\s*/, ''));
      return `<w:p><w:pPr>${heading ? '<w:pStyle w:val="Heading1"/>' : ''}</w:pPr><w:r>${heading ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : ''}<w:t xml:space="preserve">${run}</w:t></w:r></w:p>`;
    })
    .join('');

  return zip([
    {
      name: '[Content_Types].xml',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    {
      name: 'word/document.xml',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ]);
}

export function csvDoc({ rows = [] }) {
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return Buffer.from(rows.map((r) => r.map(cell).join(',')).join('\n'), 'utf8');
}

export const ALL_CONTROLLED_TAGS = Object.values(CONTROLLED_TAGS).flat();
