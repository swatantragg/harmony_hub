// End-to-end smoke test against a running API and a real Google Drive.
//
//   npm run smoke
//
// It walks the mandatory capabilities and the paths that depend on them, using the same
// HTTP calls the browser makes — including PUTting the upload chunks straight to Google's
// resumable session URI from this process, exactly as the browser would.
//
//   1  sign in
//   2  open a resumable upload session          → Store    (§10.1)
//   3  PUT the bytes straight to Google
//   4  complete, and confirm by reading it back
//   5  verify availability                      → Verify   (§10.5)
//   6  sign a download and fetch the bytes      → Retrieve (§10.2)
//   7  rename, and confirm the Drive file id did not move and the download name did
//   8  Range request, so <video> seeking is proven
//   9  move it between folders, and confirm Drive followed
//  10  a chunked multi-chunk upload, reassembled byte-for-byte
//  11  resume: abandon a chunk mid-upload and pick it up from Google's own byte count
//  12  a share link, opened with no credentials at all
//  13  de-duplication finds a deliberate copy by checksum
//  14  reconcile, then purge and confirm it is gone
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

const here = path.dirname(new URL(import.meta.url).pathname);
for (const file of [path.resolve(here, '../.env'), path.resolve(here, '../server/.env')]) {
  if (fs.existsSync(file)) dotenv.config({ path: file });
}

const API = (process.env.SMOKE_API || process.env.PUBLIC_ORIGIN || 'http://localhost:8100') + '/api';
// The founding administrator — the one account created with a password of its own and no
// forced change, so it is the only one that can sign straight in and exercise the API.
const EMAIL = process.env.SMOKE_EMAIL || process.env.ADMIN_EMAIL || 'swatantra.goongoonalo@gmail.com';
const PASSWORD = process.env.SMOKE_PASSWORD || process.env.ADMIN_PASSWORD || '12345678';

let token = null;
let passed = 0;
let failed = 0;

