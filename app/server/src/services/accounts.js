import { db, persist } from '../db.js';
import { hashPassword, verifyPassword } from '../util/crypto.js';
import { FOUNDING_ADMIN, SEED_PASSWORD, isWeakPassword } from '../config.js';
import { ROLES, normaliseRole } from '../catalogue.js';

/**
 * The super administrator: the founding account, ADMIN_EMAIL. There is exactly
 * one, because it is an address in the configuration rather than a role anybody
 * can be given — and an account's email cannot be changed, so no other account
 * can become it.
 *
 * Its stored role is plain Admin, so to every other administrator it is one more
 * Admin: the people list, the activity log and its exports all say so. Only it
 * is told otherwise (`superAdmin` on its own profile). What sets it apart is
 * enforced in routes/admin.js: nobody else may delete it, change its role,
 * suspend it or reset its password, and only it may reset anybody's password.
 * ensureAccounts below recreates and re-promotes it at every boot regardless.
 */
export const isSuperAdmin = (user) =>
  typeof user?.email === 'string' && user.email.toLowerCase() === FOUNDING_ADMIN.email;

export async function ensureAccounts({ log = console.log } = {}) {
  const changes = [];

  for (const user of db.users) {
    if (ROLES.includes(user.role)) continue;
    const next = normaliseRole(user.role);
    changes.push(`${user.email}: ${user.role} → ${next}`);
    user.role = next;
  }

  for (const user of db.users) {
    if (user.email.toLowerCase() === FOUNDING_ADMIN.email) continue;
    if (user.passwordChangedAt) {
      user.mustChangePassword = Boolean(user.mustChangePassword);
      continue;
    }
    const stillHandover = await verifyPassword(SEED_PASSWORD, user.passwordHash);
    if (stillHandover && !user.mustChangePassword) {
      changes.push(`${user.email}: must replace the shared starting password`);
    }
    user.mustChangePassword = stillHandover || Boolean(user.mustChangePassword);
  }

  for (const user of db.users) {
    if (user.email.toLowerCase() !== FOUNDING_ADMIN.email) continue;
    if (user.mustChangePassword) break;
    const weak = await Promise.all(
      ['12345678', 'changeme123', 'password', 'admin123', 'harmonyhub', 'password123']
        .filter(isWeakPassword)
        .map((candidate) => verifyPassword(candidate, user.passwordHash)),
    );
    if (weak.some(Boolean)) {
      user.mustChangePassword = true;
      changes.push(`${user.email}: administrator password is a known default — must be replaced at next sign-in`);
    }
    break;
  }

  const existing = db.users.find((u) => u.email.toLowerCase() === FOUNDING_ADMIN.email);
  if (existing) {
    if (normaliseRole(existing.role) !== 'Admin') {
      existing.role = 'Admin';
      changes.push(`${existing.email}: promoted to Admin`);
    }
    if (existing.status !== 'active') {
      existing.status = 'active';
      changes.push(`${existing.email}: reactivated`);
    }
  } else {
    db.users.unshift({
      _id: 'user_admin',
      name: FOUNDING_ADMIN.name,
      email: FOUNDING_ADMIN.email,
      passwordHash: await hashPassword(FOUNDING_ADMIN.password),
      role: 'Admin',
      status: 'active',
      mustChangePassword: false,
      passwordChangedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    });
    changes.push(`${FOUNDING_ADMIN.email}: administrator account created`);
  }

  if (!db.users.some((u) => normaliseRole(u.role) === 'Admin' && u.status === 'active')) {
    const first = db.users[0];
    if (first) {
      first.role = 'Admin';
      first.status = 'active';
      changes.push(`${first.email}: promoted — the library had no active administrator`);
    }
  }

  if (changes.length) {
    persist();
    log(`  Accounts     ${changes.length} adjusted`);
    for (const line of changes) log(`               · ${line}`);
  }

  return changes;
}
