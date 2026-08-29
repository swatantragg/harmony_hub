import crypto from 'node:crypto';
import { models } from '../db/models.js';
import { REFRESH_TTL_SEC, SESSION_IDLE_SEC, SESSION_MAX_SEC } from '../config.js';
import { token as randomToken, uuid } from '../util/crypto.js';
import { dayKey } from './otp.js';

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const now = () => new Date();
const inSeconds = (sec) => new Date(Date.now() + sec * 1000);

/**
 * A stable handle for "this browser on this machine". Address and user agent
 * both, because either alone is too noisy to act on: a phone moves between
 * networks all day, and a whole office shares one address.
 */
export const deviceFingerprint = (req) =>
  crypto.createHash('sha256')
    .update(`${req?.socketIp ?? ''}|${String(req?.get?.('user-agent') || '')}`)
    .digest('hex')
    .slice(0, 32);

/** Has this account ever had a session from this device before? */
export async function isKnownDevice(userId, fingerprint) {
  const seen = await models.sessions.findOne({ userId, fingerprint }).select({ _id: 1 }).lean();
  return Boolean(seen);
}

export async function open(user, req, { day = dayKey() } = {}) {
  const familyId = uuid();
  const raw = randomToken(32);
  await models.sessions.create({
    _id: uuid(),
    familyId,
    userId: user._id,
    tokenHash: hash(raw),
    // The day this family was last passcode-verified. Compared against today on
    // every rotation and carried into every access token minted from it.
    dayKey: day,
    createdAt: now(),
    lastUsedAt: now(),
    familyExpiresAt: inSeconds(SESSION_MAX_SEC),
    expiresAt: inSeconds(REFRESH_TTL_SEC),
    rotatedAt: null,
    revokedAt: null,
    ip: req?.socketIp ?? null,
    fingerprint: deviceFingerprint(req),
    userAgent: String(req?.get?.('user-agent') || '').slice(0, 200),
  });
  return { refreshToken: raw, familyId, dayKey: day };
}

export async function rotate(raw, req) {
  if (!raw) return { ok: false, reason: 'unknown' };
  const record = await models.sessions.findOne({ tokenHash: hash(raw) }).lean();
  if (!record) return { ok: false, reason: 'unknown' };
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

  // The day boundary. The family is deliberately *not* revoked: it is still
  // proof that this browser held a valid session yesterday, which is what earns
  // the holder a passcode prompt tomorrow instead of a full sign-in. The token
  // it presented is spent either way, so nothing is replayable.
  if (record.dayKey && record.dayKey !== dayKey()) {
    return {
      ok: false,
      reason: 'day-expired',
      userId: record.userId,
      familyId: record.familyId,
      sessionId: record._id,
    };
  }

  const next = randomToken(32);
  await models.sessions.updateOne({ _id: record._id }, { $set: { rotatedAt: now() } });
  await models.sessions.create({
    _id: uuid(),
    familyId: record.familyId,
    userId: record.userId,
    tokenHash: hash(next),
    dayKey: record.dayKey ?? dayKey(),
    createdAt: now(),
    lastUsedAt: now(),
    familyExpiresAt: record.familyExpiresAt,
    expiresAt: inSeconds(REFRESH_TTL_SEC),
    rotatedAt: null,
    revokedAt: null,
    ip: req?.socketIp ?? null,
    fingerprint: deviceFingerprint(req),
    userAgent: String(req?.get?.('user-agent') || '').slice(0, 200),
  });
  return {
    ok: true, userId: record.userId, refreshToken: next,
    familyId: record.familyId, dayKey: record.dayKey ?? dayKey(),
  };
}

/**
 * Re-stamps a family with today after a passcode is accepted, and issues it a
 * fresh token. Used by the morning resume path, where the holder proved a day
 * key rather than a password.
 */
export async function restamp(familyId, req, { day = dayKey() } = {}) {
  const family = await models.sessions
    .findOne({ familyId, revokedAt: null })
    .sort({ createdAt: -1 })
    .lean();
  if (!family) return { ok: false, reason: 'unknown' };
  if (Date.parse(family.familyExpiresAt) < Date.now()) {
    await revokeFamily(familyId, 'absolute-session-cap');
    return { ok: false, reason: 'expired' };
  }

  // Spend everything outstanding in the family, then mint one successor. A
  // token issued before the boundary must not survive it.
  await models.sessions.updateMany(
    { familyId, rotatedAt: null, revokedAt: null },
    { $set: { rotatedAt: now() } },
  );

  const next = randomToken(32);
  await models.sessions.create({
    _id: uuid(),
    familyId,
    userId: family.userId,
    tokenHash: hash(next),
    dayKey: day,
    createdAt: now(),
    lastUsedAt: now(),
    familyExpiresAt: family.familyExpiresAt,
    expiresAt: inSeconds(REFRESH_TTL_SEC),
    rotatedAt: null,
    revokedAt: null,
    ip: req?.socketIp ?? null,
    fingerprint: deviceFingerprint(req),
    userAgent: String(req?.get?.('user-agent') || '').slice(0, 200),
  });
  return { ok: true, userId: family.userId, refreshToken: next, familyId, dayKey: day };
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

export async function revokeAllForUser(userId, reason = 'session-invalidated') {
  const out = await models.sessions.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: now(), revokedReason: reason } },
  );
  return out.modifiedCount ?? 0;
}

/** Ownership is checked here, not by the caller — this is the only place it can be got wrong. */
export async function revokeOwnFamily(userId, familyId, reason = 'revoked-by-user') {
  const row = await models.sessions.findOne({ familyId, userId }).select({ _id: 1 }).lean();
  if (!row) return { ok: false, reason: 'not-found' };
  const count = await revokeFamily(familyId, reason);
  return { ok: true, revoked: count };
}

export async function familyOwner(familyId) {
  const row = await models.sessions.findOne({ familyId }).select({ userId: 1 }).lean();
  return row?.userId ?? null;
}

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
    dayKey: r.dayKey ?? null,
    current: false,
    ip: r.ip,
    userAgent: r.userAgent,
  }));
}

/** Which family a presented refresh cookie belongs to, so the UI can say "this device". */
export async function familyOfToken(raw) {
  if (!raw) return null;
  const row = await models.sessions.findOne({ tokenHash: hash(raw) }).select({ familyId: 1 }).lean();
  return row?.familyId ?? null;
}

export async function sweep() {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const out = await models.sessions.deleteMany({
    $or: [{ rotatedAt: { $lt: cutoff } }, { revokedAt: { $lt: cutoff } }],
  });
  return out.deletedCount ?? 0;
}
