// Malware scanning, against ClamAV (§12.5).
//
// The content policy already answers "is this the kind of file the library takes?" — by
// extension, by declared type, and by the first bytes Google actually stored. None of that
// answers "is this file malicious", because a genuinely infected PDF is a perfectly valid
// PDF. That question needs signatures, and signatures need updating, which is a daemon's
// job rather than an application's.
//
// So this speaks clamd's INSTREAM protocol directly. No dependency: the protocol is a
// command, length-prefixed chunks, and a one-line answer.
//
//   → zINSTREAM\0
//   → <4-byte big-endian length><chunk>   … repeated
//   → <4 zero bytes>                       end of stream
//   ← stream: OK\0            |  stream: Eicar-Test-Signature FOUND\0
//
// ── The two decisions that matter ───────────────────────────────────────────
//
// 1. Where it runs. The bytes are in Google Drive, not here, so a scan means reading the
//    file back out and streaming it past the scanner. That is real bandwidth and real
//    time, which is why it is opt-in, size-capped, and happens once per upload rather
//    than on every read.
//
// 2. What happens when the scanner is unreachable. Failing open means an outage silently
//    turns scanning off, which is the failure nobody notices. Failing closed means clamd
//    going down stops uploads. The default is closed — if you switched scanning on, you
//    meant it — and it is one setting to change if that trade is wrong for you.
import net from 'node:net';
import { Readable } from 'node:stream';
import {
  CLAMAV_ENABLED, CLAMAV_FAIL_CLOSED, CLAMAV_HOST, CLAMAV_MAX_BYTES, CLAMAV_PORT, CLAMAV_TIMEOUT_MS,
} from '../config.js';
import { downloadResponse } from '../storage/drive.js';

export const enabled = () => CLAMAV_ENABLED;

/** Is the daemon there? Used by the health screen and at boot. */
export async function ping() {
  if (!CLAMAV_ENABLED) return { ok: false, reason: 'disabled' };
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: CLAMAV_HOST, port: CLAMAV_PORT });
    let answer = '';
    const done = (out) => {
      socket.destroy();
      resolve(out);
    };
    socket.setTimeout(Math.min(5000, CLAMAV_TIMEOUT_MS));
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (chunk) => {
      answer += chunk.toString('utf8');
      if (answer.includes('PONG')) done({ ok: true });
    });
    socket.on('timeout', () => done({ ok: false, reason: 'timeout' }));
    socket.on('error', (err) => done({ ok: false, reason: err.code || err.message }));
    socket.on('close', () => done({ ok: false, reason: 'closed' }));
  });
}

export async function version() {
  if (!CLAMAV_ENABLED) return null;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: CLAMAV_HOST, port: CLAMAV_PORT });
    let answer = '';
    socket.setTimeout(Math.min(5000, CLAMAV_TIMEOUT_MS));
    socket.on('connect', () => socket.write('zVERSION\0'));
    socket.on('data', (chunk) => { answer += chunk.toString('utf8'); });
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
    socket.on('error', () => resolve(null));
    socket.on('close', () => resolve(answer.replace(/\0/g, '').trim() || null));
  });
}

/**
 * Streams a readable past clamd.
 *
 * @returns {Promise<{clean: boolean, signature: string|null}>}
 * @throws when the daemon cannot be reached or the stream is refused — the caller decides
 *         what an unreachable scanner means, because that is a policy question.
 */
export function scanStream(stream) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: CLAMAV_HOST, port: CLAMAV_PORT });
    let answer = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      stream.destroy?.();
      fn(value);
    };

    socket.setTimeout(CLAMAV_TIMEOUT_MS);
    socket.on('timeout', () => finish(reject, new Error('clamd did not answer in time')));
    socket.on('error', (err) => finish(reject, new Error(`clamd unreachable: ${err.code || err.message}`)));

    socket.on('data', (chunk) => {
      answer += chunk.toString('utf8');
      if (!answer.includes('\0') && !answer.includes('\n')) return;
      const line = answer.replace(/\0/g, '').trim();

      // clamd answers the moment it finds something, before the whole file has been sent.
      if (/\bFOUND\b/.test(line)) {
        const signature = line.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '').trim();
        return finish(resolve, { clean: false, signature });
      }
      if (/\bOK\b/.test(line)) return finish(resolve, { clean: true, signature: null });
      // INSTREAM size limit exceeded, or a daemon-side error.
      return finish(reject, new Error(line || 'clamd returned an unreadable answer'));
    });

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');

      stream.on('data', (chunk) => {
        if (settled) return;
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length);
        // Backpressure: clamd is usually slower than Drive is at delivering.
        if (!socket.write(Buffer.concat([header, chunk]))) stream.pause?.();
      });
      socket.on('drain', () => stream.resume?.());

      stream.on('end', () => {
        if (settled) return;
        // Four zero bytes closes the stream and asks for the verdict.
        socket.write(Buffer.alloc(4));
      });
      stream.on('error', (err) => finish(reject, err));
    });
  });
}

/**
 * Reads one Drive file back and scans it.
 *
 * @returns {Promise<{scanned: boolean, clean: boolean, signature: string|null, reason?: string}>}
 *          `scanned: false` means no verdict was reached — the caller applies the
 *          fail-open/fail-closed policy rather than guessing.
 */
export async function scanDriveFile(fileId, { sizeBytes = 0 } = {}) {
  if (!CLAMAV_ENABLED) return { scanned: false, clean: true, signature: null, reason: 'disabled' };

  // clamd refuses a stream past StreamMaxLength and the connection dies mid-transfer, so
  // the ceiling is checked here rather than discovered. A 40 GB master is not something a
  // signature scanner has an opinion about anyway.
  if (sizeBytes && sizeBytes > CLAMAV_MAX_BYTES) {
    return {
      scanned: false,
      clean: true,
      signature: null,
      reason: `larger than the ${Math.round(CLAMAV_MAX_BYTES / 1024 ** 2)} MB scan ceiling`,
    };
  }

  try {
    const response = await downloadResponse(fileId, { signal: AbortSignal.timeout(CLAMAV_TIMEOUT_MS) });
    const out = await scanStream(Readable.fromWeb(response.body));
    return { scanned: true, ...out };
  } catch (err) {
    return { scanned: false, clean: true, signature: null, reason: err.message };
  }
}

/**
 * The policy wrapper the upload path uses: turns a verdict into an allow or a refusal,
 * applying the fail-closed setting when no verdict was reached.
 */
export async function gate(fileId, { sizeBytes = 0 } = {}) {
  const result = await scanDriveFile(fileId, { sizeBytes });

  if (result.scanned && !result.clean) {
    return { allow: false, quarantine: true, ...result };
  }
  // A size-capped file is a deliberate skip, not a failure — it is allowed either way.
  const skippedDeliberately = result.reason === 'disabled' || String(result.reason || '').includes('scan ceiling');
  if (!result.scanned && CLAMAV_FAIL_CLOSED && !skippedDeliberately) {
    return { allow: false, quarantine: true, ...result, failedClosed: true };
  }
  return { allow: true, quarantine: false, ...result };
}
