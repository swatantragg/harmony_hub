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

const SKIP = new Set([
  'content-encoding', 'transfer-encoding', 'connection', 'keep-alive',
  'content-disposition', 'content-type', 'content-security-policy',
  'access-control-allow-origin', 'access-control-expose-headers',
  'alt-svc', 'set-cookie', 'x-frame-options', 'server', 'x-guploader-uploadid',
]);

function stillAuthorised(grant) {
  if (grant.userId) {
    const user = db.users.find((u) => u._id === grant.userId);
    if (!user || user.status !== 'active') {
      return { ok: false, status: 403, detail: 'The account this link was created for is no longer active.' };
    }
    if (grant.tokenVersion != null && Number(grant.tokenVersion) !== Number(user.tokenVersion ?? 0)) {
      return { ok: false, status: 403, detail: 'This link was created before the account’s sessions were reset. Open the file again for a fresh one.' };
    }
  }
  if (grant.shareId) {
    const share = db.shares.find((s) => s._id === grant.shareId);
    if (!share) return { ok: false, status: 410, detail: 'The share this link belongs to no longer exists.' };
    if (share.revokedAt) return { ok: false, status: 410, detail: 'This link has been revoked by its owner.' };
    if (Date.parse(share.expiresAt) < Date.now()) {
      return { ok: false, status: 410, detail: 'The share this link belongs to has expired.' };
    }
  }
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


function harden(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
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
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  let upstream;
  try {
    upstream = await downloadResponse(grant.fileId, {

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

    if (!res.headersSent) res.status(502);
    if (!res.writableEnded) res.end();
    if (err?.name !== 'AbortError' && err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error('[files] stream failed:', err.message);
    }
  }
});
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