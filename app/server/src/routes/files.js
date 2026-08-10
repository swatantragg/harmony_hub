// The byte path. One route, no session, no JSON: GET /api/files/:token streams a single
// Google Drive file to whoever holds a valid ticket (see services/signing.js for why a
// ticket rather than a long-lived link).
//
// Three properties this route has to hold, and how:
//
//   Nothing is buffered.  The Drive response body is piped straight through. A 4 GB video
//                         costs a few hundred kilobytes of memory here, not 4 GB.
//   Range works.          The browser's Range header is forwarded to Drive verbatim and
//                         Drive's 206 is relayed with its Content-Range intact. Without
//                         this, seeking in a video would download the whole file first,
//                         and <video> would refuse to scrub at all.
//   Aborts propagate.     When the browser gives up mid-stream, the fetch to Drive is
//                         aborted too, instead of quietly finishing at Google's expense.
import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { verifyFileToken } from '../services/signing.js';
import { contentDisposition } from '../services/storage.js';
import { downloadResponse, driveErrorCode, isNotFound } from '../storage/drive.js';
import { problem } from '../middleware/auth.js';

export const filesRouter = express.Router();

// Headers Drive sets that must not be relayed: they describe Google's connection to us,
// not ours to the browser, and copying them corrupts the response.
const SKIP = new Set([
  'content-encoding', 'transfer-encoding', 'connection', 'keep-alive',
  'content-disposition', 'access-control-allow-origin', 'alt-svc', 'set-cookie',
]);

filesRouter.get('/:token', async (req, res) => {
  const grant = verifyFileToken(req.params.token);
  if (!grant.ok) {
    const detail = grant.reason === 'expired'
      ? 'This link has expired. Links are deliberately short-lived — reopen the file in Harmony Hub for a fresh one.'
      : 'This link is not valid.';
    return problem(res, grant.reason === 'expired' ? 410 : 403, grant.reason === 'expired' ? 'Gone' : 'Forbidden', detail);
  }

  const controller = new AbortController();
  // The browser closing the tab, or the <video> element seeking elsewhere, must stop the
  // transfer from Google rather than letting it run to completion unread.
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  let upstream;
  try {
    upstream = await downloadResponse(grant.fileId, {
      // A Google Docs export cannot be ranged — it is generated on the fly — so the
      // header is only forwarded for files that have real stored bytes.
      range: grant.exportMime ? undefined : req.headers.range,
      exportMimeType: grant.exportMime || undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (isNotFound(err)) {
      return problem(res, 410, 'Gone', 'Google Drive no longer has this file. Harmony Hub will flag it as missing on the next check.');
    }
    return problem(res, 502, 'Bad Gateway', `Google Drive refused the read: ${driveErrorCode(err)}`);
  }

  res.status(upstream.status === 206 ? 206 : 200);
  for (const [name, value] of upstream.headers) {
    if (!SKIP.has(name.toLowerCase())) res.setHeader(name, value);
  }
  res.setHeader('content-disposition', contentDisposition(grant.filename, { inline: grant.inline }));
  res.setHeader('accept-ranges', 'bytes');
  // The ticket already expires; a cached copy that outlived it would defeat the point.
  res.setHeader('cache-control', 'private, max-age=0, no-store');
  res.setHeader('x-content-type-options', 'nosniff');

  if (!upstream.body) return res.end();

  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    // A client that hangs up mid-stream is the normal case for video, not an error.
    if (!res.headersSent) res.status(502);
    if (!res.writableEnded) res.end();
    if (err?.name !== 'AbortError' && err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error('[files] stream failed:', err.message);
    }
  }
});

// HEAD is what a <video> element issues first to learn the length and whether ranges are
// supported. Answering it saves a wasted full-body request on every media preview.
filesRouter.head('/:token', async (req, res) => {
  const grant = verifyFileToken(req.params.token);
  if (!grant.ok) return res.status(grant.reason === 'expired' ? 410 : 403).end();
  try {
    const upstream = await downloadResponse(grant.fileId, { range: 'bytes=0-0' });
    const total = Number(String(upstream.headers.get('content-range') || '').split('/')[1] || 0);
    upstream.body?.cancel?.();
    res.setHeader('accept-ranges', 'bytes');
    if (total) res.setHeader('content-length', String(total));
    const type = upstream.headers.get('content-type');
    if (type) res.setHeader('content-type', type);
    res.setHeader('content-disposition', contentDisposition(grant.filename, { inline: grant.inline }));
    return res.status(200).end();
  } catch {
    return res.status(502).end();
  }
});
