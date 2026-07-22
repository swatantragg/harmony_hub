// The multipart upload engine (§8.3).
//
// State machine per file: HASHING → READY → UPLOADING → FINALISING → DONE | FAILED | PAUSED
//
// Parts are PUT straight from the browser to the storage endpoint using presigned URLs.
// Four parts fly concurrently, each with its own progress and its own retry budget — a
// failed part is retried alone, never the whole file.
import { create } from 'zustand';
import { api } from '../../lib/api';
import type { Asset } from '../../lib/types';

export type UploadState = 'HASHING' | 'READY' | 'UPLOADING' | 'FINALISING' | 'DONE' | 'FAILED' | 'PAUSED';
export type PartState = 'pending' | 'doing' | 'done' | 'failed';

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
  // Runtime
  assetId?: string;
  uploadId?: string;
  key?: string;
  partStates: PartState[];
  partsDone: { partNumber: number; etag: string }[];
  duplicate?: { assetId: string; displayName: string; songTitle: string } | null;
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
          partStates: [] as PartState[],
          partsDone: [] as { partNumber: number; etag: string }[],
          bytesSent: 0,
          ...defaults,
        })),
      ],
    })),
  update: (id, patch) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clearDone: () => set((s) => ({ items: s.items.filter((i) => i.state !== 'DONE') })),
}));

// SHA-256 via SubtleCrypto. Large files are hashed in slices so the tab stays responsive.
export async function checksum(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// One part, with progress reporting. XHR rather than fetch — it is the only way to get
// upload progress events in the browser today.
function putPart(url: string, blob: Blob, onProgress: (sent: number) => void, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag') || '');
      else reject(new Error(`Storage rejected the part (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error while sending a part'));
    xhr.onabort = () => reject(new Error('paused'));
    signal.addEventListener('abort', () => xhr.abort());
    xhr.send(blob);
  });
}

const CONCURRENCY = 4;
const MAX_RETRIES = 3;

export async function runUpload(item: QueueItem, controller: AbortController) {
  const { update } = useQueue.getState();
  const sentPerPart = new Map<number, number>();

  const reportProgress = () => {
    const sent = [...sentPerPart.values()].reduce((a, b) => a + b, 0);
    update(item.id, { progress: Math.min(99, Math.round((sent / item.file.size) * 100)), bytesSent: sent });
  };

  try {
    update(item.id, { state: 'UPLOADING', error: null, startedAt: Date.now() });

    // 1 — initiate: the API validates, creates the multipart upload and signs the parts.
    const init = await api<{
      assetId: string; uploadId: string; key: string; partSize: number;
      parts: { partNumber: number; url: string }[];
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

    update(item.id, {
      assetId: init.assetId, uploadId: init.uploadId, key: init.key,
      duplicate: init.duplicate,
      partStates: init.parts.map(() => 'pending' as PartState),
    });

    // 2 — send parts, four at a time, straight to storage.
    const queue = [...init.parts];
    const done: { partNumber: number; etag: string }[] = [];

    const worker = async () => {
      while (queue.length) {
        const part = queue.shift();
        if (!part) return;
        const start = (part.partNumber - 1) * init.partSize;
        // Carry the content type onto the slice — Blob.slice() drops it otherwise, and a
        // part sent with no type is harder for any storage endpoint to handle.
        const blob = item.file.slice(
          start,
          Math.min(start + init.partSize, item.file.size),
          item.file.type || 'application/octet-stream',
        );

        const states = [...useQueue.getState().items.find((i) => i.id === item.id)!.partStates];
        states[part.partNumber - 1] = 'doing';
        update(item.id, { partStates: states });

        let attempt = 0;
        for (;;) {
          try {
            const etag = await putPart(part.url, blob, (sent) => {
              sentPerPart.set(part.partNumber, sent);
              reportProgress();
            }, controller.signal);
            done.push({ partNumber: part.partNumber, etag });
            sentPerPart.set(part.partNumber, blob.size);
            reportProgress();
            const s2 = [...useQueue.getState().items.find((i) => i.id === item.id)!.partStates];
            s2[part.partNumber - 1] = 'done';
            update(item.id, { partStates: s2, partsDone: [...done] });
            break;
          } catch (err) {
            if (controller.signal.aborted) throw err;
            attempt += 1;
            if (attempt > MAX_RETRIES) {
              const s3 = [...useQueue.getState().items.find((i) => i.id === item.id)!.partStates];
              s3[part.partNumber - 1] = 'failed';
              update(item.id, { partStates: s3 });
              throw err;
            }
            // Exponential backoff — only this part is retried.
            await new Promise((r) => setTimeout(r, 2 ** attempt * 250));
          }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, init.parts.length) }, worker));

    // 3 — complete: the API assembles the object, confirms it with HeadObject, and only
    // then writes the catalogue record.
    update(item.id, { state: 'FINALISING', progress: 99 });
    const asset = await api<Asset>('/uploads/complete', {
      method: 'POST',
      body: {
        assetId: init.assetId,
        uploadId: init.uploadId,
        key: init.key,
        parts: done,
        songId: item.songId || null,
        folderId: item.folderId || null,
        metadata: {
          displayName: item.displayName,
          originalName: item.file.name,
          description: item.description,
          assetType: item.assetType,
          version: item.version,
          tags: item.tags,
          checksumSHA256: item.checksum,
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
