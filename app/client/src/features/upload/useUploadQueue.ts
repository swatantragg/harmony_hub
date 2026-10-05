import { create } from 'zustand';
import { api } from '../../lib/api';
import type { Asset } from '../../lib/types';
import type { HashReply } from './hash.worker';

export type UploadState = 'READY' | 'UPLOADING' | 'FINALISING' | 'DONE' | 'FAILED' | 'PAUSED';

/**
 * The fingerprint (SHA-256) is what lets the server warn that a file is already
 * in the library, and that warning is only worth anything before the upload
 * starts. So it is worked out in a background worker while somebody fills in
 * the details, and it never holds the upload back: pressing Upload stops it
 * (SKIPPED). Google computes its own SHA-256 when the bytes arrive, and that is
 * the one duplicate detection runs on afterwards.
 */
export type HashState = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';

export interface QueueItem {
  id: string;
  file: File;
  displayName: string;
  state: UploadState;
  progress: number;
  error: string | null;
  checksum: string | null;
  /** Absent means there is no fingerprint to wait for. */
  hashState?: HashState;
  hashedBytes?: number;
  songId: string;
  folderId: string;
  relativePath?: string;
  assetType: string;
  version: string;
  tags: string[];
  description: string;
  language: string;
  assetId?: string;
  uploadUrl?: string;
  fileId?: string;
  chunkSize?: number;
  uploadedBytes: number;
  duplicate?: { assetId: string; displayName: string; songTitle: string; folderName?: string | null } | null;
  result?: Asset;
  startedAt?: number;
  /** What Google already held when this run started, so a resumed upload's speed is not inflated by it. */
  startedBytes?: number;
  bytesSent: number;
}
interface QueueStore {
  items: QueueItem[];
  add: (files: File[], defaults: Partial<QueueItem>) => void;
  update: (id: string, patch: Partial<QueueItem>) => void;
  remove: (id: string) => void;
  clearDone: () => void;
}

// Progress arrives far faster than anyone can read it — every XHR reports
// roughly every 50ms, and ten uploads at once is two hundred reports a second.
// Each one used to be a store write, and each write re-rendered the whole
// upload screen. Now they collect here and land as one write every FLUSH_MS.
// A state change (update) takes whatever is waiting for that file first, so a
// late progress report can never undo it.
const FLUSH_MS = 400;
const pending = new Map<string, Partial<QueueItem>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export const useQueue = create<QueueStore>((set) => ({
  items: [],
  add: (files, defaults) => {
    const added: QueueItem[] = files.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      displayName: file.name,
      state: 'READY',
      progress: 0,
      error: null,
      checksum: null,
      hashState: 'QUEUED',
      hashedBytes: 0,
      songId: '',
      folderId: '',
      assetType: '',
      version: 'V1',
      tags: [],
      description: '',
      language: '',
      uploadedBytes: 0,
      bytesSent: 0,
      ...defaults,
    }));
    set((s) => ({ items: [...s.items, ...added] }));
    for (const item of added) fingerprint(item);
  },
  update: (id, patch) => {
    const waiting = pending.get(id);
    pending.delete(id);
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...waiting, ...patch } : i)) }));
  },
  remove: (id) => {
    pending.delete(id);
    stopFingerprint(id);
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },
  clearDone: () => set((s) => ({ items: s.items.filter((i) => i.state !== 'DONE') })),
}));

function flush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!pending.size) return;
  const patches = new Map(pending);
  pending.clear();
  useQueue.setState((s) => ({
    items: s.items.map((i) => {
      const patch = patches.get(i.id);
      return patch ? { ...i, ...patch } : i;
    }),
  }));
}

function report(id: string, patch: Partial<QueueItem>) {
  pending.set(id, { ...pending.get(id), ...patch });
  flushTimer ??= setTimeout(flush, FLUSH_MS);
}

/** The file as it is right now, including progress not yet written to the store. */
export function latestItem(id: string): QueueItem | undefined {
  const item = useQueue.getState().items.find((i) => i.id === id);
  return item && { ...item, ...pending.get(id) };
}

/** Uploads under way, by queue id. Module-level, so Pause still works after leaving the page and coming back. */
export const uploadControllers = new Map<string, AbortController>();

// Closing or reloading the tab loses the File handle, and with it any upload in
// flight — hours of it, for a big file. The browser asks first, as Drive does.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (!useQueue.getState().items.some((i) => i.state === 'UPLOADING' || i.state === 'FINALISING')) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

