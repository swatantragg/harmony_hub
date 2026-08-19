// External sharing (§10.10). Hard expiry, download caps, instant revocation, and a
// HeadObject gate so a partner never receives a URL to a file that has gone missing.
//
// A link never carries a storage address. It carries a random token that resolves, on
// every open, into a freshly signed short-lived URL — which is why revoking works and
// why a leaked link cannot outlive its window. Nothing about the Google Drive file id,
// the folder, or the connected account ever reaches the recipient.
//
// Three audiences, chosen when the link is made:
//   PUBLIC      "Open to all"        — no account. Anyone holding the link opens it.
//   EDITOR      "Editor"             — must sign in to GCloud AND hold asset:edit.
//                                      Preview, download, and edit rights on the file.
//   RESTRICTED  "Specific allocation"— must sign in, and the account's email must be on
//                                      the recipient list attached to this link.
//
// A link points at either one asset or a whole folder. A folder link resolves to a
// manifest of its files — every one of them still a separate file in Google Drive, each
// signed individually at the moment it is opened. The Drive folder is never shared: its
// sharing settings are untouched, so revoking a GCloud link genuinely revokes access
// rather than leaving a Google link working behind it.
import express from 'express';
import { db, persist, assetsUnderFolder } from '../db.js';
import { authenticate, optionalAuthenticate, requires, problem } from '../middleware/auth.js';
import { context } from '../services/assets.js';
import { record, notify } from '../services/audit.js';
import * as storage from '../services/storage.js';
import { can } from '../catalogue.js';
import { TTL, APP_ORIGIN, TRASH_DAYS } from '../config.js';
import { uuid, token, hashPassword, verifyPassword } from '../util/crypto.js';
import { LIMITS, str } from '../util/validate.js';

export const sharesRouter = express.Router();
export const publicShareRouter = express.Router();

const DURATIONS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };
const AUDIENCES = ['PUBLIC', 'EDITOR', 'RESTRICTED'];

const AUDIENCE_LABEL = {
  PUBLIC: 'Open to all',
  EDITOR: 'Editor',
  RESTRICTED: 'Specific allocation',
};

// What kind of thing a link points at, for the category tabs on the Share links screen.
// Resolved rather than only read off the record: links created before the field existed
// still have an asset behind them, and a tab that silently omitted them would be lying.
function shareKind(s) {
  if (s.target === 'FOLDER') return { family: null, assetType: null, kind: 'FOLDER' };
  if (s.family) return { family: s.family, assetType: s.assetType ?? null, kind: s.family };
  const ctx = s.assetId ? context(s.assetId) : null;
  const family = ctx?.asset?.family ?? null;
  return { family, assetType: ctx?.asset?.type ?? null, kind: family ?? 'ASSET' };
}

// ── Per-recipient links (§10.10) ────────────────────────────────────────────
//
// A "specific allocation" link used to be one URL with a list of permitted addresses
// beside it. That makes revocation all-or-nothing: the moment one recipient forwards
// their mail, the only remedy is to revoke the link for everybody and reissue it, which
// is a punishment for the four people who did nothing wrong.
//
// So each recipient now gets a token of their own. Same share, same expiry, same cap —
// but the link identifies who it was sent to, and one can be switched off without
// touching the others. Signing in with the matching address is still required: the token
// says which recipient this claims to be, and the session proves it.
const recipientFor = (email) => ({
  _id: uuid(),
  email,
  token: token(24),
  createdAt: new Date().toISOString(),
  revokedAt: null,
  firstAccessedAt: null,
  lastAccessedAt: null,
  accessCount: 0,
  downloadCount: 0,
});

const publicRecipient = (r, shareUrl) => ({
  _id: r._id,
  email: r.email,
  url: shareUrl(r.token),
  createdAt: r.createdAt,
  revokedAt: r.revokedAt,
  firstAccessedAt: r.firstAccessedAt,
  lastAccessedAt: r.lastAccessedAt,
  accessCount: r.accessCount ?? 0,
  downloadCount: r.downloadCount ?? 0,
});

