// Does the app fit the screen? Measured, in a real engine, at real widths.
//
// render-check.mjs answers "does it mount" using jsdom, which does no layout at
// all — a page can mount perfectly and still be 80px wider than the phone it is
// on. This renders the same pages to static HTML, drops them into the real
// built stylesheet, and measures them in headless Chrome:
//
//   · does the document scroll sideways?
//   · does any single element stick out past the viewport?
//   · is any text input under 16px, which makes iOS zoom the page on focus
//     and leave it zoomed — the usual cause of "it needs horizontal scrolling"
//   · does the type scale actually move between a phone and a desktop?
//
// Needs Chrome. Set CHROME_BIN, or have google-chrome/chromium on PATH. Skips
// with a notice rather than failing when there is no browser to measure in.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(HERE, '..');
const DIST = path.join(CLIENT, 'dist');

/** Where the app has to work, not where it is convenient to test. */
const WIDTHS = [
  { w: 320, h: 780, label: 'iPhone SE (1st gen), Galaxy Fold cover' },
  { w: 360, h: 800, label: 'the commonest Android width' },
  { w: 390, h: 844, label: 'iPhone 14 / 15' },
  { w: 430, h: 932, label: 'iPhone Pro Max' },
  { w: 768, h: 1024, label: 'iPad portrait' },
  { w: 1024, h: 768, label: 'iPad landscape, small laptop' },
  { w: 1440, h: 900, label: 'laptop' },
];

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'google-chrome-stable']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim();
    } catch { /* try the next one */ }
  }
  return null;
}

function builtCss() {
  const assets = path.join(DIST, 'assets');
  let files = [];
  try { files = readdirSync(assets).filter((f) => f.endsWith('.css')); } catch { /* not built */ }
  if (!files.length) {
    console.error('  ✗ no built stylesheet in dist/assets — run `npm run build` first');
    process.exit(1);
  }
  return files.map((f) => readFileSync(path.join(assets, f), 'utf8')).join('\n');
}

// Markup that exercises the things which actually overflow: a long unbroken
// file id, a heading with no spaces, a wide table, a full-width dialog, and the
// update notice with a realistic number of bullets.
const FIXTURES = `
<div class="shell">
  <aside class="sidebar"><div class="wordmark">GCloud</div>
    <nav class="sidebar-nav"><div class="nav-group">
      <a class="nav-item active">Everything</a><a class="nav-item">Storage health</a>
      <a class="nav-item">Manage tags</a></div></nav>
  </aside>
  <div class="main">
    <div class="topbar"><div class="searchbar topbar-search"><input placeholder="Search"></div></div>
    <div class="page stack-5">
      <div class="spread page-head">
        <h1 class="t-h1">Goongoonalo_Content_Mgt_Songs_2026-09-17.xlsx</h1>
        <div class="row"><button class="btn btn-primary">Sync from Drive now</button>
        <button class="btn btn-secondary">Run the check now</button></div>
      </div>
      <div class="note indigo"><div><b>A long note.</b> 1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R9s0T1u2V3w4X5y6Z is a Drive file id.</div></div>
      <div class="tiles status-tiles">
        ${Array.from({ length: 6 }, (_, i) => `<a class="stat"><div class="stat-k">Status ${i}</div><div class="stat-v">17941</div><div class="stat-n">Catalogued and verified in storage</div></a>`).join('')}
      </div>
      <div class="panel"><div class="panel-head"><span class="t-h3">By folder</span></div>
        <div class="panel-body stack-2">
          <div class="kv-row"><span class="t-small">Masters/2026/Unreleased</span><span class="t-small t-mono">1.37 TB</span></div>
          <div class="keytext">1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R9s0T1u2V3w4X5y6Z</div>
        </div></div>
      <div class="table-scroll"><table class="tbl"><thead><tr>
        ${['Name', 'Type', 'Artist', 'Size', 'Modified', 'Availability'].map((h) => `<th>${h}</th>`).join('')}
      </tr></thead><tbody>${Array.from({ length: 4 }, (_, i) => `<tr>
        <td>track_${i}_a_rather_long_display_name.wav</td><td>Master Audio</td><td>Hariharan</td>
        <td>4.8 GB</td><td>2026-09-17</td><td>Available</td></tr>`).join('')}</tbody></table></div>
      <div class="wrap-gap">${Array.from({ length: 14 }, (_, i) => `<button class="chip">Aaona (Hariharan Version) ${i}</button>`).join('')}</div>
      <footer class="build-tag">SK-V5.0.1</footer>
    </div>
  </div>
</div>

<div class="scrim"><div class="modal"><div class="modal-head"><h2 class="t-h2">Rename tag</h2>
  <div class="t-small">Aaj Hai Faisla (Unreleased Classic)</div></div>
  <div class="modal-body stack-3"><div class="field"><label class="label">New name</label>
  <input class="input" value="Aaj Hai Faisla (Unreleased Classic)"></div>
  <div class="note"><div>Every one of the 17,890 files carrying this tag is updated in one go.</div></div></div>
  <div class="modal-foot"><button class="btn btn-ghost">Cancel</button>
  <button class="btn btn-primary">Rename everywhere</button></div></div></div>

<div class="pwa-dock"><div class="pwa-card wide">
  <svg width="17" height="17"></svg>
  <div class="grow"><div class="pwa-title">Updated to <span class="pwa-version">SK-V5.0.1</span></div>
    <div class="pwa-body">Text now sizes itself to the device, and nothing needs scrolling sideways.</div>
    <ul class="pwa-notes">${Array.from({ length: 8 }, (_, i) => `<li>Highlight number ${i + 1}, written at about the length these actually run to in a release note.</li>`).join('')}</ul>
  </div>
  <button class="btn btn-primary btn-sm">Got it</button>
</div></div>
`;