// ── Fingerprinting, off the page ────────────────────────────────────────────
//
// Two lanes, one file at a time each. Small files go to crypto.subtle and take
// milliseconds, so a cover image is never stuck behind a 15 GB master; big ones
// are hashed in slices at roughly 80 MB/s. Neither ever runs on the page: the
// old main-thread hash held it for 51 seconds per GB without one repaint, which
// is what made the browser call the site unresponsive.

/** Matches WHOLE_FILE_MAX in hash.worker.ts. */
const SMALL_FILE = 64 * 1024 * 1024;

function spawnHasher(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

class HashLane {
  private jobs: { id: string; file: File }[] = [];
  private worker: Worker | null = null;
  private current: string | null = null;

  push(id: string, file: File) {
    this.jobs.push({ id, file });
    this.next();
  }

  /** Forgets the file, stopping its hash if it is the one running. True when there was anything to stop. */
  drop(id: string): boolean {
    const at = this.jobs.findIndex((j) => j.id === id);
    if (at >= 0) {
      this.jobs.splice(at, 1);
      return true;
    }
    if (this.current !== id) return false;
    this.worker?.terminate();
    this.worker = null;
    this.current = null;
    this.next();
    return true;
  }

  private next() {
    if (this.current) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.worker ??= spawnHasher();
    const worker = this.worker;
    if (!worker) {
      report(job.id, { hashState: 'FAILED' });
      this.next();
      return;
    }
    this.current = job.id;
    report(job.id, { hashState: 'RUNNING', hashedBytes: 0 });
    const finish = (patch: Partial<QueueItem>) => {
      this.current = null;
      report(job.id, patch);
      this.next();
    };
    worker.onmessage = (event: MessageEvent<HashReply>) => {
      const reply = event.data;
      if (reply.id !== this.current) return;
      if (reply.type === 'progress') report(job.id, { hashedBytes: reply.hashedBytes });
      else if (reply.type === 'done') finish({ checksum: reply.checksum, hashState: 'DONE', hashedBytes: job.file.size });
      else finish({ hashState: 'FAILED' });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      if (this.current === job.id) finish({ hashState: 'FAILED' });
    };
    worker.postMessage({ id: job.id, file: job.file });
  }
}

const lanes = { small: new HashLane(), large: new HashLane() };

function fingerprint(item: QueueItem) {
  (item.file.size <= SMALL_FILE ? lanes.small : lanes.large).push(item.id, item.file);
}

function stopFingerprint(id: string): boolean {
  return lanes.small.drop(id) || lanes.large.drop(id);
}

// ── Sending ─────────────────────────────────────────────────────────────────

interface ChunkResult {

  file?: { id: string; name: string; size?: string };

  received?: number;
}

/** A chunk with no progress for this long is abandoned and retried — a dead connection can otherwise hang forever. */
const STALL_MS = 60_000;

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
    let lastProgress = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastProgress < STALL_MS) return;
      stalled = true;
      xhr.abort();
    }, 5_000);
    const onAbort = () => xhr.abort();
    const settle = <T>(fn: (value: T) => void, value: T) => {
      clearInterval(watchdog);
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    xhr.open('PUT', sessionUri);
    xhr.setRequestHeader('content-range', `bytes ${start}-${start + blob.size - 1}/${total}`);
    xhr.upload.onprogress = (e) => {
      lastProgress = Date.now();
      onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          settle(resolve, { file: JSON.parse(xhr.responseText) });
        } catch {
          settle(reject, new Error('Google accepted the upload but returned something unreadable.'));
        }
        return;
      }
      if (xhr.status === 308) {
        const range = xhr.getResponseHeader('range');
        settle(resolve, { received: range ? Number(range.split('-')[1]) + 1 : start });
        return;
      }
      if (xhr.status === 403 || xhr.status === 404) {
        settle(reject, new Error('This upload session is no longer valid. Start the upload again.'));
        return;
      }
      settle(reject, new Error(`Google Drive rejected the chunk (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => settle(reject, new Error('Network error while sending to Google Drive'));
    xhr.onabort = () => settle(reject, new Error(stalled ? 'The connection to Google Drive stalled' : 'paused'));
    signal.addEventListener('abort', onAbort);
    xhr.send(blob);
  });
}
const MAX_RETRIES = 5;

/** Offline, a retry only burns an attempt. Wait for the connection (or a pause) instead. */
function untilOnline(signal: AbortSignal): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.onLine || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('online', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    window.addEventListener('online', done);
    signal.addEventListener('abort', done);
  });
}

export async function abortUpload(item: QueueItem) {
  if (!item.uploadUrl && !item.fileId) return;
  try {
    await api('/uploads/abort', { method: 'POST', body: { uploadUrl: item.uploadUrl, fileId: item.fileId } });
  } catch {
  }
}
export async function runUpload(queued: QueueItem, controller: AbortController) {
  const { update } = useQueue.getState();
  const item = latestItem(queued.id) ?? queued;
  // The upload wins from here: a fingerprint still running would only compete
  // with it for the disk, and the duplicate check it was for happens now or not
  // at all.
  const skipped = stopFingerprint(item.id);
  const checksum = item.checksum;
  const size = item.file.size;
  try {
    update(item.id, { state: 'UPLOADING', error: null, ...(skipped ? { hashState: 'SKIPPED' as const } : {}) });

    let uploadUrl = item.uploadUrl;
    let chunkSize = item.chunkSize ?? 8 * 1024 * 1024;
    let assetId = item.assetId;
    // Set once Google holds every byte. A run that got that far and then failed
    // to catalogue the file goes straight back to cataloguing it.
    let fileId = item.fileId;
    let offset = 0;
    if (!fileId && uploadUrl) {
      try {
        const state = await api<{ complete: boolean; received: number; fileId?: string | null }>('/uploads/resume', {
          method: 'POST',
          body: { uploadUrl, sizeBytes: size },
        });
        offset = state.received;
        if (state.complete && state.fileId) fileId = state.fileId;
        update(item.id, { uploadedBytes: offset });
      } catch {
        uploadUrl = undefined;
      }
    }
    if (!fileId && !uploadUrl) {
      const init = await api<{
        assetId: string; uploadUrl: string; chunkSize: number;
        duplicate: QueueItem['duplicate'];
      }>('/uploads/initiate', {
        method: 'POST',
        body: {
          filename: item.displayName,
          sizeBytes: size,
          contentType: item.file.type || 'application/octet-stream',
          assetType: item.assetType,
          songId: item.songId || null,
          folderId: item.folderId || null,
          checksumSHA256: checksum,
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
    if (fileId) offset = size;
    update(item.id, {
      startedAt: Date.now(), startedBytes: offset, bytesSent: offset,
      progress: Math.min(99, Math.round((offset / Math.max(1, size)) * 100)),
    });
    let attempt = 0;

    while (!fileId && uploadUrl && offset < size) {
      const end = Math.min(offset + chunkSize, size);
      const blob = item.file.slice(offset, end, item.file.type || 'application/octet-stream');
      const chunkStart = offset;
      try {
        const result = await putChunk(
          uploadUrl,
          blob,
          chunkStart,
          size,
          (sentInThisChunk) => {
            const sent = chunkStart + sentInThisChunk;
            report(item.id, {
              progress: Math.min(99, Math.round((sent / size) * 100)),
              bytesSent: sent,
            });
          },
          controller.signal,
        );
        if (result.file) { fileId = result.file.id; offset = size; }
        else {

          offset = result.received ?? end;
        }
        report(item.id, { uploadedBytes: offset, bytesSent: offset });
        attempt = 0;
      } catch (err) {
        if (controller.signal.aborted) throw err;
        await untilOnline(controller.signal);
        if (controller.signal.aborted) throw err;
        attempt += 1;
        if (attempt > MAX_RETRIES) throw err;
        try {

          const state = await api<{ complete: boolean; received: number; fileId?: string | null }>('/uploads/resume', {
            method: 'POST', body: { uploadUrl, sizeBytes: size },
          });
          offset = state.received;
          if (state.complete) { fileId = state.fileId ?? fileId; break; }
        } catch {
          throw new Error('The upload session expired. Start this file again.');
        }
        await new Promise((r) => { setTimeout(r, Math.min(8000, 2 ** attempt * 400)); });
      }
    }
    update(item.id, { state: 'FINALISING', progress: 99 });
    if (!fileId) throw new Error('Google did not return a file id for the finished upload.');
    update(item.id, { fileId });
    const asset = await api<Asset>('/uploads/complete', {
      method: 'POST',
      body: {
        assetId,
        fileId,
        uploadUrl,
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
          checksumSHA256: checksum,
        },
      },
    });
    update(item.id, { state: 'DONE', progress: 100, result: asset });
    return asset;
  } catch (err) {
    if (controller.signal.aborted) {
      update(item.id, { state: 'PAUSED' });
      return null;
    }
    update(item.id, { state: 'FAILED', error: err instanceof Error ? err.message : 'Upload failed' });
    return null;
  }
}
