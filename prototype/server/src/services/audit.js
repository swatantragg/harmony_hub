// AuditService — P4: every mutation is recorded with actor, before/after, and IP.
import { db, persist } from '../db.js';
import { uuid } from '../util/crypto.js';

export function record(req, { action, entity, entityId, label, before = null, after = null, meta = null }) {
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
    ip: req.ip || '127.0.0.1',
    userAgent: req.get?.('user-agent') || 'worker',
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
