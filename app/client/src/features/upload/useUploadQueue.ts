// The resumable upload engine (§8.3).
//
// State machine per file: HASHING → READY → UPLOADING → FINALISING → DONE | FAILED | PAUSED
//
// ── How the protocol works, and what it buys ─────────────────────────────────
//
// The server opens a resumable session, hands the browser a session URI, and the browser
// PUTs chunks in order. Each chunk is answered with a 308 carrying a `Range` header saying
// how much Google now holds. Sending in order costs a little throughput; the 308 buys:
//
//   Resume is authoritative.  A dropped connection is recovered by asking Google how many
//                             bytes it has and continuing from exactly there — no
//                             client-side bookkeeping that can get out of step with the
//                             server's view.
//   Nothing is left behind.   An abandoned session is staged outside the Drive entirely,
//                             so it consumes no quota and needs no cleanup rule.
//   One URL for the file.     One session URI, valid for about a week, rather than a
//                             separate pre-authorised link per chunk all expiring together.
//
// The bytes go from the browser straight to Google. They do not pass through the GCloud
// Hub server, which is the property that matters most.
import { create } from 'zustand';
import { api } from '../../lib/api';
import type { Asset } from '../../lib/types';

export type UploadState = 'HASHING' | 'READY' | 'UPLOADING' | 'FINALISING' | 'DONE' | 'FAILED' | 'PAUSED';

export interface QueueItem {
  id: string;
  file: File;
  displayName: string;
  state: UploadState;
  progress: number;
  error: string | null;
  checksum: string | null;
  // Metadata collected in the form before the upload starts. A song is optional; a
  // folder is optional; the type is not, because it is what makes a file findable.
  songId: string;
  folderId: string;
  // Set when the file arrived through a folder drop — the relative path inside the
  // dropped directory, used to name and group the folder that gets created.
  relativePath?: string;
  assetType: string;
  version: string;
  tags: string[];
  description: string;
  /**
   * Optional. A file attached to a song inherits the release's language, so this is what
   * gives a loose reel, a still or a lyric sheet a language at all — and what lets one
   * file disagree with its release when it genuinely does.
   */
  language: string;
  // Runtime
  assetId?: string;
  /** The Drive resumable session URI. This is itself the credential — treat it as one. */
  uploadUrl?: string;
  fileId?: string;
  chunkSize?: number;
  /** Bytes Google has confirmed it holds. Survives a pause, which is the whole point. */
  uploadedBytes: number;
  duplicate?: { assetId: string; displayName: string; songTitle: string; folderName?: string | null } | null;
  result?: Asset;
  startedAt?: number;
  bytesSent: number;
}

interface QueueStore {
  items: QueueItem[];
  add: (files: File[], defaults: Partial<QueueItem>) => void;
  update: (id: string, patch: Partial<QueueItem>) => void;
  remove: (id: string) => void;
  clearDone: () => void;
}

export const useQueue = create<QueueStore>((set) => ({
  items: [],
  add: (files, defaults) =>
    set((s) => ({
      items: [
        ...s.items,
        ...files.map((file) => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          displayName: file.name,
          state: 'HASHING' as UploadState,
          progress: 0,
          error: null,
          checksum: null,
          songId: '',
          folderId: '',
          assetType: '',
          version: 'V1',
          tags: [] as string[],
          description: '',
          language: '',
          uploadedBytes: 0,
          bytesSent: 0,
          ...defaults,
        })),
      ],
    })),
  update: (id, patch) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clearDone: () => set((s) => ({ items: s.items.filter((i) => i.state !== 'DONE') })),
}));

// SHA-256 via SubtleCrypto, streamed in slices so a 4 GB file does not have to sit in
// memory all at once. This is the pre-upload duplicate warning: it is compared against
// the sha256 Google computed for every file already in the library, so the answer arrives
// before a single byte is sent.
export async function checksum(file: File): Promise<string> {
  // SubtleCrypto has no incremental digest, so a large file is hashed with a small
  // hand-rolled SHA-256 over a stream rather than buffering the whole thing.
  if (file.size <= 64 * 1024 * 1024) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return streamingSha256(file);
}

// ── SHA-256, incremental ────────────────────────────────────────────────────
// Needed because crypto.subtle.digest is all-or-nothing and a 4 GB ArrayBuffer is not a
// thing a browser tab survives. Small, standard, and about 40 MB/s in practice — fast
// enough that hashing is never the bottleneck next to the upload itself.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

