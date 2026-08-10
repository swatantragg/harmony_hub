// Perceptual hashing — tier 4 of de-duplication (§10.12).
//
// A checksum answers "are these the same bytes". It cannot answer "are these the same
// video", because re-exporting a clip at a different bitrate changes every byte while
// changing nothing a person would notice. That is the case this file exists for: the same
// music video at 1080p and 720p, the WhatsApp-compressed copy somebody sent back, the
// same footage in .mov and .mp4.
//
// The method, and why each step is what it is:
//
//   1. Pull N frames at evenly-spaced points through the file. Not the first N — the first
//      seconds of two cuts of the same video are the most likely part to differ (a slate,
//      a logo sting), and the middle is the most likely part to agree.
//   2. Reduce each frame to 32×32 greyscale, then take a 2-D DCT and keep the top-left
//      8×8 block. That block is the low-frequency structure of the image: the broad shapes
//      and where the light is. Resolution, bitrate, mild colour grading and compression
//      artefacts all live in the high frequencies that get discarded — which is exactly
//      why this survives a re-encode when a checksum does not.
//   3. Each of the 64 coefficients becomes one bit: is it above the median or below.
//      Comparing against the median rather than the mean is what makes the hash immune to
//      a global brightness or contrast shift.
//   4. Two videos are compared by matching each frame to its nearest counterpart in the
//      other and taking the median of those distances, so a different lead-in shifts the
//      alignment without wrecking the score.
//
// The cost is real: every file has to be read back out of Drive and decoded. That is why
// this is opt-in (DEDUPE_PERCEPTUAL), runs as a background job, and caches its result on
// the asset so it is computed once per file for the life of that file.
//
// Requires ffmpeg on PATH. Without it the job reports that plainly and the other three
// tiers carry on working.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { DEDUPE, HEAD_CONCURRENCY } from '../config.js';
import { allAssets, persist } from '../db.js';
import { downloadResponse, mapLimit } from '../storage/drive.js';

export async function ffmpegAvailable() {
  try {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    const [code] = await once(proc, 'close');
    return code === 0;
  } catch {
    return false;
  }
}

// ── The hash ────────────────────────────────────────────────────────────────

const SIDE = 32;   // DCT input size
const KEEP = 8;    // top-left block kept — 64 bits

// Precomputed DCT-II basis. Building it once turns the per-frame cost from a few thousand
// cosine calls into a matrix multiply.
const BASIS = (() => {
  const table = new Float64Array(SIDE * SIDE);
  for (let u = 0; u < SIDE; u += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      table[u * SIDE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIDE));
    }
  }
  return table;
})();

function dct2(pixels) {
  // Rows first, then columns — separable, so 2·N³ instead of N⁴.
  const rows = new Float64Array(SIDE * SIDE);
  for (let y = 0; y < SIDE; y += 1) {
    for (let u = 0; u < KEEP; u += 1) {
      let sum = 0;
      for (let x = 0; x < SIDE; x += 1) sum += pixels[y * SIDE + x] * BASIS[u * SIDE + x];
      rows[y * SIDE + u] = sum;
    }
  }
  const out = new Float64Array(KEEP * KEEP);
  for (let u = 0; u < KEEP; u += 1) {
    for (let v = 0; v < KEEP; v += 1) {
      let sum = 0;
      for (let y = 0; y < SIDE; y += 1) sum += rows[y * SIDE + v] * BASIS[u * SIDE + y];
      out[u * KEEP + v] = sum;
    }
  }
  return out;
}