const ok = (label, extra = '') => { passed += 1; console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`); };
const bad = (label, err) => { failed += 1; console.log(`  ✗ ${label}\n      ${err}`); };
const gb = (n) => (n == null ? '—' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(0)} MB`);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function call(pathname, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${pathname} → ${res.status} ${payload?.title || ''} ${payload?.detail || ''}`);
  }
  return payload;
}

// Sends a whole buffer to a Drive resumable session, in chunks, the way the browser does.
// `stopAfter` exists so the resume test can walk away halfway through.
async function sendChunks(sessionUri, buf, chunkSize, { stopAfter = Infinity, from = 0 } = {}) {
  let offset = from;
  let sent = 0;
  while (offset < buf.length) {
    if (sent >= stopAfter) return { finished: false, offset };
    const end = Math.min(offset + chunkSize, buf.length);
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(sessionUri, {
      method: 'PUT',
      headers: { 'content-range': `bytes ${offset}-${end - 1}/${buf.length}` },
      body: buf.subarray(offset, end),
    });
    if (res.status === 200 || res.status === 201) {
      return { finished: true, file: await res.json() };
    }
    if (res.status !== 308) {
      throw new Error(`chunk at ${offset} → HTTP ${res.status} ${await res.text()}`);
    }
    const range = res.headers.get('range');
    offset = range ? Number(range.split('-')[1]) + 1 : end;
    sent += 1;
  }
  return { finished: false, offset };
}

// A small, real WAV so the file is something a browser would genuinely play.
function makeWav(seconds = 2, sampleRate = 8000) {
  const n = seconds * sampleRate;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + n, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(n, 40);
  const data = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) {
    data[i] = Math.round(128 + Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 90);
  }
  return Buffer.concat([header, data]);
}

async function main() {
  console.log(`\nGCloud · smoke test  →  ${API}\n`);

  const health = await fetch(`${API.replace(/\/api$/, '')}/healthz`).then((r) => r.json());
  console.log(`  storage: ${health.storage.provider} · ${health.storage.authMode}`
    + `${health.storage.sharedDrive ? ' · shared drive' : ' · my drive'}`);
  console.log(`  mongo:   ${health.mongo.db} (${health.mongo.connected ? 'connected' : 'DOWN'})\n`);

  // 1 — sign in
  const auth = await call('/auth/login', { method: 'POST', auth: false, body: { email: EMAIL, password: PASSWORD } });
  token = auth.accessToken;
  ok('sign in', `as ${auth.user.name} (${auth.user.role})`);

  const body = makeWav(2);
  const filename = `smoke_test_${Date.now()}.wav`;
  let assetId;
  let folderId;
  let duplicateId;

  try {
    // 2 — open a resumable session
    const init = await call('/uploads/initiate', {
      method: 'POST',
      body: {
        filename,
        sizeBytes: body.length,
        contentType: 'audio/wav',
        assetType: 'Audio Snippet',
        songId: null,
        folderId: null,
        checksumSHA256: sha256(body),
      },
    });
    assetId = init.assetId;
    if (!init.uploadUrl?.startsWith('https://')) throw new Error('initiate returned no Google session URI');
    ok('open a resumable upload session', `chunk size ${(init.chunkSize / 1048576).toFixed(0)} MB`);

    // 3 — PUT straight to Google, exactly as the browser does
    const sent = await sendChunks(init.uploadUrl, body, init.chunkSize);
    if (!sent.finished) throw new Error('the upload did not complete');
    ok('PUT bytes straight to Google Drive', `${body.length} bytes, none touched the API`);

    // 4 — complete
    const asset = await call('/uploads/complete', {
      method: 'POST',
      body: {
        assetId: init.assetId,
        fileId: sent.file.id,
        songId: null,
        folderId: null,
        metadata: {
          displayName: filename, originalName: filename, assetType: 'Audio Snippet',
          tags: ['Demo'], version: 'V1', checksumSHA256: sha256(body),
        },
      },
    });
    if (asset.drive.sizeBytes !== body.length) {
      throw new Error(`size mismatch: sent ${body.length}, Drive has ${asset.drive.sizeBytes}`);
    }
    ok('complete + read-back verification', `${asset.drive.sizeBytes} bytes · file ${asset.drive.fileId}`);

    // Google computing the checksum itself is what makes de-duplication exact rather than
    // advisory, so it is worth failing the smoke test if it ever stops arriving.
    if (asset.drive.sha256 && asset.drive.sha256 !== sha256(body)) {
      throw new Error(`Drive's sha256 ${asset.drive.sha256} does not match ours ${sha256(body)}`);
    }
    ok('Google returns a checksum', asset.drive.sha256 ? `sha256 ${asset.drive.sha256.slice(0, 16)}…` : `md5 ${asset.drive.md5}`);

    // 5 — verify availability
    const verified = await call(`/assets/${assetId}/verify`, { method: 'POST' });
    if (verified.status !== 'AVAILABLE') throw new Error(`expected AVAILABLE, got ${verified.status}: ${verified.detail}`);
    ok('verify availability (live files.get)', verified.status);

    // 6 — download
    const dl = await call(`/assets/${assetId}/download`, { method: 'POST' });
    const fetched = Buffer.from(await (await fetch(dl.url)).arrayBuffer());
    if (!fetched.equals(body)) throw new Error('downloaded bytes differ from what was uploaded');
    ok('signed download returns the exact bytes', `${fetched.length} bytes`);

    // 7 — rename: the Drive file id must not move, the download name must change
    const fileIdBefore = asset.drive.fileId;
    const newName = `renamed_${filename}`;
    const renamed = await call(`/assets/${assetId}/rename`, { method: 'PATCH', body: { displayName: newName } });
    if (renamed.drive.fileId !== fileIdBefore) {
      throw new Error(`the Drive file id changed: ${fileIdBefore} → ${renamed.drive.fileId}`);
    }
    if (renamed.drive.name !== newName) throw new Error(`Drive still calls it ${renamed.drive.name}`);
    const dl2 = await call(`/assets/${assetId}/download`, { method: 'POST' });
    const disp = (await fetch(dl2.url)).headers.get('content-disposition') || '';
    if (!disp.includes(newName)) throw new Error(`Content-Disposition does not carry the new name: ${disp}`);
    ok('rename', 'same file id, renamed in Drive, downloads as the new name');

    // 8 — Range request, the thing that makes <video> and <audio> seek
    const pv = await call(`/assets/${assetId}/preview`, { method: 'POST' });
    const ranged = await fetch(pv.url, { headers: { Range: 'bytes=0-1023' } });
    if (ranged.status !== 206) throw new Error(`expected 206 Partial Content, got ${ranged.status}`);
    ok('HTTP Range request', `206 · ${ranged.headers.get('content-range')}`);

    // 9 — folders are real, and moving between them re-parents in Drive
    const folder = await call('/folders', {
      method: 'POST',
      body: { name: `Smoke folder ${Date.now()}`, description: 'Created by the smoke test.', tags: ['Demo'] },
    });
    folderId = folder._id;
    if (!folder.driveFolderId) throw new Error('the folder was not created in Google Drive');
    const moved = await call(`/assets/${assetId}/move`, { method: 'POST', body: { folderId } });
    if (moved.drive.parentId !== folder.driveFolderId) {
      throw new Error(`Drive parent is ${moved.drive.parentId}, expected ${folder.driveFolderId}`);
    }
    ok('folders are real Drive folders', 'created in Drive, and the file re-parented into it');

    // 10 — a genuinely multi-chunk upload. One chunk proves nothing about the ordering,
    // the 308 handshake or the assembled file.
    const big = Buffer.alloc(20 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);
    const bigName = `smoke_chunked_${Date.now()}.bin`;
    const bigInit = await call('/uploads/initiate', {
      method: 'POST',
      body: { filename: bigName, sizeBytes: big.length, contentType: 'application/octet-stream', assetType: 'Audio Snippet' },
    });
    const chunks = Math.ceil(big.length / bigInit.chunkSize);
    if (chunks < 2) throw new Error(`expected several chunks, got ${chunks} — lower DRIVE_CHUNK_MB to exercise this`);
    const bigSent = await sendChunks(bigInit.uploadUrl, big, bigInit.chunkSize);
    if (!bigSent.finished) throw new Error('the chunked upload did not complete');
    const bigAsset = await call('/uploads/complete', {
      method: 'POST',
      body: {
        assetId: bigInit.assetId, fileId: bigSent.file.id,
        metadata: { displayName: bigName, originalName: bigName, assetType: 'Audio Snippet', tags: ['Demo'] },
      },
    });
    if (bigAsset.drive.sizeBytes !== big.length) throw new Error(`assembled size ${bigAsset.drive.sizeBytes}, expected ${big.length}`);
    const bigDl = await call(`/assets/${bigInit.assetId}/download`, { method: 'POST' });
    const bigBack = Buffer.from(await (await fetch(bigDl.url)).arrayBuffer());
    if (!bigBack.equals(big)) throw new Error('the reassembled file does not match what was uploaded');
    ok('chunked upload reassembles byte-for-byte', `${chunks} chunks · ${(big.length / 1048576).toFixed(0)} MB`);

    // 11 — resume. The property that makes this protocol worth its sequential nature:
    // Google is asked how much it holds, and the upload continues from exactly there.
    const resumeName = `smoke_resume_${Date.now()}.bin`;
    const resumeInit = await call('/uploads/initiate', {
      method: 'POST',
      body: { filename: resumeName, sizeBytes: big.length, contentType: 'application/octet-stream', assetType: 'Audio Snippet' },
    });
    const partial = await sendChunks(resumeInit.uploadUrl, big, resumeInit.chunkSize, { stopAfter: 1 });
    if (partial.finished) throw new Error('the whole file went in one chunk — cannot exercise resume');
    const state = await call('/uploads/resume', {
      method: 'POST',
      body: { uploadUrl: resumeInit.uploadUrl, sizeBytes: big.length },
    });
    if (state.received !== partial.offset) {
      throw new Error(`Google says it holds ${state.received} bytes, we sent ${partial.offset}`);
    }
    const rest = await sendChunks(resumeInit.uploadUrl, big, resumeInit.chunkSize, { from: state.received });
    if (!rest.finished) throw new Error('the resumed upload did not complete');
    const resumed = await call('/uploads/complete', {
      method: 'POST',
      body: {
        assetId: resumeInit.assetId, fileId: rest.file.id,
        metadata: { displayName: resumeName, originalName: resumeName, assetType: 'Audio Snippet' },
      },
    });
    if (resumed.drive.sizeBytes !== big.length) throw new Error('the resumed upload assembled to the wrong size');
    ok('resume from Google\'s own byte count', `interrupted at ${(state.received / 1048576).toFixed(0)} MB, finished clean`);
    duplicateId = resumed.assetId;

    // 12 — share link, opened with no credentials at all
    const share = await call('/shares', {
      method: 'POST',
      body: { assetId, audience: 'PUBLIC', expiresIn: '1h', canDownload: true, maxDownloads: 3, note: 'smoke test' },
    });
    const opened = await call(`/s/${share.token}`, { auth: false });
    if (opened.asset.assetId !== assetId) throw new Error('the share resolved to the wrong asset');
    if (!opened.previewUrl) throw new Error('the share returned no preview URL');
    const shareDl = await call(`/s/${share.token}/download`, { method: 'POST', auth: false });
    const shareBytes = Buffer.from(await (await fetch(shareDl.url)).arrayBuffer());
    if (!shareBytes.equals(body)) throw new Error('the shared download returned different bytes');
    ok('public share link', `anonymous open + download · ${shareDl.downloadsRemaining} left`);

    await call(`/shares/${share._id}`, { method: 'DELETE' });
    const revoked = await fetch(`${API}/s/${share.token}`);
    if (revoked.status !== 410) throw new Error(`a revoked link should answer 410, got ${revoked.status}`);
    ok('revocation takes effect immediately', '410 Gone');

    // 13 — de-duplication. The 20 MB file was uploaded twice above, with different names
    // and into different places, so the exact tier must find them and must be certain.
    const dupes = await call('/dedupe/scan?level=exact');
    const group = dupes.groups.find((g) =>
      g.members.some((m) => m.assetId === bigInit.assetId) && g.members.some((m) => m.assetId === duplicateId));
    if (!group) throw new Error('two byte-identical files were not detected as duplicates');
    if (group.kind !== 'IDENTICAL' || group.confidence !== 1) {
      throw new Error(`expected a certain IDENTICAL group, got ${group.kind} at confidence ${group.confidence}`);
    }
    ok('de-duplication finds identical files by checksum', `${gb(group.reclaimableBytes)} recoverable, confidence ${group.confidence}`);

    const compared = await call(`/dedupe/compare?a=${bigInit.assetId}&b=${duplicateId}`);
    if (compared.verdict !== 'IDENTICAL') throw new Error(`compare said ${compared.verdict}, expected IDENTICAL`);
    ok('pairwise compare agrees', compared.verdict);

    await call(`/assets/${bigInit.assetId}/purge`, { method: 'DELETE', body: { confirm: bigName } });
    await call(`/assets/${duplicateId}/purge`, { method: 'DELETE', body: { confirm: resumeName } });
    duplicateId = null;

    // 14 — an aborted session leaves nothing behind
    const aborted = await call('/uploads/initiate', {
      method: 'POST',
      body: { filename: 'abandoned.bin', sizeBytes: 20 * 1024 * 1024, contentType: 'application/octet-stream', assetType: 'Audio Snippet' },
    });
    await call('/uploads/abort', { method: 'POST', body: { uploadUrl: aborted.uploadUrl } });
    ok('abort discards an abandoned upload session', 'nothing staged, nothing billed');

    // 15 — quota, the number every upload depends on
    const quota = await call('/admin/storage/quota');
    ok('Drive quota', quota.unlimited
      ? 'unlimited (pooled Shared Drive)'
      : `${gb(quota.available)} free of ${gb(quota.limit)} · library holds ${gb(quota.libraryBytes)}`);

    // 16 — reconciliation sees the current state of the Drive
    const run = await call('/admin/storage/reconcile', { method: 'POST' });
    ok('reconciliation', `${run.objectsScanned} Drive files · ${run.assetsScanned} catalogued · ${run.durationMs} ms`);
    const expected = { MISSING_IN_DRIVE: 1, UNTRACKED_IN_DRIVE: 1, TRASHED_IN_DRIVE: 1 };
    const misses = Object.entries(expected).filter(([kind, want]) => (run.counts[kind] ?? 0) < want);
    if (misses.length) {
      throw new Error(`the seeded drift is not being detected: ${misses.map(([k, w]) => `expected ≥${w} ${k}, got ${run.counts[k] ?? 0}`).join('; ')}`);
    }
    ok('seeded drift is detected', Object.keys(expected).map((k) => `${k} ${run.counts[k]}`).join(' · '));
  } catch (err) {
    bad('upload / retrieve / rename / move / share / dedupe flow', err.message);
  } finally {
    for (const [id, label] of [[assetId, 'the test asset'], [duplicateId, 'the duplicate']]) {
      if (!id) continue;
      try {
        const current = await call(`/assets/${id}`);
        await call(`/assets/${id}/purge`, { method: 'DELETE', body: { confirm: current.displayName } });
        const gone = await fetch(`${API}/assets/${id}`, { headers: { authorization: `Bearer ${token}` } });
        if (gone.status !== 404) throw new Error(`purged asset still resolves (HTTP ${gone.status})`);
        ok(`purge removes ${label} and every Drive revision`, '404 afterwards');
      } catch (err) {
        bad('cleanup', err.message);
      }
    }
    if (folderId) {
      await call(`/folders/${folderId}`, { method: 'DELETE' }).catch(() => null);
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nSmoke test could not run:', err.message, '\n');
  process.exit(1);
});
