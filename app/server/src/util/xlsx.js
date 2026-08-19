// Writing a real .xlsx, with no library.
//
// The client already reads Office files this way — client/src/lib/ooxml.ts opens a
// spreadsheet with DecompressionStream and DOMParser because both halves are already in
// the browser. This is the same trade in the other direction: an .xlsx is a ZIP of XML
// parts, Node ships `zlib` and a CRC is thirty lines, so the export costs one file rather
// than a spreadsheet library and its transitive tree on the credential-handling server.
//
// What this deliberately is not: a spreadsheet engine. No formulas, no charts, no merged
// cells, no themes. It writes a table with a bold frozen header, sensible column widths,
// a filter dropdown on every column, and text or numbers in the cells — which is what an
// exported log is.
//
// Strings are written as inline strings rather than through a shared-string table. The
// table is a size optimisation for documents that repeat the same text thousands of
// times; a log mostly does not, and inline strings keep the writer to one pass with no
// second index to keep consistent. Excel, LibreOffice, Numbers and Google Sheets all read
// them, as does the reader in ooxml.ts.
import zlib from 'node:zlib';

/* ── CRC-32, as the ZIP format defines it ────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/* ── ZIP ─────────────────────────────────────────────────────────────────── */

// MS-DOS date and time, which is what a ZIP entry carries. Two seconds of resolution and
// no year before 1980 — neither matters for a file that is about to be opened once.
function dosStamp(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * Builds a ZIP container from `{ name: contents }`.
 *
 * Every entry is deflated. Bit 11 of the general-purpose flags is set so the entry names
 * are read as UTF-8 — every name here is ASCII, but a reader that guesses at the encoding
 * is a reader that will one day guess wrong.
 */
function zip(files, now = new Date()) {
  const { time, day } = dosStamp(now);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const raw = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // no extra field
    nameBuf.copy(local, 30);

    const entry = Buffer.alloc(46 + nameBuf.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);          // version made by
    entry.writeUInt16LE(20, 6);          // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt16LE(0, 30);          // extra
    entry.writeUInt16LE(0, 32);          // comment
    entry.writeUInt16LE(0, 34);          // disk number
    entry.writeUInt16LE(0, 36);          // internal attributes
    entry.writeUInt32LE(0, 38);          // external attributes
    entry.writeUInt32LE(offset, 42);
    nameBuf.copy(entry, 46);

    locals.push(local, deflated);
    central.push(entry);
    offset += local.length + deflated.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

/* ── XML ─────────────────────────────────────────────────────────────────── */

// XML 1.0 has no way to represent most control characters, not even escaped, and a log
// row can contain anything a user agent header contained. They are dropped rather than
// escaped, because a spreadsheet Excel refuses to open is worse than a lost 0x07.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

const esc = (value) =>
  String(value ?? '')
    .replace(CONTROL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Excel's own ceiling on a single cell. Anything longer makes the file unopenable, so a
// very long `after` payload is cut with a marker rather than silently corrupting the
// export.
const CELL_MAX = 32_767;

const columnName = (index) => {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

/* ── Sheets ──────────────────────────────────────────────────────────────── */

function cell(ref, value, { header = false } = {}) {
  if (value == null || value === '') return `<c r="${ref}"${header ? ' s="1"' : ''}/>`;
  // A number is written as a number so it sorts and sums as one. Strings that merely look
  // numeric — an id, an IP address — stay text, which is why the check is on the type
  // rather than on the shape of the text.
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${header ? ' s="1"' : ''}><v>${value}</v></c>`;
  }
  let text = String(value);
  if (text.length > CELL_MAX) text = `${text.slice(0, CELL_MAX - 20)}… [truncated]`;
  // xml:space="preserve" keeps leading and trailing spaces, which Excel would otherwise
  // trim — and in a log the padding is sometimes the evidence.
  return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function sheetXml({ columns, rows, freezeHeader = true, filter = true }) {
  const widths = columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 18}" customWidth="1"/>`)
    .join('');

  const headerRow = `<row r="1">${columns.map((c, i) => cell(`${columnName(i)}1`, c.header, { header: true })).join('')}</row>`;

  const body = rows
    .map((row, r) => {
      const cells = columns.map((c, i) => cell(`${columnName(i)}${r + 2}`, row[c.key])).join('');
      return `<row r="${r + 2}">${cells}</row>`;
    })
    .join('');

  const lastColumn = columnName(Math.max(0, columns.length - 1));
  const lastRow = rows.length + 1;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>
<dimension ref="A1:${lastColumn}${Math.max(1, lastRow)}"/>
<sheetViews><sheetView workbookViewId="0"${
    // The header stays put while a long log scrolls under it. On a 5,000-row export this
    // is the difference between a readable table and a wall of unlabelled columns.
    freezeHeader ? '><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : '>'
  }</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths}</cols>
<sheetData>${headerRow}${body}</sheetData>
${filter && rows.length ? `<autoFilter ref="A1:${lastColumn}${lastRow}"/>` : ''}
</worksheet>`;
}

/* ── Workbook ────────────────────────────────────────────────────────────── */

// Excel refuses a sheet name containing any of : \ / ? * [ ], or longer than 31
// characters. The caller's name is fixed up rather than rejected — an export is not the
// place to fail over a punctuation mark.
const safeSheetName = (name, fallback) =>
  String(name ?? '').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || fallback;

/**
 * Builds a workbook.
 *
 * @param {{name: string, columns: {key: string, header: string, width?: number}[],
 *          rows: Record<string, string|number|null>[], filter?: boolean}[]} sheets
 * @returns {Buffer} the .xlsx bytes
 */
export function workbook(sheets, { createdAt = new Date() } = {}) {
  const named = sheets.map((s, i) => ({ ...s, name: safeSheetName(s.name, `Sheet${i + 1}`) }));

  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,

    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,

    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`,

    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,

    // Two styles: the default, and index 1 — bold on a light fill — for the header row.
    // Any more than that is a theme, and a theme is not what an export is for.
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF1F2430"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEDF0F5"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
  };

  named.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sheet);
  });

  return zip(files, createdAt);
}

// A filename that survives a Content-Disposition header, a Windows filesystem and a mail
// client: ASCII, no path separators, no punctuation anybody argues about.
export const safeFilename = (name) =>
  String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