const PROBE = `
(() => {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const out = {
    viewport: vw,
    scrollWidth: doc.scrollWidth,
    scrolls: doc.scrollWidth > vw + 1,
    overflowing: [],
    smallInputs: [],
    type: {},
  };

  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // An element inside a deliberate horizontal scroller is allowed to be wide.
    let scroller = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll') { scroller = true; break; }
    }
    if (scroller) continue;
    // Only the right edge matters. An element parked off-canvas to the left is
    // a closed drawer doing its job, not overflow — the sidebar lives there.
    if (r.right > vw + 1) {
      const parent = el.parentElement;
      out.overflowing.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.toString().slice(0, 48)) || '',
        parent: parent ? parent.tagName.toLowerCase() + '.' + (parent.className || '').toString().split(' ')[0] : '',
        text: (el.textContent || '').trim().slice(0, 28),
        left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
      });
    }
  }
  out.overflowing = out.overflowing.slice(0, 8);

  for (const el of document.querySelectorAll('input, textarea, select')) {
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 16) out.smallInputs.push({ cls: el.className.toString().slice(0, 40), size });
  }

  const px = (sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10 : null;
  };
  out.type = { body: px('body'), h1: px('.t-h1'), h2: px('.t-h2'), small: px('.t-small'), input: px('.input') };

  const card = document.querySelector('.pwa-card');
  const btn = document.querySelector('.pwa-card .btn');
  if (card && btn) {
    const c = card.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    out.dock = {
      cardTop: Math.round(c.top), cardBottom: Math.round(c.bottom),
      cardFitsViewport: c.top >= -1 && c.bottom <= doc.clientHeight + 1,
      buttonVisible: b.top >= -1 && b.bottom <= doc.clientHeight + 1 && b.width > 0,
      cardWithinScreen: c.left >= -1 && c.right <= vw + 1,
    };
  }
  return out;
})()
`;

