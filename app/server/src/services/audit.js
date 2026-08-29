import { db, persist } from '../db.js';
import { models } from '../db/models.js';
import { uuid } from '../util/crypto.js';
import { ALERT_WEBHOOK_URL, LOG_FORMAT } from '../config.js';
import { can } from '../catalogue.js';

const ALERTABLE = new Set([
  'AUTH_TOKEN_REUSE',
  'AUTH_LOCKOUT',
  'ASSET_PURGE',
  'DRIVE_TRASH_EMPTIED',
  'USER_UPDATE',
  'USER_CREATE',
  'USER_DELETE',
  'FILE_TICKET_REJECTED',
  'SHARE_PASSCODE_FROZEN',
  'AUTH_NEW_DEVICE',
]);

// ── Notification addressing ─────────────────────────────────────────────────
//
// A notification has two independent dimensions, and conflating them is how the
// old single-list behaved: every row with no `userId` went to everybody, so a
// regular account read "Deleted the account for X (their email)" and every
// lockout, purge and quarantine alert alongside it.
//
//  · `audience` — who *may* see it at all.
//      'all'      everyone signed in            (library activity)
//      'admin'    only accounts with admin:activity  (security, storage)
//      'private'  only the named `userId`
//  · `userId`  — a specific person it is also *for*. A row can be both: the
//    download notice for a share is addressed to the person who created the
//    share and, separately, visible to administrators.
//
// `category` is presentation: it drives the tabs, nothing else.

export const CATEGORIES = ['activity', 'shares', 'security', 'storage'];

export const AUDIENCES = ['all', 'admin', 'private'];

/** The one place that decides whether a person may read a notification row. */
export function visibleTo(n, user) {
  if (!user) return false;
  if (n.userId && n.userId === user.sub) return true;
  const audience = n.audience ?? (n.userId ? 'private' : 'admin');
  if (audience === 'private') return false;
  if (audience === 'all') return true;
  return can(user.role, 'admin:activity');
}

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
    socketIp,
    forwardedFor: forwarded && socketIp && !String(forwarded).includes(socketIp) ? forwarded : null,
    userAgent: String(req.get?.('user-agent') || 'worker').slice(0, 300),
    timestamp: new Date().toISOString(),
  };
  db.activityLog.unshift(entry);
  if (db.activityLog.length > 2000) db.activityLog.length = 2000;
  persist();

  // One line of JSON per mutation, on stdout, for whatever collects logs —
  // Loki, CloudWatch, journald. The Mongo copy is the queryable one; this is the
  // copy that has already left the machine by the time anybody with database
  // access could think about editing it.
  //
  // Off by default because it doubles every line in a terminal during
  // development. Turn it on wherever something is actually collecting.
  if (LOG_FORMAT === 'json') {
    console.log(JSON.stringify({
      at: entry.timestamp, kind: 'audit', action, entity, entityId,
      actor: entry.userName, role: entry.userRole, ip: entry.socketIp ?? entry.ip,
      label: entry.label,
    }));
  }

  return entry;
}

export function notify({
  userId = null, level = 'info', title, body, link = null,
  audience = null, category = 'activity', meta = null,
}) {
  const n = {
    _id: uuid(),
    userId,
    audience: audience ?? (userId ? 'private' : 'admin'),
    category: CATEGORIES.includes(category) ? category : 'activity',
    level,
    title,
    body,
    link,
    meta,
    readAt: null,
    readBy: [],
    createdAt: new Date().toISOString(),
  };
  db.notifications.unshift(n);
  if (db.notifications.length > 400) db.notifications.length = 400;
  persist();
  return n;
}

/** Fire-and-forget outbound alert. Never blocks or fails the request that raised it. */
function webhook(entry, event) {
  if (!ALERT_WEBHOOK_URL) return;
  const payload = {
    text: `[GCloud] ${event.label ?? event.action}`,
    action: event.action,
    entity: event.entity,
    entityId: event.entityId,
    actor: entry.userName,
    role: entry.userRole,
    ip: entry.socketIp ?? entry.ip,
    at: entry.timestamp,
  };
  fetch(ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => console.error('[alert] webhook failed:', err.message));
}

export function alert(req, event) {
  const entry = record(req, event);
  if (ALERTABLE.has(event.action)) {
    notify({
      audience: 'admin',
      category: event.category ?? 'security',
      level: event.level ?? 'warn',
      title: event.label ?? event.action,
      body: `${entry.userName} · ${entry.socketIp ?? entry.ip} · ${new Date(entry.timestamp).toLocaleString()}`,
      link: '/admin/activity',
    });
    webhook(entry, event);
  }
  return entry;
}

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
