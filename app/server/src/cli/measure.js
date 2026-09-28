import { performance } from 'node:perf_hooks';
import { connect, disconnect } from '../db/mongo.js';
import { db, load, allAssets } from '../db.js';
import { runSearch } from '../routes/search.js';
import { CATALOGUE_LIMITS } from '../config.js';

// ── Why this exists ─────────────────────────────────────────────────────────
// The catalogue is held in process memory and every search is an O(n) pass over
// it (see db/store.js). That is the right shape for a few thousand assets and
// the wrong shape for a few hundred thousand, and the number that decides which
// one this library is has never been measured.
//
// So: measure it. Read-only — this opens no write, touches no Drive, and is
// safe to point at production. What it prints is the input to one decision,
// written out at the bottom: keep the in-memory catalogue, or move assets into
// a collection of their own and query Mongo for them.

const MB = 1024 ** 2;
const GB = 1024 ** 3;

const bytes = (n) => (n >= GB ? `${(n / GB).toFixed(2)} GB` : `${(n / MB).toFixed(1)} MB`);
const ms = (n) => `${n.toFixed(1)} ms`;
const pad = (s, n) => String(s).padEnd(n);
const num = (n) => n.toLocaleString('en-GB');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

/** Rough resident cost of a collection: what it weighs as JSON, which tracks
 *  the real heap cost closely enough to decide on an order of magnitude. */
const weigh = (value) => Buffer.byteLength(JSON.stringify(value ?? null));

function timeSearch(query, runs) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    runSearch(query);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { p50: percentile(samples, 50), p95: percentile(samples, 95), runs };
}

async function main() {
  const json = process.argv.includes('--json');
  const runs = Math.max(3, Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1]) || 25);

  await connect();

  const bootStarted = performance.now();
  const loaded = await load();
  const bootMs = performance.now() - bootStarted;

  const rows = allAssets();
  const withDeleted = allAssets({ includeDeleted: true });

  let catalogued = 0;
  let largest = 0;
  for (const { asset } of rows) {
    const size = asset.drive?.sizeBytes || 0;
    catalogued += size;
    if (size > largest) largest = size;
  }

  const collections = Object.entries(loaded.counts)
    .map(([name, count]) => ({ name, count, heap: weigh(db[name]) }))
    .sort((a, b) => b.heap - a.heap);

  const workingSet = collections.reduce((n, c) => n + c.heap, 0);

  // The three shapes a search actually takes, in the order they cost: an
  // unfiltered first page, a faceted browse, and a typed term.
  const search = {
    unfiltered: timeSearch({}, runs),
    filtered: timeSearch({ family: 'Audio' }, runs),
    term: timeSearch({ q: rows[0]?.asset?.displayName?.split(' ')?.[0] || 'a' }, runs),
  };

  const heap = process.memoryUsage();
  const { warnAssets, rewriteAssets } = CATALOGUE_LIMITS;

  const verdict = rows.length >= rewriteAssets
    ? 'REWRITE'
    : rows.length >= warnAssets
      ? 'WARN'
      : 'HOLD';

  const report = {
    measuredAt: new Date().toISOString(),
    assets: rows.length,
    assetsIncludingDeleted: withDeleted.length,
    songs: db.songs.length,
    folders: db.folders.length,
    cataloguedBytes: catalogued,
    largestFileBytes: largest,
    workingSetBytes: workingSet,
    rssBytes: heap.rss,
    heapUsedBytes: heap.heapUsed,
    bootLoadMs: bootMs,
    search,
    thresholds: { warnAssets, rewriteAssets },
    verdict,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n  Catalogue size');
  console.log(`    ${pad('assets (live)', 26)} ${num(rows.length)}`);
  console.log(`    ${pad('assets (incl. deleted)', 26)} ${num(withDeleted.length)}`);
  console.log(`    ${pad('songs / folders', 26)} ${num(db.songs.length)} / ${num(db.folders.length)}`);
  console.log(`    ${pad('bytes catalogued in Drive', 26)} ${bytes(catalogued)}`);
  console.log(`    ${pad('largest single file', 26)} ${bytes(largest)}`);

  console.log('\n  Memory — the whole catalogue is resident');
  console.log(`    ${pad('working set (as JSON)', 26)} ${bytes(workingSet)}`);
  console.log(`    ${pad('heap used', 26)} ${bytes(heap.heapUsed)}`);
  console.log(`    ${pad('RSS', 26)} ${bytes(heap.rss)}`);
  console.log(`    ${pad('boot load() took', 26)} ${ms(bootMs)}`);
  console.log('\n    heaviest collections');
  for (const c of collections.slice(0, 6)) {
    console.log(`      ${pad(c.name, 22)} ${pad(num(c.count), 9)} ${bytes(c.heap)}`);
  }

  console.log(`\n  Search — O(n) pass over the working set, ${runs} runs each`);
  for (const [name, s] of Object.entries(search)) {
    console.log(`    ${pad(name, 26)} p50 ${pad(ms(s.p50), 10)} p95 ${ms(s.p95)}`);
  }

  console.log('\n  Verdict');
  if (verdict === 'HOLD') {
    console.log(`    HOLD — ${num(rows.length)} assets is well under the ${num(warnAssets)} mark.`);
    console.log('    The in-memory catalogue is the right shape for this size. Moving assets');
    console.log('    into their own collection would add risk and buy nothing measurable.');
  } else if (verdict === 'WARN') {
    console.log(`    WARN — ${num(rows.length)} assets is past ${num(warnAssets)}.`);
    console.log('    Still workable, but plan the move to a queried assets collection now');
    console.log(`    rather than at ${num(rewriteAssets)}, where it stops being optional.`);
  } else {
    console.log(`    REWRITE — ${num(rows.length)} assets is past ${num(rewriteAssets)}.`);
    console.log('    Assets need their own MongoDB collection with indexes, and search needs');
    console.log('    to query it rather than scan memory. Everything else waits on that.');
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
