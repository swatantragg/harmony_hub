/**
 * Fingerprints one file per message, off the page.
 *
 * Small files go to crypto.subtle, which is native and digests a whole buffer
 * at once. Anything bigger is read a slice at a time into the incremental
 * hasher, so memory stays at two slices whatever the file size. The next slice
 * is already being read while this one is hashed.
 *
 * Nothing here needs cancelling: the page terminates the worker instead.
 */
import { Sha256 } from './sha256';

export type HashRequest = { id: string; file: Blob };
export type HashReply =
  | { id: string; type: 'progress'; hashedBytes: number }
  | { id: string; type: 'done'; checksum: string }
  | { id: string; type: 'error'; message: string };

/** At or under this, the file is read whole and handed to crypto.subtle. */
const WHOLE_FILE_MAX = 64 * 1024 * 1024;
const SLICE = 8 * 1024 * 1024;
const PROGRESS_EVERY_MS = 250;

const reply = (message: HashReply) => postMessage(message);

const toHex = (digest: ArrayBuffer) =>
  [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256(id: string, file: Blob): Promise<string> {
  if (file.size <= WHOLE_FILE_MAX && globalThis.crypto?.subtle) {
    return toHex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  }
  const hasher = new Sha256();
  const read = (at: number) => file.slice(at, Math.min(file.size, at + SLICE)).arrayBuffer();
  let lastReport = Date.now();
  let next = file.size > 0 ? read(0) : null;
  for (let at = 0; next; ) {
    const slice = new Uint8Array(await next);
    at += slice.length;
    next = at < file.size ? read(at) : null;
    hasher.update(slice);
    if (Date.now() - lastReport >= PROGRESS_EVERY_MS) {
      lastReport = Date.now();
      reply({ id, type: 'progress', hashedBytes: at });
    }
  }
  return hasher.hex();
}

addEventListener('message', (event: MessageEvent<HashRequest>) => {
  const { id, file } = event.data;
  sha256(id, file).then(
    (checksum) => reply({ id, type: 'done', checksum }),
    (err: unknown) => reply({ id, type: 'error', message: err instanceof Error ? err.message : String(err) }),
  );
});