const decorate = (s) => ({
  ...s,
  // The digest never leaves the server, not even to the person who set it. There is no
  // "show me the passcode" — a forgotten one is replaced by making a new link.
  passcodeHash: undefined,
  hasPasscode: Boolean(s.passcodeHash),
  // One row per addressee, each with its own URL and its own revocation.
  recipients: (s.recipients || []).map((r) => publicRecipient(r, (t) => `${APP_ORIGIN}/#/s/${t}`)),
  ...shareKind(s),
  url: `${APP_ORIGIN}/#/s/${s.token}`,
  audienceLabel: AUDIENCE_LABEL[s.audience] ?? AUDIENCE_LABEL.PUBLIC,
  expired: Date.parse(s.expiresAt) < Date.now(),
  exhausted: s.maxDownloads != null && s.downloadCount >= s.maxDownloads,
  remainingMs: Date.parse(s.expiresAt) - Date.now(),
});

const normaliseEmails = (list) =>
  [...new Set((Array.isArray(list) ? list : [])
    .map((e) => String(e).trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];

// What a folder link actually covers: the folder and everything filed underneath it.
//
// It used to be the folder's own files only. Folders nest — the catalogue tree is the
// Drive tree — so on any library organised into subfolders that was wrong twice over: a
// recipient was handed a link that silently omitted most of the material, and a folder
// whose files all live one level down was refused outright as "empty, so there is nothing
// to share yet". Sharing a folder now means sharing the tree, which is what the wording
// on the dialog has always promised.
const shareableRows = (folderId) =>
  assetsUnderFolder(folderId).filter(({ asset }) => !asset.deletedAt);

// A folder link is only worth as much as the files inside it, so the manifest is built
// the same way the folder page is: catalogue membership, one signed URL per object. Every
// file is verified and signed concurrently — a 40-file folder should not open in 40 round
// trips one after another.
async function folderManifest(folder, { expiresIn, shareId }) {
  const rows = shareableRows(folder._id);
  await storage.verifyAssets(rows.map((r) => r.asset));

  return Promise.all(
    rows.map(async ({ asset, song, artist, folder: parent }) => {
      const status = asset.availability.status;
      const shareable = status !== 'MISSING' && status !== 'TRASHED';
      return {
        assetId: asset.assetId,
        displayName: asset.displayName,
        // Which subfolder it came out of, so a tree does not arrive as a flat list of
        // names with no way to tell two "master.wav"s apart. Null for the shared folder's
        // own files.
        subfolder: parent && parent._id !== folder._id ? parent.name : null,
        type: asset.type,
        family: asset.family,
        mimeType: asset.mimeType,
        sizeBytes: asset.drive?.sizeBytes ?? 0,
        version: asset.version,
        durationSec: asset.durationSec ?? null,
        dimensions: asset.dimensions ?? null,
        songTitle: song?.title ?? null,
        artistName: artist?.name ?? null,
        availability: status,
        previewUrl: shareable
          ? storage.signedUrl({
            fileId: asset.drive.fileId, filename: asset.displayName, mimeType: asset.mimeType,
            expiresIn, inline: true, purpose: 'share', assetId: asset.assetId,
            // Bound to the share, so revoking the link revokes every URL minted under it
            // rather than leaving an hour of working access behind.
            shareId,
          })
          : null,
      };
    }),
  );
}

sharesRouter.use(authenticate);

sharesRouter.get('/', requires('share:create'), (req, res) => {
  const rows = db.shares
    .map(decorate)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  res.json({ data: rows, total: rows.length });
});

sharesRouter.post('/', requires('share:create'), async (req, res) => {
  const {
    assetId, folderId, target: rawTarget, targetId: rawTargetId,
    audience: rawAudience = 'PUBLIC', allowedEmails,
    expiresIn = '7d', canDownload = true, maxDownloads = null, note = '', passcode,
  } = req.body || {};

  const target = rawTarget === 'FOLDER' || (!assetId && folderId) ? 'FOLDER' : 'ASSET';
  const targetId = rawTargetId || (target === 'FOLDER' ? folderId : assetId);
  if (!targetId) return problem(res, 422, 'Unprocessable Entity', 'Nothing was selected to share.');

  const noteCheck = str(note, { max: LIMITS.note, field: 'note', allowEmpty: true });
  if (noteCheck.problem) return problem(res, 422, 'Unprocessable Entity', noteCheck.problem);

  const audience = AUDIENCES.includes(rawAudience) ? rawAudience : 'PUBLIC';
  const emails = audience === 'RESTRICTED' ? normaliseEmails(allowedEmails) : [];
  if (audience === 'RESTRICTED' && emails.length === 0) {
    return problem(res, 422, 'Unprocessable Entity', 'A specific-allocation link needs at least one valid email address.');
  }
  if (emails.length > 200) {
    return problem(res, 422, 'Unprocessable Entity', 'A link can be allocated to at most 200 addresses.');
  }

  // An optional second factor for a link, and the only protection a PUBLIC link can have:
  // the URL is the credential, and a URL travels through mail clients, chat logs and
  // screenshots. Stored as a bcrypt digest — a share record is not a place to keep a
  // secret in the clear — and compared in constant time at the gate.
  const secret = passcode == null || passcode === '' ? null : String(passcode);
  if (secret && (secret.length < 6 || secret.length > 100)) {
    return problem(res, 422, 'Unprocessable Entity', 'A link passcode must be between 6 and 100 characters.');
  }

  const base = {
    _id: uuid(),
    target,
    targetId,
    audience,
    allowedEmails: emails,
    // Editor links carry write rights into the app; the other two are read paths only.
    canEdit: audience === 'EDITOR',
    token: token(24),
    // One per address, for a specific-allocation link. Empty for the other two audiences,
    // where there is one link and it is the same link for everybody by definition.
    recipients: emails.map(recipientFor),
    createdBy: req.user.sub,
    createdByName: req.user.name,
    note: noteCheck.value,
    passcodeHash: secret ? await hashPassword(secret) : null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (DURATIONS[expiresIn] ?? DURATIONS['7d'])).toISOString(),
    canDownload: Boolean(canDownload),
    maxDownloads: maxDownloads == null ? null : Number(maxDownloads),
    downloadCount: 0,
    revokedAt: null,
  };

  let share;
  if (target === 'FOLDER') {
    const folder = db.folders.find((f) => f._id === targetId && !f.deletedAt);
    if (!folder) return problem(res, 404, 'Not Found', 'No folder with that id.');
    const files = shareableRows(folder._id);
    if (files.length === 0) {
      return problem(res, 409, 'Conflict', 'This folder is empty — nothing is filed in it or in any folder inside it — so there is nothing to share yet.');
    }
    share = {
      ...base,
      assetId: null,
      assetName: folder.name,
      targetName: folder.name,
      fileCount: files.length,
      songTitle: null,
      artistName: null,
    };
  } else {
    const ctx = context(targetId);
    if (!ctx) return problem(res, 404, 'Not Found', 'No asset with that id.');
    const { availability } = await storage.verifyAsset(ctx.asset);
    if (availability.status === 'MISSING') {
      return problem(res, 409, 'Conflict', 'This file is not in storage, so it cannot be shared.');
    }
    share = {
      ...base,
      assetId: targetId,
      assetName: ctx.asset.displayName,
      targetName: ctx.asset.displayName,
      fileCount: 1,
      // Stored on the record so the category tabs do not have to resolve the asset on
      // every read, and still answer correctly after the file itself is gone.
      family: ctx.asset.family,
      assetType: ctx.asset.type,
      songTitle: ctx.song?.title ?? null,
      artistName: ctx.artist?.name ?? null,
    };
  }

  db.shares.unshift(share);
  persist();
  record(req, {
    action: 'SHARE_CREATE', entity: 'share', entityId: share._id,
    label: `Shared ${share.targetName} for ${expiresIn} (${AUDIENCE_LABEL[audience]})`,
    after: {
      target, audience, expiresAt: share.expiresAt,
      maxDownloads: share.maxDownloads, canDownload: share.canDownload,
      recipients: emails.length || null,
    },
  });
  res.status(201).json(decorate(share));
});

// Withdraw one addressee's link, leaving everybody else's alone. This is the whole point
// of issuing them separately: the person who forwarded their mail loses access, and the
// four who did nothing wrong do not have to be reissued.
sharesRouter.delete('/:id/recipients/:recipientId', requires('share:revoke'), (req, res) => {
  const share = db.shares.find((s) => s._id === req.params.id);
  if (!share) return problem(res, 404, 'Not Found', 'No share with that id.');
  const recipient = (share.recipients || []).find((r) => r._id === req.params.recipientId);
  if (!recipient) return problem(res, 404, 'Not Found', 'No recipient with that id on this link.');
  if (recipient.revokedAt) return res.json(decorate(share));

  recipient.revokedAt = new Date().toISOString();
  // The address comes off the permitted list too, so a link made before per-recipient
  // tokens existed cannot be used as a way back in.
  share.allowedEmails = (share.allowedEmails || []).filter((e) => e !== recipient.email);
  persist();
  record(req, {
    action: 'SHARE_RECIPIENT_REVOKE', entity: 'share', entityId: share._id,
    label: `Withdrew ${recipient.email}'s link to ${share.targetName ?? share.assetName}`,
    after: { email: recipient.email, revokedAt: recipient.revokedAt, downloadCount: recipient.downloadCount ?? 0 },
  });
  res.json(decorate(share));
});

// Add somebody to an existing allocation, with a link of their own, rather than making a
// second share for one more person.
sharesRouter.post('/:id/recipients', requires('share:create'), (req, res) => {
  const share = db.shares.find((s) => s._id === req.params.id);
  if (!share) return problem(res, 404, 'Not Found', 'No share with that id.');
  if (share.revokedAt) return problem(res, 410, 'Gone', 'This link has been revoked.');
  if ((share.audience ?? 'PUBLIC') !== 'RESTRICTED') {
    return problem(
      res, 409, 'Conflict',
      'Only a specific-allocation link has per-recipient links. This one is open to everybody who holds it.',
    );
  }

  const emails = normaliseEmails(req.body?.emails ?? [req.body?.email]);
  if (emails.length === 0) return problem(res, 422, 'Unprocessable Entity', 'Give at least one valid email address.');

  share.recipients ??= [];
  if (share.recipients.length + emails.length > 200) {
    return problem(res, 422, 'Unprocessable Entity', 'A link can be allocated to at most 200 addresses.');
  }

  const added = [];
  for (const email of emails) {
    const existing = share.recipients.find((r) => r.email === email);
    // Re-adding somebody who was withdrawn issues a *new* token rather than reviving the
    // old one — the old link stays dead, wherever it ended up.
    if (existing && !existing.revokedAt) continue;
    if (existing) share.recipients = share.recipients.filter((r) => r !== existing);
    const recipient = recipientFor(email);
    share.recipients.push(recipient);
    added.push(email);
  }
  share.allowedEmails = [...new Set([...(share.allowedEmails || []), ...emails])];
  persist();

  if (added.length) {
    record(req, {
      action: 'SHARE_RECIPIENT_ADD', entity: 'share', entityId: share._id,
      label: `Issued ${added.length} link${added.length === 1 ? '' : 's'} for ${share.targetName ?? share.assetName}`,
      after: { emails: added },
    });
  }
  res.status(added.length ? 201 : 200).json(decorate(share));
});

sharesRouter.delete('/:id', requires('share:revoke'), (req, res) => {
  const share = db.shares.find((s) => s._id === req.params.id);
  if (!share) return problem(res, 404, 'Not Found', 'No share with that id.');
  share.revokedAt = new Date().toISOString();
  persist();
  record(req, {
    action: 'SHARE_REVOKE', entity: 'share', entityId: share._id,
    label: `Revoked the link to ${share.targetName ?? share.assetName}`, after: { revokedAt: share.revokedAt },
  });
  res.json(decorate(share));
});

// ── Public resolution — all gates enforced (§10.10) ─────────────────────────
// Every gate is checked here, on the server, on every single open. The client is never
// trusted with any of it.
/**
 * Finds what a token in a URL refers to: the share's own link, or one recipient's.
 *
 * Returned together because every gate below has to consider both — an expired share
 * closes a recipient's link too, and a revoked recipient does not close the share.
 */
function resolveToken(value) {
  const token = String(value || '');
  const direct = db.shares.find((s) => s.token === token);
  if (direct) return { share: direct, recipient: null };
  for (const share of db.shares) {
    const recipient = (share.recipients || []).find((r) => r.token === token);
    if (recipient) return { share, recipient };
  }
  return { share: null, recipient: null };
}

async function openGate(share, req, res, recipient = null) {
  if (!share) { problem(res, 404, 'Not Found', 'This link does not exist.'); return false; }
  if (share.revokedAt) { problem(res, 410, 'Gone', 'This link has been revoked by its owner.'); return false; }
  if (Date.parse(share.expiresAt) < Date.now()) { problem(res, 410, 'Gone', 'This link has expired.'); return false; }

  // The passcode, when there is one, is checked before the audience — it applies to every
  // audience, including the signed-in ones, because it exists to protect against the URL
  // itself having gone somewhere it should not.
  if (share.passcodeHash) {
    const supplied = req.get('x-share-passcode') || req.body?.passcode || req.query?.passcode;
    if (!supplied) {
      problem(res, 401, 'Passcode Required', 'This link is protected by a passcode.', { passcodeRequired: true });
      return false;
    }
    if (!(await verifyPassword(String(supplied), share.passcodeHash))) {
      record(
        { ip: req.ip, socketIp: req.socketIp, get: (h) => req.get(h), user: req.user ?? null },
        {
          action: 'SHARE_PASSCODE_FAILED', entity: 'share', entityId: share._id,
          label: `Wrong passcode on the link to ${share.targetName ?? share.assetName}`,
        },
      );
      problem(res, 401, 'Passcode Required', 'That passcode is not correct.', { passcodeRequired: true });
      return false;
    }
  }

  const audience = share.audience ?? 'PUBLIC';

  // One recipient's link, switched off without touching anybody else's.
  if (recipient?.revokedAt) {
    problem(res, 410, 'Gone', 'This link was issued to you and has since been withdrawn. Ask the sender for a new one.');
    return false;
  }

  // A specific-allocation link that has per-recipient tokens is *only* reachable through
  // them. The share's own token would otherwise be a master key that no revocation
  // touches, which is the whole thing this replaced. Links made before this existed have
  // no recipient list and keep working the old way.
  if (audience === 'RESTRICTED' && !recipient && (share.recipients || []).length > 0) {
    problem(
      res, 404, 'Not Found',
      'This link was issued per recipient. Use the link that was sent to your address.',
    );
    return false;
  }

  if (audience === 'PUBLIC') return true;

  if (!req.user) {
    problem(res, 401, 'Sign In Required', audience === 'EDITOR'
      ? 'This link is for GCloud editors. Sign in to open it.'
      : 'This link was sent to named people. Sign in with the address it was sent to.');
    return false;
  }
  if (audience === 'EDITOR' && !can(req.user.role, 'asset:edit')) {
    problem(res, 403, 'Forbidden', `This is an editor link, and the ${req.user.role} role cannot edit files.`);
    return false;
  }
  if (audience === 'RESTRICTED') {
    const signedInAs = String(req.user.email || '').toLowerCase();
    // The token says which recipient this claims to be; the session has to agree. A
    // forwarded link opened by somebody else is refused here even though the token is
    // valid — which is the point of issuing them per address.
    if (recipient && recipient.email !== signedInAs) {
      record(
        { ip: req.ip, socketIp: req.socketIp, get: (h) => req.get(h), user: req.user },
        {
          action: 'SHARE_RECIPIENT_MISMATCH', entity: 'share', entityId: share._id,
          label: `${req.user.name} opened a link issued to ${recipient.email}`,
          meta: { issuedTo: recipient.email, openedBy: signedInAs },
        },
      );
      problem(
        res, 403, 'Forbidden',
        `This link was sent to ${recipient.email}. Sign in with that address, or ask the sender for one of your own.`,
      );
      return false;
    }
    if (!recipient && !(share.allowedEmails || []).includes(signedInAs)) {
      problem(res, 403, 'Forbidden', 'This link was not shared with your account.');
      return false;
    }
  }
  return true;
}

const capReached = (share) => share.maxDownloads != null && share.downloadCount >= share.maxDownloads;

publicShareRouter.get('/:token', optionalAuthenticate, async (req, res) => {
  const { share, recipient } = resolveToken(req.params.token);
  if (!await openGate(share, req, res, recipient)) return;

  const ttl = Math.min(TTL.share, Math.max(60, Math.floor((Date.parse(share.expiresAt) - Date.now()) / 1000)));
  const common = {
    share: {
      target: share.target ?? 'ASSET',
      audience: share.audience ?? 'PUBLIC',
      audienceLabel: AUDIENCE_LABEL[share.audience ?? 'PUBLIC'],
      canDownload: share.canDownload,
      canEdit: Boolean(share.canEdit),
      expiresAt: share.expiresAt,
      note: share.note,
      sharedBy: share.createdByName,
      downloadsRemaining: share.maxDownloads == null ? null : share.maxDownloads - share.downloadCount,
      recipientCount: (share.allowedEmails || []).length || null,
      hasPasscode: Boolean(share.passcodeHash),
    },
    viewer: req.user ? { name: req.user.name, email: req.user.email, role: req.user.role } : null,
  };

  // The first time a link is opened, the person who made it is told. A share is the one
  // thing in the product that leaves the building, so "it was opened, from this address,
  // at this time" is the signal that matters if it went somewhere unintended.
  const at = new Date().toISOString();
  if (!share.firstAccessedAt) {
    share.firstAccessedAt = at;
    notify({
      userId: share.createdBy,
      level: 'info',
      title: `Your link to ${share.targetName ?? share.assetName} was opened`,
      body: `First opened just now from ${req.socketIp ?? 'an unknown address'}${recipient ? ` on the link issued to ${recipient.email}` : ''}${req.user ? ` by ${req.user.name}` : ''}.`,
      link: '/shares',
    });
  }
  share.lastAccessedAt = at;
  share.accessCount = Number(share.accessCount ?? 0) + 1;
  // Counted per recipient too, so "who has actually opened this" is answerable.
  if (recipient) {
    recipient.firstAccessedAt ??= at;
    recipient.lastAccessedAt = at;
    recipient.accessCount = Number(recipient.accessCount ?? 0) + 1;
  }

  if ((share.target ?? 'ASSET') === 'FOLDER') {
    const folder = db.folders.find((f) => f._id === share.targetId && !f.deletedAt);
    if (!folder) return problem(res, 404, 'Not Found', 'The shared folder is no longer in the catalogue.');
    const files = await folderManifest(folder, { expiresIn: ttl, shareId: share._id });
    persist();
    return res.json({
      ...common,
      kind: 'FOLDER',
      folder: {
        name: folder.name,
        description: folder.description,
        tags: folder.tags,
        fileCount: files.length,
        totalBytes: files.reduce((n, f) => n + (f.sizeBytes || 0), 0),
      },
      files,
    });
  }

  const ctx = context(share.targetId ?? share.assetId);
  if (!ctx) return problem(res, 404, 'Not Found', 'The shared file is no longer catalogued.');

  const { availability } = await storage.verifyAsset(ctx.asset);
  if (availability.status === 'MISSING') {
    return problem(res, 503, 'Service Unavailable', 'The shared file is temporarily unavailable. The owner has been notified.');
  }
  persist();

  res.json({
    ...common,
    kind: 'ASSET',
    asset: {
      assetId: ctx.asset.assetId,
      displayName: ctx.asset.displayName, type: ctx.asset.type, family: ctx.asset.family,
      sizeBytes: ctx.asset.drive?.sizeBytes ?? 0, mimeType: ctx.asset.mimeType, version: ctx.asset.version,
      durationSec: ctx.asset.durationSec ?? null, dimensions: ctx.asset.dimensions ?? null,
      description: ctx.asset.description ?? '',
      songTitle: ctx.song?.title ?? null, artistName: ctx.artist?.name ?? null,
    },
    previewUrl: storage.signedUrl({
      fileId: ctx.asset.drive.fileId, filename: ctx.asset.displayName, mimeType: ctx.asset.mimeType,
      expiresIn: ttl, inline: true, purpose: 'share', assetId: ctx.asset.assetId,
      shareId: share._id,
    }),
    availability: availability.status,
  });
});

// One signed download. For a folder link the caller names which file it wants; the
// download cap counts files, not clicks, so an unlimited folder is an explicit choice.
publicShareRouter.post('/:token/download', optionalAuthenticate, async (req, res) => {
  const { share, recipient } = resolveToken(req.params.token);
  if (!await openGate(share, req, res, recipient)) return;
  if (!share.canDownload) return problem(res, 403, 'Forbidden', 'This link is preview-only.');
  if (capReached(share)) return problem(res, 429, 'Too Many Requests', 'This link has reached its download limit.');

  const wanted = req.body?.assetId;
  let assetId = share.targetId ?? share.assetId;

  if ((share.target ?? 'ASSET') === 'FOLDER') {
    if (!wanted) return problem(res, 422, 'Unprocessable Entity', 'Name the file to download.');
    const inFolder = shareableRows(share.targetId).some(({ asset }) => asset.assetId === wanted);
    if (!inFolder) return problem(res, 403, 'Forbidden', 'That file is not in the shared folder.');
    assetId = wanted;
  }

  const ctx = context(assetId);
  if (!ctx) return problem(res, 404, 'Not Found', 'The shared file is no longer catalogued.');
  const { availability } = await storage.verifyAsset(ctx.asset);
  if (availability.status === 'MISSING') {
    return problem(res, 503, 'Service Unavailable', 'That file is not in storage right now.');
  }
  if (availability.status === 'TRASHED') {
    return problem(res, 409, 'Conflict', `That file is in the owner's Google Drive trash. Ask them to restore it — Drive deletes trashed files permanently after ${TRASH_DAYS} days.`);
  }

  // Counted before the URL is minted, and re-checked after: two requests arriving together
  // both passed capReached() above, and the one that loses the race must not be handed a
  // link. The catalogue is single-writer in this process, so incrementing first and
  // reading back is enough to settle it.
  share.downloadCount += 1;
  if (recipient) recipient.downloadCount = Number(recipient.downloadCount ?? 0) + 1;
  if (share.maxDownloads != null && share.downloadCount > share.maxDownloads) {
    share.downloadCount = share.maxDownloads;
    persist();
    return problem(res, 429, 'Too Many Requests', 'This link has reached its download limit.');
  }
  persist();
  record(
    { ip: req.ip, socketIp: req.socketIp, get: (h) => req.get(h), user: req.user ?? { sub: null, name: 'external partner', role: 'public' } },
    {
      action: 'SHARE_ACCESS', entity: 'share', entityId: share._id,
      label: `External download of ${ctx.asset.displayName}`,
      after: { downloadCount: share.downloadCount, audience: share.audience ?? 'PUBLIC' },
    },
  );

  const downloadAs = storage.downloadName(ctx.asset.displayName, ctx.asset.mimeType);
  const url = storage.signedUrl({
    fileId: ctx.asset.drive.fileId, filename: downloadAs, mimeType: ctx.asset.mimeType,
    expiresIn: TTL.download, purpose: 'share', assetId: ctx.asset.assetId, shareId: share._id,
  });
  res.json({
    url,
    downloadAs,
    downloadsRemaining: share.maxDownloads == null ? null : share.maxDownloads - share.downloadCount,
  });
});

// "Download everything" on a folder link. Google Drive can zip a folder for its own UI but
// offers no API for it, and this build does not pretend otherwise: the API returns one
// signed URL per file and the browser fetches each in turn. Anything large would be handed
// to a zipper job rather than assembled here.
publicShareRouter.post('/:token/download-all', optionalAuthenticate, async (req, res) => {
  const { share, recipient } = resolveToken(req.params.token);
  if (!await openGate(share, req, res, recipient)) return;
  if ((share.target ?? 'ASSET') !== 'FOLDER') return problem(res, 422, 'Unprocessable Entity', 'This link is a single file.');
  if (!share.canDownload) return problem(res, 403, 'Forbidden', 'This link is preview-only.');

  const rows = shareableRows(share.targetId);
  const remaining = share.maxDownloads == null ? Infinity : share.maxDownloads - share.downloadCount;
  if (remaining <= 0) return problem(res, 429, 'Too Many Requests', 'This link has reached its download limit.');

  await storage.verifyAssets(rows.map((r) => r.asset));

  const files = [];
  for (const { asset } of rows) {
    if (files.length >= remaining) break;
    const status = asset.availability.status;
    if (status === 'MISSING' || status === 'TRASHED') continue;
    files.push({
      assetId: asset.assetId,
      name: storage.downloadName(asset.displayName, asset.mimeType),
      sizeBytes: asset.drive?.sizeBytes ?? 0,
      url: storage.signedUrl({
        fileId: asset.drive.fileId, filename: storage.downloadName(asset.displayName, asset.mimeType),
        mimeType: asset.mimeType, expiresIn: TTL.download, purpose: 'share', assetId: asset.assetId,
        shareId: share._id,
      }),
    });
  }

  share.downloadCount += files.length;
  if (recipient) recipient.downloadCount = Number(recipient.downloadCount ?? 0) + files.length;
  persist();
  record(
    { ip: req.ip, socketIp: req.socketIp, get: (h) => req.get(h), user: req.user ?? { sub: null, name: 'external partner', role: 'public' } },
    {
      action: 'SHARE_ACCESS', entity: 'share', entityId: share._id,
      label: `External download of ${files.length} files from ${share.targetName ?? share.assetName}`,
      after: { downloadCount: share.downloadCount },
    },
  );

  res.json({
    files,
    skipped: rows.length - files.length,
    downloadsRemaining: share.maxDownloads == null ? null : share.maxDownloads - share.downloadCount,
  });
});