// Chrome will not open a window narrower than ~490px, so asking for a 320px
// window silently gives a 490px measurement and a meaningless pass. An iframe
// has no such floor: media queries, `vw` and `dvh` inside one resolve against
// the frame's own box, so a 320px iframe really is a 320px viewport. All the
// widths are measured in a single browser run this way.
function measureAll(chrome, css, widths) {
  const dir = mkdtempSync(path.join(tmpdir(), 'respcheck-'));
  const page = path.join(dir, 'page.html');
  const payload = JSON.stringify({ css, fixtures: FIXTURES, widths });

  writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#fff}iframe{border:0;display:block}</style>
</head><body><div id="frames"></div>
<script>
const CONF = ${payload};
const PROBE = ${JSON.stringify(PROBE)};
const host = document.getElementById('frames');
const results = [];
(async () => {
  for (const size of CONF.widths) {
    const frame = document.createElement('iframe');
    frame.style.width = size.w + 'px';
    frame.style.height = size.h + 'px';
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style>'
      + CONF.css + '</style></head><body>' + CONF.fixtures + '</body></html>';
    host.appendChild(frame);
    await new Promise((r) => { frame.onload = r; setTimeout(r, 1500); });
    const win = frame.contentWindow;
    let out;
    try { out = win.eval(PROBE); } catch (e) { out = { error: String(e && e.message || e) }; }
    results.push(Object.assign({ requested: size.w }, out));
    frame.remove();
  }
  document.title = JSON.stringify(results);
})();
</script></body></html>`);

  try {
    const dom = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      '--window-size=1600,1200', '--virtual-time-budget=20000',
      '--dump-dom', `file://${page}`,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

    const title = /<title>([\s\S]*?)<\/title>/.exec(dom)?.[1];
    if (!title) throw new Error('the probe did not run — no result written');
    const decoded = title
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return JSON.parse(decoded);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const chrome = findChrome();
if (!chrome) {
  console.log('  ℹ no Chrome found (set CHROME_BIN) — skipping the responsive check');
  process.exit(0);
}

const css = builtCss();
console.log(`  measuring in ${path.basename(chrome)}, ${css.length.toLocaleString()} bytes of CSS\n`);

let failures = 0;
const rows = [];

const measured = measureAll(chrome, css, WIDTHS);

for (let i = 0; i < WIDTHS.length; i += 1) {
  const size = WIDTHS[i];
  const r = measured[i];
  if (!r || r.error) {
    console.log(`  ✗ ${String(size.w).padStart(4)}px  ${size.label} — probe failed: ${r?.error ?? 'no result'}`);
    failures += 1;
    continue;
  }
  const problems = [];
  if (r.scrolls) problems.push(`scrolls sideways (${r.scrollWidth} > ${r.viewport})`);
  if (r.overflowing.length) {
    for (const o of r.overflowing) {
      problems.push(`${o.tag}.${o.cls.split(' ')[0]} in ${o.parent} reaches ${o.right}px (viewport ${r.viewport}) — "${o.text}"`);
    }
  }
  if (r.smallInputs.length) {
    problems.push(`${r.smallInputs.length} input(s) under 16px — iOS will zoom: ${
      r.smallInputs.map((i) => `${i.cls.split(' ')[0] || 'input'}=${i.size}px`).join(', ')}`);
  }
  if (r.dock && !r.dock.buttonVisible) problems.push('the update notice’s dismiss button is off screen');
  if (r.dock && !r.dock.cardWithinScreen) problems.push('the update notice is wider than the screen');

  rows.push({ size, r });
  if (problems.length) {
    failures += 1;
    console.log(`  ✗ ${String(size.w).padStart(4)}px  ${size.label}`);
    for (const p of problems) console.log(`      ${p}`);
  } else {
    console.log(`  ✓ ${String(size.w).padStart(4)}px  ${size.label}`);
  }
  // Old headless Chrome clamps the window to a minimum width, which would make
  // every narrow row a re-run of the same wide measurement while reporting a
  // pass. If the engine did not give us the width we asked for, say so.
  if (Math.abs(r.viewport - size.w) > 20) {
    console.log(`      ! measured at ${r.viewport}px, not ${size.w}px — this row proves nothing`);
    failures += 1;
  }
}

console.log('\n  Type scale, as rendered');
console.log(`    ${'width'.padEnd(8)}${['body', 'h1', 'h2', 'small', 'input'].map((k) => k.padStart(8)).join('')}`);
for (const { size, r } of rows) {
  console.log(`    ${`${size.w}px`.padEnd(8)}${['body', 'h1', 'h2', 'small', 'input']
    .map((k) => String(r.type[k] ?? '—').padStart(8)).join('')}`);
}

// A scale that does not move is the bug this check exists to catch.
const narrow = rows[0].r.type;
const wide = rows[rows.length - 1].r.type;
if (narrow.h1 === wide.h1 || narrow.body === wide.body) {
  console.log('\n  ✗ the type scale does not respond to width — it is fixed, not fluid');
  failures += 1;
} else {
  console.log(`\n  ✓ the scale responds: body ${narrow.body}→${wide.body}px, h1 ${narrow.h1}→${wide.h1}px`);
}

if (failures) {
  console.log(`\n  ${failures} width(s) with problems\n`);
  process.exitCode = 1;
} else {
  console.log(`\n  ✓ all ${WIDTHS.length} widths fit, no sideways scroll, no input under 16px\n`);
}
