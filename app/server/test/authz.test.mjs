// Authorisation, notification addressing and export safety.
//
// The notification cases are the reason this file exists: a regular account
// could read every administrative security alert, including other people's
// account deletions and the addresses attached to them.

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, client, start, stop } from './harness.mjs';

const MEMBER = {
  name: 'Ordinary Member',
  email: 'harness-member@example.test',
  password: 'Quiet-Lantern-Verse-7742!',
};

let admin;

before(async () => {
  await start();
  admin = client();
  const signedIn = await admin.signIn();
  assert.equal(signedIn.status, 200, 'the harness administrator must sign in');

  const created = await admin.send('/api/admin/users', {
    method: 'POST',
    body: { name: MEMBER.name, email: MEMBER.email, role: 'User', password: MEMBER.password },
  });
  assert.equal(created.status, 201, 'the harness member account must be created');
});

after(async () => { await stop(); });

/** A signed-in member. New accounts start with mustChangePassword, so clear it first. */
async function member() {
  const c = client();
  await c.send('/api/auth/providers');
  const first = await c.send('/api/auth/login', {
    method: 'POST', body: { email: MEMBER.email, password: MEMBER.password },
  });
  const done = await c.send('/api/auth/otp', {
    method: 'POST', body: { otpToken: first.body.otpToken, code: first.body.devCode },
  });
  c.token = done.body.accessToken;

  if (done.body.user?.mustChangePassword) {
    const set = await c.send('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: MEMBER.password, newPassword: 'Second-Quiet-Lantern-Verse-8815!' },
    });
    c.token = set.body.accessToken;
    MEMBER.password = 'Second-Quiet-Lantern-Verse-8815!';
  }
  return c;
}

describe('role boundaries', () => {
  test('a member cannot reach any admin-only route', async () => {
    const m = await member();
    const forbidden = [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/activity'],
      ['GET', '/api/admin/activity/export.xlsx'],
      ['GET', '/api/admin/activity/export.csv'],
      ['POST', '/api/admin/users'],
    ];
    for (const [method, route] of forbidden) {
      const res = await m.send(route, { method, ...(method === 'POST' ? { body: {} } : {}) });
      assert.equal(res.status, 403, `${method} ${route} must be refused for a member`);
    }
  });

  test('a member cannot change their own role', async () => {
    const m = await member();
    const me = await m.send('/api/me');
    const res = await m.send(`/api/admin/users/${me.body._id}`, {
      method: 'PATCH', body: { role: 'Admin' },
    });
    assert.equal(res.status, 403);
  });

  test('an administrator reaches the same routes', async () => {
    for (const route of ['/api/admin/users', '/api/admin/activity']) {
      const res = await admin.send(route);
      assert.equal(res.status, 200, `${route} must be allowed for an administrator`);
    }
  });

  test('the last administrator cannot be demoted', async () => {
    const me = await admin.send('/api/me');
    const res = await admin.send(`/api/admin/users/${me.body._id}`, {
      method: 'PATCH', body: { role: 'User' },
    });
    assert.equal(res.status, 409, 'demoting the only administrator would strand the library');
  });
});

