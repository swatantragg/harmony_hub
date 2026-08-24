import net from 'node:net';
import { Readable } from 'node:stream';
import {
  CLAMAV_ENABLED, CLAMAV_FAIL_CLOSED, CLAMAV_HOST, CLAMAV_MAX_BYTES, CLAMAV_PORT, CLAMAV_TIMEOUT_MS,
} from '../config.js';
import { downloadResponse } from '../storage/drive.js';

export const enabled = () => CLAMAV_ENABLED;

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

      if (/\bFOUND\b/.test(line)) {
        const signature = line.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '').trim();
        return finish(resolve, { clean: false, signature });
      }
      if (/\bOK\b/.test(line)) return finish(resolve, { clean: true, signature: null });
      return finish(reject, new Error(line || 'clamd returned an unreadable answer'));
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      stream.on('data', (chunk) => {
        if (settled) return;
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length);
        if (!socket.write(Buffer.concat([header, chunk]))) stream.pause?.();
      });
      socket.on('drain', () => stream.resume?.());
      stream.on('end', () => {
        if (settled) return;
        socket.write(Buffer.alloc(4));
      });
      stream.on('error', (err) => finish(reject, err));
    });
  });
}
export async function scanDriveFile(fileId, { sizeBytes = 0 } = {}) {
  if (!CLAMAV_ENABLED) return { scanned: false, clean: true, signature: null, reason: 'disabled' };

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
export async function gate(fileId, { sizeBytes = 0 } = {}) {
  const result = await scanDriveFile(fileId, { sizeBytes });
  if (result.scanned && !result.clean) {
    return { allow: false, quarantine: true, ...result };
  }
  const skippedDeliberately = result.reason === 'disabled' || String(result.reason || '').includes('scan ceiling');
  if (!result.scanned && CLAMAV_FAIL_CLOSED && !skippedDeliberately) {
    return { allow: false, quarantine: true, ...result, failedClosed: true };
  }
  return { allow: true, quarantine: false, ...result };
}