async function streamingSha256(file: File): Promise<string> {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  let tail = new Uint8Array(0);
  let total = 0;

  const compress = (block: Uint8Array, off: number) => {
    for (let i = 0; i < 16; i += 1) {
      w[i] = (block[off + i * 4] << 24) | (block[off + i * 4 + 1] << 16) | (block[off + i * 4 + 2] << 8) | block[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]; const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  };

  const reader = (file.stream() as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    const buf = new Uint8Array(tail.length + value.length);
    buf.set(tail);
    buf.set(value, tail.length);
    const blocks = Math.floor(buf.length / 64);
    for (let i = 0; i < blocks; i += 1) compress(buf, i * 64);
    // Copied rather than sliced: the remainder is under 64 bytes, and a copy keeps this a
    // Uint8Array over a plain ArrayBuffer, which is what the DataView below needs.
    tail = new Uint8Array(buf.subarray(blocks * 64));
  }

  const bitLen = BigInt(total) * 8n;
  const padded = new Uint8Array(tail.length + 1 + ((tail.length % 64 < 56 ? 56 : 120) - (tail.length % 64)) + 8 - 1);
  padded.set(tail);
  padded[tail.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, bitLen);
  for (let i = 0; i < padded.length; i += 64) compress(padded, i);

  return [...H].map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
}

// ── One chunk ───────────────────────────────────────────────────────────────

interface ChunkResult {
  /** Google has the whole file and returned its metadata. */
  file?: { id: string; name: string; size?: string };
  /** Google wants more; this is how many bytes it now holds. */
  received?: number;
}

// XHR rather than fetch — it is still the only way to get upload progress events in a
// browser. A 308 is not an error here, it is the protocol working.
function putChunk(
  sessionUri: string,
  blob: Blob,
  start: number,
  total: number,
  onProgress: (sentInThisChunk: number) => void,
  signal: AbortSignal,
): Promise<ChunkResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', sessionUri);
    // The whole handshake, in one header. Google replies 308 while it wants more and
    // 200/201 with the file's metadata when it has everything.
    xhr.setRequestHeader('content-range', `bytes ${start}-${start + blob.size - 1}/${total}`);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          resolve({ file: JSON.parse(xhr.responseText) });
        } catch {
          reject(new Error('Google accepted the upload but returned something unreadable.'));
        }
        return;
      }
      if (xhr.status === 308) {
        // "Range: bytes=0-262143" means Google holds 262144 bytes. An absent Range header
        // means it holds none of this chunk, which is legal and means retry from `start`.
        const range = xhr.getResponseHeader('range');
        resolve({ received: range ? Number(range.split('-')[1]) + 1 : start });
        return;
      }
      if (xhr.status === 403 || xhr.status === 404) {
        reject(new Error('This upload session is no longer valid. Start the upload again.'));
        return;
      }
      reject(new Error(`Google Drive rejected the chunk (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error while sending to Google Drive'));
    xhr.onabort = () => reject(new Error('paused'));
    signal.addEventListener('abort', () => xhr.abort());
    xhr.send(blob);
  });
}

const MAX_RETRIES = 5;

// Discarding a half-finished upload tells Google to throw the staged bytes away. Those
// bytes cost nothing while they sit there, but the session stays open for a week — and if
// the upload actually completed, there is a real file in the Drive that needs binning.
export async function abortUpload(item: QueueItem) {
  if (!item.uploadUrl && !item.fileId) return;
  try {
    await api('/uploads/abort', { method: 'POST', body: { uploadUrl: item.uploadUrl, fileId: item.fileId } });
  } catch {
    // Never let a failed cleanup block the UI.
  }
}

export async function runUpload(item: QueueItem, controller: AbortController) {
  const { update } = useQueue.getState();

  try {
    update(item.id, { state: 'UPLOADING', error: null, startedAt: Date.now() });

    // 1 — initiate. The server validates, opens the Drive session and checks whether the
    // checksum we computed already exists in the library.
    let uploadUrl = item.uploadUrl;
    let chunkSize = item.chunkSize ?? 8 * 1024 * 1024;
    let assetId = item.assetId;
    let offset = 0;

    if (uploadUrl) {
      // Resuming a paused item: ask Google how far it got rather than guessing.
      try {
        const state = await api<{ complete: boolean; received: number }>('/uploads/resume', {
          method: 'POST',
          body: { uploadUrl, sizeBytes: item.file.size },
        });
        offset = state.received;
        update(item.id, { uploadedBytes: offset });
      } catch {
        // The session expired. Fall through to opening a new one.
        uploadUrl = undefined;
      }
    }

    if (!uploadUrl) {
      const init = await api<{
        assetId: string; uploadUrl: string; chunkSize: number;
        duplicate: QueueItem['duplicate'];
      }>('/uploads/initiate', {
        method: 'POST',
        body: {
          filename: item.displayName,
          sizeBytes: item.file.size,
          contentType: item.file.type || 'application/octet-stream',
          assetType: item.assetType,
          songId: item.songId || null,
          folderId: item.folderId || null,
          checksumSHA256: item.checksum,
        },
      });
      uploadUrl = init.uploadUrl;
      chunkSize = init.chunkSize;
      assetId = init.assetId;
      offset = 0;
      update(item.id, {
        assetId: init.assetId, uploadUrl: init.uploadUrl, chunkSize: init.chunkSize,
        duplicate: init.duplicate, uploadedBytes: 0,
      });
    }

    // 2 — send chunks, in order, straight to Google.
    let uploaded: ChunkResult['file'] | undefined;
    let attempt = 0;

    while (offset < item.file.size) {
      const end = Math.min(offset + chunkSize, item.file.size);
      const blob = item.file.slice(offset, end, item.file.type || 'application/octet-stream');
      const chunkStart = offset;

      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await putChunk(
          uploadUrl,
          blob,
          chunkStart,
          item.file.size,
          (sentInThisChunk) => {
            const sent = chunkStart + sentInThisChunk;
            update(item.id, {
              progress: Math.min(99, Math.round((sent / item.file.size) * 100)),
              bytesSent: sent,
            });
          },
          controller.signal,
        );

        if (result.file) { uploaded = result.file; offset = item.file.size; }
        else {
          // Google is authoritative about how much it holds. If it accepted less than we
          // sent, the next chunk starts where Google says, not where we hoped.
          offset = result.received ?? end;
        }
        update(item.id, { uploadedBytes: offset, bytesSent: offset });
        attempt = 0;
      } catch (err) {
        if (controller.signal.aborted) throw err;
        attempt += 1;
        if (attempt > MAX_RETRIES) throw err;

        // Before retrying, ask Google where it actually is. A chunk can be fully received
        // and the response lost, in which case resending it would be wasted work.
        try {
          // eslint-disable-next-line no-await-in-loop
          const state = await api<{ complete: boolean; received: number }>('/uploads/resume', {
            method: 'POST', body: { uploadUrl, sizeBytes: item.file.size },
          });
          offset = state.received;
          if (state.complete) break;
        } catch {
          // The session itself is gone — nothing left to retry against.
          throw new Error('The upload session expired. Start this file again.');
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, Math.min(8000, 2 ** attempt * 400)); });
      }
    }

    // 3 — complete. The server reads the file back from Drive to confirm it is really
    // there, at the size Google reports, and only then writes the catalogue record.
    update(item.id, { state: 'FINALISING', progress: 99 });
    const fileId = uploaded?.id ?? item.fileId;
    if (!fileId) throw new Error('Google did not return a file id for the finished upload.');
    update(item.id, { fileId });

    const asset = await api<Asset>('/uploads/complete', {
      method: 'POST',
      body: {
        assetId,
        fileId,
        songId: item.songId || null,
        folderId: item.folderId || null,
        metadata: {
          displayName: item.displayName,
          originalName: item.file.name,
          description: item.description,
          assetType: item.assetType,
          version: item.version,
          tags: item.tags,
          language: item.language,
          checksumSHA256: item.checksum,
        },
      },
    });

    update(item.id, { state: 'DONE', progress: 100, result: asset });
    return asset;
  } catch (err) {
    if (controller.signal.aborted) {
      // The session URI and the byte count are kept, so resuming costs one round trip.
      update(item.id, { state: 'PAUSED' });
      return null;
    }
    update(item.id, { state: 'FAILED', error: err instanceof Error ? err.message : 'Upload failed' });
    return null;
  }
}