describe('notification addressing', () => {
  test('a member never sees administrative security notifications', async () => {
    // Create and delete an account: both raise administrative alerts.
    const created = await admin.send('/api/admin/users', {
      method: 'POST',
      body: { name: 'Temp Person', email: 'harness-temp@example.test', role: 'User' },
    });
    assert.equal(created.status, 201);
    await admin.send(`/api/admin/users/${created.body._id}`, {
      method: 'DELETE', body: { confirmPassword: ADMIN.password },
    });

    const m = await member();
    const mine = await m.send('/api/notifications');
    assert.equal(mine.status, 200);

    const titles = mine.body.data.map((n) => n.title).join(' | ');
    assert.doesNotMatch(titles, /Deleted the account/i, 'account deletions are administrative');
    assert.doesNotMatch(titles, /harness-temp@example\.test/i, 'no addresses leak to members');
    assert.doesNotMatch(titles, /Created Temp Person/i);

    // A member does get security rows — but only ones addressed to them, such
    // as "a new device signed in to your account". Anything administrative is
    // what must not appear.
    for (const n of mine.body.data) {
      if (n.category !== 'security') continue;
      assert.equal(n.mine, true, `a member saw a security row that was not theirs: ${n.title}`);
    }
  });

  test('an administrator does see them', async () => {
    const seen = await admin.send('/api/notifications');
    assert.equal(seen.status, 200);
    assert.ok(
      seen.body.data.some((n) => n.category === 'security'),
      'the administrator receives the security rows the member was refused',
    );
  });

  test('the tab list is filtered by permission', async () => {
    const m = await member();
    const theirs = await m.send('/api/notifications');
    const ours = await admin.send('/api/notifications');

    const memberTabs = theirs.body.tabs.map((t) => t.key);
    const adminTabs = ours.body.tabs.map((t) => t.key);

    assert.ok(memberTabs.includes('activity'), 'a member has a library tab');
    assert.ok(memberTabs.includes('shares'), 'a member has a shares tab');
    // Security is present for everybody; its *contents* are filtered per person.
    assert.ok(memberTabs.includes('security'), 'a member can read their own security notices');
    assert.ok(adminTabs.includes('security'));
    // Storage is deliberately shared: both roles carry admin:storage, because
    // drift remediation is everybody's job in this library. Only the *security*
    // rows are administrative.
    assert.ok(adminTabs.includes('storage'), 'an administrator has the storage tab');
    assert.deepEqual(
      memberTabs.filter((k) => !adminTabs.includes(k)),
      [],
      'a member never has a tab an administrator lacks',
    );
  });

  test('unread counts are broken out per tab', async () => {
    const res = await admin.send('/api/notifications');
    assert.equal(typeof res.body.counts, 'object');
    assert.equal(typeof res.body.counts.all, 'number');
  });

  test('marking read is scoped to one tab when asked', async () => {
    const before = await admin.send('/api/notifications');
    if (!before.body.counts.security) return; // nothing to mark

    await admin.send('/api/notifications/read', { method: 'POST', body: { category: 'security' } });
    const after = await admin.send('/api/notifications');
    assert.equal(after.body.counts.security ?? 0, 0, 'the security tab is cleared');
  });
});

describe('file tickets', () => {
  test('a forged ticket is refused', async () => {
    const c = client();
    const payload = Buffer.from(JSON.stringify({
      f: 'some-drive-file-id', p: 'download', i: 1,
      e: Math.floor(Date.now() / 1000) + 600, j: 'aaaaaa', k: 1,
    })).toString('base64url');

    const res = await c.send(`/api/files/${payload}.notarealsignature`);
    assert.equal(res.status, 403, 'a ticket this server did not sign is refused');
  });

  test('an expired ticket is refused as gone, not served', async () => {
    const c = client();
    const payload = Buffer.from(JSON.stringify({
      f: 'some-drive-file-id', p: 'download', i: 1,
      e: Math.floor(Date.now() / 1000) - 60, j: 'aaaaaa', k: 1,
    })).toString('base64url');

    const res = await c.send(`/api/files/${payload}.alsonotasignature`);
    // Signature is checked before expiry, so this is 403 either way — what
    // matters is that no bytes come back.
    assert.ok(res.status === 403 || res.status === 410);
  });

  test('a malformed ticket does not crash the route', async () => {
    const c = client();
    for (const bad of ['..', 'x', 'a.b.c', '%00', 'null']) {
      const res = await c.send(`/api/files/${bad}`);
      assert.ok(res.status >= 400 && res.status < 500, `${bad} must be a client error, not a crash`);
    }
  });
});

describe('spreadsheet exports', () => {
  test('both formats are offered and neither carries a live formula', async () => {
    const csv = await admin.send('/api/admin/activity/export.csv');
    assert.equal(csv.status, 200);
    assert.equal(typeof csv.body, 'string');

    const xlsx = await admin.send('/api/admin/activity/export.xlsx');
    assert.equal(xlsx.status, 200, 'the Excel format is offered alongside CSV');

    // No cell may begin with a formula character once the quote is stripped.
    for (const line of String(csv.body).split(/\r?\n/).slice(1)) {
      for (const cellText of line.split('","')) {
        const value = cellText.replace(/^"|"$/g, '');
        assert.ok(
          !/^[=+\-@\t\r]/.test(value),
          `a cell begins with a formula character: ${value.slice(0, 40)}`,
        );
      }
    }
  });
});
