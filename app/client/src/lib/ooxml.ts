// Reading .xlsx / .docx / .pptx in the browser, with no library.
//
// An Office file is a ZIP of XML parts. The browser already ships both halves of what is
// needed to open one — DecompressionStream for the deflate payloads and DOMParser for the
// XML — so the preview panel renders a spreadsheet or a document without adding a
// megabyte of parser to the bundle, in the same spirit as the hand-rolled Drive and JWT
// layers on the server.
//
// What this does NOT do: styling, formulas, merged cells, images, charts. It recovers the
// content, which is what a preview is for. Anything it cannot read falls back to download.

interface ZipEntry { name: string; data: Uint8Array }

const dec = new TextDecoder('utf-8');

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const canReadOoxml = () => typeof DecompressionStream !== 'undefined';

// Walks the central directory backwards from the end-of-central-directory record, which
// is the only reliable way to enumerate a ZIP — local headers may carry deferred sizes.
export async function unzip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65_558; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP container');

  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = dec.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));

    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(start, start + compressedSize);

    entries.push({ name, data: method === 0 ? raw : new Uint8Array(0) });
    if (method === 8) entries[entries.length - 1].data = await inflateRaw(raw);
    else if (method !== 0) entries.pop();

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return new Map(entries.map((e) => [e.name, e.data]));
}

const parseXml = (data: Uint8Array | undefined) =>
  (data ? new DOMParser().parseFromString(dec.decode(data), 'application/xml') : null);

const textOf = (node: Element | null, selector: string) =>
  Array.from(node?.getElementsByTagName(selector) ?? []).map((n) => n.textContent ?? '').join('');

/* ── Spreadsheets ────────────────────────────────────────────────────────── */

export interface SheetData { name: string; rows: string[][] }

const columnIndex = (ref: string) => {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export async function readXlsx(buffer: ArrayBuffer): Promise<SheetData[]> {
  const files = await unzip(buffer);

  // Shared strings are the common case in files Excel itself writes; inline strings are
  // what most exporters emit. Both are handled.
  const sharedDoc = parseXml(files.get('xl/sharedStrings.xml'));
  const shared = Array.from(sharedDoc?.getElementsByTagName('si') ?? []).map((si) => textOf(si, 't'));

  const workbook = parseXml(files.get('xl/workbook.xml'));
  const names = Array.from(workbook?.getElementsByTagName('sheet') ?? []).map((s) => s.getAttribute('name') ?? 'Sheet');

  const sheetPaths = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));

  return sheetPaths.map((path, i) => {
    const doc = parseXml(files.get(path));
    const rows: string[][] = [];
    for (const row of Array.from(doc?.getElementsByTagName('row') ?? [])) {
      const cells: string[] = [];
      for (const cell of Array.from(row.getElementsByTagName('c'))) {
        const at = columnIndex(cell.getAttribute('r') ?? `A${rows.length + 1}`);
        const type = cell.getAttribute('t');
        let value = '';
        if (type === 's') value = shared[Number(textOf(cell, 'v'))] ?? '';
        else if (type === 'inlineStr') value = textOf(cell, 't');
        else if (type === 'str') value = textOf(cell, 'v');
        else value = textOf(cell, 'v');
        while (cells.length < at) cells.push('');
        cells[at] = value;
      }
      rows.push(cells);
    }
    return { name: names[i] ?? `Sheet ${i + 1}`, rows };
  });
}

/* ── Word ────────────────────────────────────────────────────────────────── */

export interface DocBlock { text: string; heading: boolean }

export async function readDocx(buffer: ArrayBuffer): Promise<DocBlock[]> {
  const files = await unzip(buffer);
  const doc = parseXml(files.get('word/document.xml'));
  if (!doc) throw new Error('No document part');

  return Array.from(doc.getElementsByTagName('w:p')).map((p) => {
    const style = p.getElementsByTagName('w:pStyle')[0]?.getAttribute('w:val') ?? '';
    const bold = p.getElementsByTagName('w:b').length > 0;
    return {
      text: Array.from(p.getElementsByTagName('w:t')).map((t) => t.textContent ?? '').join(''),
      heading: /^Heading|^Title/i.test(style) || bold,
    };
  });
}

/* ── PowerPoint ──────────────────────────────────────────────────────────── */

export interface Slide { index: number; lines: string[] }

export async function readPptx(buffer: ArrayBuffer): Promise<Slide[]> {
  const files = await unzip(buffer);
  const paths = [...files.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));

  return paths.map((path, i) => {
    const doc = parseXml(files.get(path));
    const lines = Array.from(doc?.getElementsByTagName('a:p') ?? [])
      .map((p) => Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent ?? '').join(''))
      .filter((line) => line.trim().length > 0);
    return { index: i + 1, lines };
  });
}

/* ── CSV / TSV — same table view, no ZIP involved ────────────────────────── */

export function readDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
