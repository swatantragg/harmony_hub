// AuditService — P4: every mutation is recorded with actor, before/after, and address.
//
// Two addresses are kept, not one. req.ip is derived from X-Forwarded-For according to
// the trust-proxy setting: correct for rate limiting behind a known proxy, and worthless
// as evidence, because a header is something the client writes. The socket address cannot
// be forged by the client, so it is recorded alongside — and when the two disagree, the
// row says so. An audit trail that can be authored by the party under investigation is
// not an audit trail.
import { db, persist } from '../db.js';
import { models } from '../db/models.js';
import { uuid } from '../util/crypto.js';

// Actions that are worth waking somebody for. Each raises a notification as well as a row,
// because a log nobody reads is a log that reports a breach three weeks late.
const ALERTABLE = new Set([
  'AUTH_TOKEN_REUSE',
  'AUTH_LOCKOUT',
  'ASSET_PURGE',
  'DRIVE_TRASH_EMPTIED',
  'USER_UPDATE',
  'USER_CREATE',
  'USER_DELETE',
  'FILE_TICKET_REJECTED',
]);

export function record(req, { action, entity, entityId, label, before = null, after = null, meta = null }) {
  const forwarded = req.forwardedFor ?? (req.get?.('x-forwarded-for') || null);
  const socketIp = req.socketIp ?? null;
  const entry = {
    _id: uuid(),
    userId: req.user?.sub ?? null,
    userName: req.user?.name ?? 'system',
    userRole: req.user?.role ?? 'system',
    action,
    entity,
    entityId,
    label: label ?? entityId,
    before,
    after,
    meta,
    ip: req.ip || socketIp || '127.0.0.1',
    // The unforgeable one, and the header it disagreed with when it did.
    socketIp,
    forwardedFor: forwarded && socketIp && !String(forwarded).includes(socketIp) ? forwarded : null,
    userAgent: String(req.get?.('user-agent') || 'worker').slice(0, 300),
    timestamp: new Date().toISOString(),
  };
  db.activityLog.unshift(entry);
  if (db.activityLog.length > 2000) db.activityLog.length = 2000;
  persist();
  return entry;
}

export function notify({ userId = null, level = 'info', title, body, link = null }) {
  const n = {
    _id: uuid(),
    userId,
    level,
    title,
    body,
    link,
    readAt: null,
    createdAt: new Date().toISOString(),
  };
  db.notifications.unshift(n);
  if (db.notifications.length > 200) db.notifications.length = 200;
  persist();
  return n;
}

// A security-relevant event: recorded, and surfaced to administrators rather than left in
// a log for somebody to find later.
export function alert(req, event) {
  const entry = record(req, event);
  if (ALERTABLE.has(event.action)) {
    notify({
      level: event.level ?? 'warn',
      title: event.label ?? event.action,
      body: `${entry.userName} · ${entry.socketIp ?? entry.ip} · ${new Date(entry.timestamp).toLocaleString()}`,
      link: '/admin/activity',
    });
  }
  return entry;
}

// Retention (§12.6). Rows older than the window are deleted from MongoDB outright — the
// in-memory tail is display only and shrinks on its own.
export async function sweepAudit(days) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const out = await models.activityLog.deleteMany({ timestamp: { $lt: cutoff } });
  const removed = out.deletedCount ?? 0;
  if (removed) {
    const kept = db.activityLog.filter((e) => e.timestamp >= cutoff);
    db.activityLog.length = 0;
    db.activityLog.push(...kept);
  }
  return removed;
}
