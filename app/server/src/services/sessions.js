// Refresh-token sessions (§12.2) — the thing that makes a stolen token stop working.
//
// The problem this solves. An access token is a signed bearer string: once minted it is
// valid until it expires, and nothing about changing a password, suspending an account or
// signing out can reach it. Making the access token short-lived fixes that, but only if
// something else keeps a person signed in — otherwise everybody is asked for a password
// every fifteen minutes and turns the TTL back up.
//
// So: a 15-minute access token in memory in the browser, and a 14-day refresh token in an
// HttpOnly cookie that only /api/auth ever sees. Four properties follow, and each is
// enforced below rather than assumed:
//
//   Rotation          every refresh mints a new token and invalidates the one presented.
//                     A refresh token is therefore good for exactly one use.
//   Reuse detection   presenting an already-rotated token means two parties hold it —
//                     the legitimate browser and somebody else. There is no way to tell
//                     which is which, so the entire family is destroyed and both are
//                     signed out. That is the correct outcome: a theft becomes a visible
//                     interruption instead of a silent tenancy.
//   Absolute cap      SESSION_MAX_SEC from first sign-in, however often it is refreshed.
//   Idle cap          SESSION_IDLE_SEC since last use.
//
// Only a SHA-256 of each token is stored. A dump of this collection is not a set of
// working sessions.
import crypto from 'node:crypto';
import { models } from '../db/models.js';
import { REFRESH_TTL_SEC, SESSION_IDLE_SEC, SESSION_MAX_SEC } from '../config.js';
import { token as randomToken, uuid } from '../util/crypto.js';

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const now = () => new Date();
const inSeconds = (sec) => new Date(Date.now() + sec * 1000);

/**
 * Opens a new session family for a successful sign-in.
 * Returns the raw refresh token — the only moment it exists outside the browser.
 */
export async function open(user, req) {
  const familyId = uuid();
  const raw = randomToken(32);
  await models.sessions.create({
    _id: uuid(),
    familyId,
    userId: user._id,
    tokenHash: hash(raw),
    createdAt: now(),
    lastUsedAt: now(),
    // The family's own deadline, carried on every record so a rotated token cannot
    // extend the session past it.
    familyExpiresAt: inSeconds(SESSION_MAX_SEC),
    expiresAt: inSeconds(REFRESH_TTL_SEC),
    rotatedAt: null,
    revokedAt: null,
    ip: req?.socketIp ?? null,
    userAgent: String(req?.get?.('user-agent') || '').slice(0, 200),
  });
  return { refreshToken: raw, familyId };
}

/**
 * Redeems a refresh token and rotates it.
 *
 * @returns {Promise<{ok: true, userId: string, refreshToken: string}
 *                  |{ok: false, reason: 'unknown'|'reuse'|'expired'|'idle'|'revoked'}>}
 */
export async function rotate(raw, req) {
  if (!raw) return { ok: false, reason: 'unknown' };
  const record = await models.sessions.findOne({ tokenHash: hash(raw) }).lean();
  if (!record) return { ok: false, reason: 'unknown' };

  // Already rotated, or explicitly revoked, and somebody is presenting it anyway. Two
  // holders, one token: destroy the family and make both sign in again.
  if (record.rotatedAt || record.revokedAt) {
    await revokeFamily(record.familyId, 'refresh-token-reuse');
    return { ok: false, reason: 'reuse', userId: record.userId };
  }

  const t = Date.now();
  if (Date.parse(record.expiresAt) < t) return { ok: false, reason: 'expired' };
  if (Date.parse(record.familyExpiresAt) < t) {
    await revokeFamily(record.familyId, 'absolute-session-cap');
    return { ok: false, reason: 'expired' };
  }
  if (t - Date.parse(record.lastUsedAt) > SESSION_IDLE_SEC * 1000) {
    await revokeFamily(record.familyId, 'idle-timeout');
    return { ok: false, reason: 'idle' };
  }

  const next = randomToken(32);
  // The presented record is marked rotated rather than deleted, because a deleted record
  // is indistinguishable from one that never existed — and that distinction is exactly
  // what makes reuse detectable.
  await models.sessions.updateOne({ _id: record._id }, { $set: { rotatedAt: now() } });
  await models.sessions.create({
    _id: uuid(),
    familyId: record.familyId,
    userId: record.userId,
    tokenHash: hash(next),
    createdAt: now(),
    lastUsedAt: now(),
    familyExpiresAt: record.familyExpiresAt,
    expiresAt: inSeconds(REFRESH_TTL_SEC),
    rotatedAt: null,
    revokedAt: null,
    ip: req?.socketIp ?? null,
    userAgent: String(req?.get?.('user-agent') || '').slice(0, 200),
  });

  return { ok: true, userId: record.userId, refreshToken: next, familyId: record.familyId };
}

export async function revokeFamily(familyId, reason = 'signed-out') {
  if (!familyId) return 0;
  const out = await models.sessions.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: now(), revokedReason: reason } },
  );
  return out.modifiedCount ?? 0;
}

export async function revokeByToken(raw, reason = 'signed-out') {
  if (!raw) return 0;
  const record = await models.sessions.findOne({ tokenHash: hash(raw) }).lean();
  return record ? revokeFamily(record.familyId, reason) : 0;
}

// "Sign out everywhere" — and the automatic consequence of a password change, a
// suspension or a role change.
export async function revokeAllForUser(userId, reason = 'session-invalidated') {
  const out = await models.sessions.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: now(), revokedReason: reason } },
  );
  return out.modifiedCount ?? 0;
}

// What the profile screen shows: one row per live family, newest first.
export async function listForUser(userId) {
  const rows = await models.sessions
    .find({ userId, revokedAt: null, rotatedAt: null })
    .sort({ lastUsedAt: -1 })
    .limit(50)
    .lean();
  return rows.map((r) => ({
    familyId: r.familyId,
    startedAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    ip: r.ip,
    userAgent: r.userAgent,
  }));
}

// Rotated and revoked records are kept briefly so reuse stays detectable after the fact,
// then swept. The TTL index handles unexpired rows; this handles the rest.
export async function sweep() {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const out = await models.sessions.deleteMany({
    $or: [{ rotatedAt: { $lt: cutoff } }, { revokedAt: { $lt: cutoff } }],
  });
  return out.deletedCount ?? 0;
}
