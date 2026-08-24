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


const SIDE = 32;
const KEEP = 8;

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


function extractFrames(stream, { frames, durationSec, isImage }) {
  const args = isImage
    ? ['-i', 'pipe:0', '-vf', `scale=${SIDE}:${SIDE}`, '-frames:v', '1']
    : [
      '-i', 'pipe:0',
      '-vf', `fps=${durationSec ? Math.max(0.05, frames / durationSec) : 1},scale=${SIDE}:${SIDE}`,
      '-frames:v', String(frames),
    ];

  const proc = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-nostdin',
    '-protocol_whitelist', 'pipe',
    ...args,
    '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1',
  ]);

  const deadline = setTimeout(() => proc.kill('SIGKILL'), 60_000);
  proc.on('close', () => clearTimeout(deadline));

  const chunks = [];
  proc.stdout.on('data', (c) => chunks.push(c));
  proc.stdin.on('error', () => {});
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
      stream.destroy?.();
    });
  });
}


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
    revisionId: asset.drive?.revisionId ?? null,
  };
}


export async function buildPerceptualHashes({ state = {}, onProgress } = {}) {
  if (!(await ffmpegAvailable())) {
    throw new Error('ffmpeg is not on PATH. Install it (apt install ffmpeg / brew install ffmpeg) and run this again — the other three duplicate tiers work without it.');
  }

  const targets = allAssets()
    .filter(({ asset }) => !asset.deletedAt)
    .filter(({ asset }) => ['Video', 'Image', 'Audio'].includes(asset.family))
    .filter(({ asset }) => asset.drive?.fileId && !asset.drive.googleNative)
    .filter(({ asset }) => asset.perceptual?.revisionId !== (asset.drive?.revisionId ?? null))
    .map(({ asset }) => asset);

  state.total = targets.length;
  state.done = 0;
  state.failed = 0;
  state.errors = [];

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
