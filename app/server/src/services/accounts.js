// Account reconciliation, run once at boot against whatever is already in MongoDB.
//
// Seeding only ever touches an empty database, so it cannot be what brings an existing
// library onto the two-role model or gives it a founding administrator. This can: it is
// idempotent, it runs on every start, and it makes exactly three guarantees.
//
//   1. Every account holds one of the two roles that still exist.
//   2. The founding administrator exists and is an active Admin.
//   3. Somebody is an Admin — otherwise no account in the library could create one.
import { db, persist } from '../db.js';
import { hashPassword, verifyPassword } from '../util/crypto.js';
import { FOUNDING_ADMIN, SEED_PASSWORD, isWeakPassword } from '../config.js';
import { ROLES, normaliseRole } from '../catalogue.js';

export async function ensureAccounts({ log = console.log } = {}) {
  const changes = [];

  // 1. Editor, Marketing and Viewer no longer exist. Everyone holding one becomes a User,
  //    which is what all three were in practice — none of them could purge a file, manage
  //    accounts or read the activity log, and a User still cannot.
  for (const user of db.users) {
    if (ROLES.includes(user.role)) continue;
    const next = normaliseRole(user.role);
    changes.push(`${user.email}: ${user.role} → ${next}`);
    user.role = next;
  }

  // Any account still holding the shared starting password has to replace it.
  //
  // The seeded accounts were all created with SEED_PASSWORD, and until this version that
  // value was printed on the sign-in screen for anybody to read — so it protects nothing.
  // The test is "has never set a password of its own, and the shared one still opens it",
  // rather than "this field is missing": a flag can be written once and then be wrong
  // forever, whereas this re-derives the answer from the password itself on every boot and
  // stops firing the moment somebody sets their own.
  //
  // bcrypt is ~250 ms a comparison, and only accounts with no password of their own are
  // ever tested, so this costs a second at boot for a staff-sized list and nothing after
  // everyone has been onboarded.
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

  // 1b. The founding administrator is exempt from the check above, because it is the one
  //     account born with a password of its own. That exemption used to mean it kept
  //     whatever ADMIN_PASSWORD said forever — including the shipped default, which is
  //     eight digits long and printed in a file in the repository. So the same question is
  //     asked of it, against the list of values known to be worthless: if the answer is
  //     yes, it has to set a real one at the next sign-in like everybody else.
  for (const user of db.users) {
    if (user.email.toLowerCase() !== FOUNDING_ADMIN.email) continue;
    if (user.mustChangePassword) break;
    // eslint-disable-next-line no-await-in-loop
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

  // 2. The founding administrator. Matched on email, which is the account's identity —
  //    the password is never touched if the account is already there, because by then it
  //    may well have been changed on purpose.
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

  // 3. Belt and braces. If the step above somehow left nobody able to sign in as an Admin,
  //    the library would be unadministrable and there would be no route back.
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
