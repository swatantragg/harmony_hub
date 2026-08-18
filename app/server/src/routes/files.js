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
//
// And three the route did not hold before, which is what the rest of this file is about:
//
//   The ticket is not     A signature and an expiry say the ticket was minted by us and is
//   the whole story.      not stale. They say nothing about whether the account it was
//                         minted for still exists, whether the share it came from has been
//                         revoked, or whether the asset has since been purged. All three
//                         are checked here, at redemption, on every request.
//   Nothing executes.     This route answers on the application's own origin, so anything
//                         served inline runs with the application's privileges. Only an
//                         allowlist of media types is ever served inline; everything else
//                         downloads, with an inert content type, under a sandbox CSP.
//   Egress is metered.    An unauthenticated route that streams whole files is a bandwidth
//                         and Drive-quota liability without a budget on it.
import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { assetContext, db } from '../db.js';
import { verifyFileToken } from '../services/signing.js';
import { contentDisposition, dispositionFor, safeContentType } from '../services/storage.js';
import { downloadResponse, driveErrorCode, isNotFound } from '../storage/drive.js';
import { problem } from '../middleware/auth.js';
import { record } from '../services/audit.js';

export const filesRouter = express.Router();

// Headers Drive sets that must not be relayed: they describe Google's connection to us,
// not ours to the browser, and copying them corrupts the response — or, in the case of
// content-type and the CORS headers, overrides a decision this file has already made.
const SKIP = new Set([
  'content-encoding', 'transfer-encoding', 'connection', 'keep-alive',
  'content-disposition', 'content-type', 'content-security-policy',
  'access-control-allow-origin', 'access-control-expose-headers',
  'alt-svc', 'set-cookie', 'x-frame-options', 'server', 'x-guploader-uploadid',
]);

/**
 * Everything a valid signature does not prove.
 *
 * A ticket is a bearer credential with a lifetime, so between minting and redemption the
 * world can change underneath it: the person can be suspended, their password changed,
 * the share revoked, the file purged. Each of those is a revocation the product promises,
 * and a promise that is only kept at mint time is not kept at all.
 */
function stillAuthorised(grant) {
  // Minted for a person → that person must still be able to sign in, at the same session
  // generation. A suspension, a role change or a password change bumps tokenVersion and
  // lands here as a 403.
  if (grant.userId) {
    const user = db.users.find((u) => u._id === grant.userId);
    if (!user || user.status !== 'active') {
      return { ok: false, status: 403, detail: 'The account this link was created for is no longer active.' };
    }
    if (grant.tokenVersion != null && Number(grant.tokenVersion) !== Number(user.tokenVersion ?? 0)) {
      return { ok: false, status: 403, detail: 'This link was created before the account’s sessions were reset. Open the file again for a fresh one.' };
    }
  }

  // Minted under a share → the share's gates are the link's gates, for its whole life.
  if (grant.shareId) {
    const share = db.shares.find((s) => s._id === grant.shareId);
    if (!share) return { ok: false, status: 410, detail: 'The share this link belongs to no longer exists.' };
    if (share.revokedAt) return { ok: false, status: 410, detail: 'This link has been revoked by its owner.' };
    if (Date.parse(share.expiresAt) < Date.now()) {
      return { ok: false, status: 410, detail: 'The share this link belongs to has expired.' };
    }
  }

  // Minted for a catalogued asset → a purge or a soft delete ends every outstanding link
  // to it, rather than leaving up to an hour of working access to a file somebody
  // deliberately removed.
  if (grant.assetId) {
    const ctx = assetContext(grant.assetId);
    if (!ctx) return { ok: false, status: 410, detail: 'This file is no longer in the catalogue.' };
    if (ctx.asset.deletedAt) return { ok: false, status: 410, detail: 'This file has been deleted.' };
    if (ctx.asset.drive?.fileId && ctx.asset.drive.fileId !== grant.fileId) {
      return { ok: false, status: 410, detail: 'This file has been replaced. Open it again for a current link.' };
    }
  }

  return { ok: true };
}

// Applied to every response on this route, whatever it carries.
//
// The sandbox directive is the load-bearing one: even if an executable type were somehow
// served inline, a sandboxed document has an opaque origin — no access to the
// application's storage, no scripts, no forms, no navigation of the opener.
function harden(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  // The ticket already expires; a cached copy that outlived it would defeat the point.
  res.setHeader('cache-control', 'private, max-age=0, no-store');
}

function verify(req, res) {
  const grant = verifyFileToken(req.params.token);
  if (!grant.ok) {
    const expired = grant.reason === 'expired';
    harden(res);
    problem(
      res,
      expired ? 410 : 403,
      expired ? 'Gone' : 'Forbidden',
      expired
        ? 'This link has expired. Links are deliberately short-lived — reopen the file in GCloud for a fresh one.'
        : 'This link is not valid.',
    );
    return null;
  }

  const live = stillAuthorised(grant);
  if (!live.ok) {
    harden(res);
    // Recorded: a burst of these is either a revoked partner still trying, or a leaked
    // link being worked through by somebody who should not have it.
    record(
      { ip: req.ip, socketIp: req.socketIp, get: (h) => req.get(h), user: null },
      {
        action: 'FILE_TICKET_REJECTED', entity: 'asset', entityId: grant.assetId ?? 'unknown',
        label: `Rejected a file link: ${live.detail}`,
        meta: { purpose: grant.purpose, shareId: grant.shareId ?? null, ticketId: grant.ticketId },
      },
    );
    problem(res, live.status, live.status === 410 ? 'Gone' : 'Forbidden', live.detail);
    return null;
  }
  return grant;
}

filesRouter.get('/:token', async (req, res) => {
  const grant = verify(req, res);
  if (!grant) return;

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
    harden(res);
    if (isNotFound(err)) {
      return problem(res, 410, 'Gone', 'Google Drive no longer has this file. GCloud will flag it as missing on the next check.');
    }
    return problem(res, 502, 'Bad Gateway', `Google Drive refused the read: ${driveErrorCode(err)}`);
  }

  res.status(upstream.status === 206 ? 206 : 200);
  for (const [name, value] of upstream.headers) {
    if (!SKIP.has(name.toLowerCase())) res.setHeader(name, value);
  }

  // The content type Google reports for the stored bytes — not the one the uploader
  // claimed, and not one this process is free to trust. The policy decides what happens
  // to it: media renders inline, everything else downloads, and an executable type is
  // rewritten to application/octet-stream on the way out.
  const upstreamType = grant.exportMime || upstream.headers.get('content-type');
  const decision = dispositionFor(upstreamType, { requested: grant.inline });

  harden(res);
  res.setHeader('content-type', safeContentType(decision.type));
  res.setHeader('content-disposition', contentDisposition(grant.filename, { inline: decision.inline }));
  res.setHeader('accept-ranges', 'bytes');

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
  const grant = verify(req, res);
  if (!grant) return;
  try {
    const upstream = await downloadResponse(grant.fileId, { range: 'bytes=0-0' });
    const total = Number(String(upstream.headers.get('content-range') || '').split('/')[1] || 0);
    upstream.body?.cancel?.();
    const decision = dispositionFor(upstream.headers.get('content-type'), { requested: grant.inline });
    harden(res);
    res.setHeader('accept-ranges', 'bytes');
    if (total) res.setHeader('content-length', String(total));
    res.setHeader('content-type', safeContentType(decision.type));
    res.setHeader('content-disposition', contentDisposition(grant.filename, { inline: decision.inline }));
    return res.status(200).end();
  } catch {
    harden(res);
    return res.status(502).end();
  }
});