export function hashFromGrey(pixels) {
  const coefficients = dct2(pixels);
  // The DC term is average brightness, which is the one thing a hash must ignore.
  const ac = Array.from(coefficients).slice(1);
  const sorted = [...ac].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  let bits = 0n;
  for (let i = 0; i < 64; i += 1) {
    const value = i === 0 ? median : coefficients[i];
    bits = (bits << 1n) | (value > median ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, '0');
}

// ── Frame extraction ────────────────────────────────────────────────────────

// ffmpeg reads the file on stdin and writes raw 32×32 greyscale frames to stdout. Raw
// rather than PNG so there is no decoder on this side; `fps` picks the sample points.
function extractFrames(stream, { frames, durationSec, isImage }) {
  const args = isImage
    ? ['-i', 'pipe:0', '-vf', `scale=${SIDE}:${SIDE}`, '-frames:v', '1']
    : [
      '-i', 'pipe:0',
      // Evenly spaced across whatever duration is known; falls back to one frame a second
      // for a file whose length Drive did not report.
      '-vf', `fps=${durationSec ? Math.max(0.05, frames / durationSec) : 1},scale=${SIDE}:${SIDE}`,
      '-frames:v', String(frames),
    ];

  const proc = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    ...args,
    '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1',
  ]);

  const chunks = [];
  proc.stdout.on('data', (c) => chunks.push(c));
  proc.stdin.on('error', () => {});          // ffmpeg exits early once it has enough frames
  stream.on('error', () => proc.stdin.destroy());
  stream.pipe(proc.stdin);

  return new Promise((resolve, reject) => {
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', () => {
      const buffer = Buffer.concat(chunks);
      const frameBytes = SIDE * SIDE;
      const count = Math.floor(buffer.length / frameBytes);
      if (count === 0) {
        reject(new Error(stderr.split('\n').filter(Boolean).pop() || 'ffmpeg produced no frames'));
        return;
      }
      const out = [];
      for (let i = 0; i < count; i += 1) {
        out.push(new Float64Array(buffer.subarray(i * frameBytes, (i + 1) * frameBytes)));
      }
      resolve(out);
      // Whatever is still arriving from Drive is no longer wanted.
      stream.destroy?.();
    });
  });
}

// ── One asset ───────────────────────────────────────────────────────────────

export async function hashAsset(asset) {
  const fileId = asset.drive?.fileId;
  if (!fileId) throw new Error('No Drive file id');
  if (asset.drive?.googleNative) throw new Error('Google Docs files have no frames to hash');

  const isImage = asset.family === 'Image';
  if (!isImage && asset.family !== 'Video' && asset.family !== 'Audio') {
    throw new Error(`${asset.family} files are not perceptually hashable`);
  }

  const duration = asset.durationSec ?? asset.drive?.durationSec ?? null;
  const response = await downloadResponse(fileId);
  const stream = Readable.fromWeb(response.body);

  const grey = await extractFrames(stream, {
    frames: isImage ? 1 : DEDUPE.frames,
    durationSec: duration,
    isImage,
  });

  return {
    frames: grey.map(hashFromGrey),
    method: 'dct64',
    sampledFrames: grey.length,
    durationSec: duration,
    computedAt: new Date().toISOString(),
    // Recomputed whenever the file changes — the revision is what says it did.
    revisionId: asset.drive?.revisionId ?? null,
  };
}

// ── The job ─────────────────────────────────────────────────────────────────

export async function buildPerceptualHashes({ state = {}, onProgress } = {}) {
  if (!(await ffmpegAvailable())) {
    throw new Error('ffmpeg is not on PATH. Install it (apt install ffmpeg / brew install ffmpeg) and run this again — the other three duplicate tiers work without it.');
  }

  const targets = allAssets()
    .filter(({ asset }) => !asset.deletedAt)
    .filter(({ asset }) => ['Video', 'Image', 'Audio'].includes(asset.family))
    .filter(({ asset }) => asset.drive?.fileId && !asset.drive.googleNative)
    // Already hashed, and the file has not been replaced since.
    .filter(({ asset }) => asset.perceptual?.revisionId !== (asset.drive?.revisionId ?? null))
    .map(({ asset }) => asset);

  state.total = targets.length;
  state.done = 0;
  state.failed = 0;
  state.errors = [];

  // Deliberately narrower than the general fan-out: each of these is a full file read plus
  // an ffmpeg process, and running twenty at once will exhaust either the network or the
  // machine before it saturates Drive.
  const concurrency = Math.max(1, Math.min(4, HEAD_CONCURRENCY));

  await mapLimit(targets, concurrency, async (asset) => {
    try {
      asset.perceptual = await hashAsset(asset);
      state.done += 1;
    } catch (err) {
      state.failed += 1;
      if (state.errors.length < 20) state.errors.push({ displayName: asset.displayName, error: err.message });
    }
    if (onProgress && (state.done + state.failed) % 10 === 0) onProgress(state);
  });

  persist();
  return state;
}
