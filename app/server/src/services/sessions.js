import crypto from 'node:crypto';
import { models } from '../db/models.js';
import { REFRESH_TTL_SEC, SESSION_IDLE_SEC, SESSION_MAX_SEC } from '../config.js';
import { token as randomToken, uuid } from '../util/crypto.js';

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const now = () => new Date();
const inSeconds = (sec) => new Date(Date.now() + sec * 1000);

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
    familyExpiresAt: inSeconds(SESSION_MAX_SEC),
    expiresAt: inSeconds(REFRESH_TTL_SEC),
    rotatedAt: null,
    revokedAt: null,
    ip: req?.socketIp ?? null,
    userAgent: String(req?.get?.('user-agent') || '').slice(0, 200),
  });
  return { refreshToken: raw, familyId };
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
  const next = randomToken(32);
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

export async function revokeAllForUser(userId, reason = 'session-invalidated') {
  const out = await models.sessions.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: now(), revokedReason: reason } },
  );
  return out.modifiedCount ?? 0;
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
    ip: r.ip,
    userAgent: r.userAgent,
  }));
}
export async function sweep() {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const out = await models.sessions.deleteMany({
    $or: [{ rotatedAt: { $lt: cutoff } }, { revokedAt: { $lt: cutoff } }],
  });
  return out.deletedCount ?? 0;
}