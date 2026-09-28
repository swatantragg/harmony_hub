#!/usr/bin/env node
// Rebuilds server/src/tag-vocabulary.js from the content sheets in doc/.
//
// The song, artist and event tag sections are picked from a list rather than
// typed, because typing is what produces "Sonu Nigam" and "Sonu nigam" as two
// tags and a search that finds half of what it should. That list has to come
// from the sheets the label actually maintains, and has to be regenerated when
// one of them is replaced — by hand it drifts, and it has drifted before.
//
// No dependencies. Node 22 has DecompressionStream, and an .xlsx is a zip of
// XML, so the reader is thirty lines rather than a package. Same approach as
// client/src/lib/ooxml.ts, which reads these files in the browser.
//
//   node scripts/build-tag-vocabulary.mjs            # write it
//   node scripts/build-tag-vocabulary.mjs --check    # fail if it would change

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const DOC = path.resolve(APP, '../doc');
const TARGET = path.join(APP, 'server/src/tag-vocabulary.js');

const SOURCES = [
  {
    constant: 'SONG_TAGS',
    file: 'Goongoonalo_Content_Mgt_Songs_2026-09-17.xlsx',
    sheet: 'Content Mgt. Songs',
    column: 'Song Name',
  },
  {
    constant: 'ARTIST_TAGS',
    file: 'Total Goongoonalo Artist.xlsx',
    sheet: 'GG Artist',
    column: 'Artist Name',
  },
  {
    constant: 'EVENT_TAGS',
    file: 'Goongoonalo_Content_Mgt_Events_2026-09-17.xlsx',
    sheet: 'Content Mgt. Events',
    column: 'Event Name',
  },
];

// ── A minimal .xlsx reader ──────────────────────────────────────────────────

const dec = new TextDecoder('utf-8');

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65_558; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP container');

  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const out = new Map();

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

    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

/** All <t> text inside one chunk of XML, concatenated — a shared string may be
 *  split across several runs when part of it is styled differently. */
const textOf = (xml) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');

const columnIndex = (ref) => {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

async function readSheet(file, wanted) {
  const files = await unzip((await readFile(file)).buffer);

  const sharedXml = files.get('xl/sharedStrings.xml');
  const shared = sharedXml
    ? [...dec.decode(sharedXml).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
    : [];

  const workbook = dec.decode(files.get('xl/workbook.xml') ?? new Uint8Array());
  const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unescapeXml(m[1]));

  const paths = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  const at = names.indexOf(wanted);
  const sheetPath = at >= 0 ? paths[at] : paths[0];
  if (!sheetPath) throw new Error(`no worksheet "${wanted}" in ${path.basename(file)}`);

  const xml = dec.decode(files.get(sheetPath));
  const rows = [];
  for (const [, rowXml] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const [, attrs, body] of rowXml.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const inner = body ?? '';
      const value = type === 's'
        ? shared[Number(unescapeXml(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '-1'))] ?? ''
        : type === 'inlineStr'
          ? textOf(inner)
          : unescapeXml(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
      const idx = ref ? columnIndex(ref) : cells.length;
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

// ── Cleaning ────────────────────────────────────────────────────────────────

// A spreadsheet copy drags invisibles along: word joiners, zero-width spaces,
// soft hyphens, non-breaking spaces. None of them is whitespace to \s, so they
// survive a naive trim and then split one name into two tags that look
// identical on screen and never match each other in a search. Ten song titles
// in these sheets carry a U+2060, and six carried a trailing comma.
const INVISIBLE = /[​‌‍⁠﻿­]/g;

const clean = (value) => String(value ?? '')
  .replace(INVISIBLE, '')
  .replace(/ /g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[,;]+$/, '')
  .trim();

function namesFrom(rows, header) {
  const headerRow = rows.find((r) => r.some((c) => clean(c) === header));
  const at = headerRow ? headerRow.findIndex((c) => clean(c) === header) : -1;
  if (at < 0) throw new Error(`no column "${header}"`);

  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const name = clean(row[at]);
    if (!name || name === header) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// ── Emit ────────────────────────────────────────────────────────────────────

const HEADER = `// Canonical names lifted from the Goongoonalo content sheets, so a tag for a song,
// an artist or an event is picked from a list rather than retyped. Retyping is what
// produces "Sonu Nigam" and "Sonu nigam" as two different tags, and a search that
// finds half of what it should.
//
// GENERATED — do not hand-edit. Re-run \`npm run tags:build\` after replacing a sheet
// in doc/, and commit what it writes. \`npm run tags:check\` fails if the two disagree.
//
// The generator strips the invisibles a spreadsheet copy drags along — word joiners,
// zero-width spaces, non-breaking spaces — and any stray trailing comma. Both split
// one name into two tags that look identical on screen and never match in a search.
//
// Anything added later through the Custom tag box, with a section chosen, joins the
// matching list at runtime — see POST /api/tags. These arrays are the starting point,
// not a closed set.
`;

async function build() {
  const blocks = [];
  const counts = {};

  for (const source of SOURCES) {
    const file = path.join(DOC, source.file);
    const rows = await readSheet(file, source.sheet);
    const names = namesFrom(rows, source.column);
    if (!names.length) throw new Error(`${source.file}: column "${source.column}" produced nothing`);

    counts[source.constant] = names.length;
    blocks.push(
      `// ${names.length} names — doc/${source.file}, column “${source.column}”.\n`
      + `export const ${source.constant} = [\n`
      + names.map((n) => `  ${JSON.stringify(n)},`).join('\n')
      + '\n];\n',
    );
  }

  const sources = SOURCES
    .map((s) => `//   doc/${s.file}${' '.repeat(Math.max(1, 52 - s.file.length))}column "${s.column}"`)
    .join('\n');

  return { text: `${HEADER}//\n// Sources:\n${sources}\n\n${blocks.join('\n')}`, counts };
}

const { text, counts } = await build();
const existing = await readFile(TARGET, 'utf8').catch(() => null);
const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');

if (process.argv.includes('--check')) {
  if (existing === text) {
    console.log(`tag vocabulary is up to date — ${summary}`);
  } else {
    console.error('tag vocabulary is stale — run `npm run tags:build` and commit the result');
    process.exitCode = 1;
  }
} else if (existing === text) {
  console.log(`tag vocabulary unchanged — ${summary}`);
} else {
  await writeFile(TARGET, text, 'utf8');
  console.log(`wrote ${path.relative(APP, TARGET)} — ${summary}`);
}
