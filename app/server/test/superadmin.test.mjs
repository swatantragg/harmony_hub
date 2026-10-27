// The super administrator: the founding account (ADMIN_EMAIL), which the
// harness signs in as. To every other administrator it is one more Admin — and
// none of them may delete it, change its role, suspend it or reset its
// password. Only it may reset anybody's password.

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, client, start, stop } from './harness.mjs';

const OTHER = { name: 'Second Admin', email: 'harness-second-admin@example.test', password: 'Copper-Kettle-Morning-4471!' };
const MEMBER = { name: 'Plain Member', email: 'harness-plain-member@example.test', password: 'Velvet-Harbour-Ladder-2290!' };

let owner;
let ownerId;
let otherId;
let memberId;

/** Signs in a created account, replacing the starting password it must change. */
async function signInAs(person) {
  const c = client();
  await c.send('/api/auth/providers');
  const first = await c.send('/api/auth/login', { method: 'POST', body: { email: person.email, password: person.password } });
  const done = await c.send('/api/auth/otp', {
    method: 'POST', body: { otpToken: first.body.otpToken, code: first.body.devCode },
  });
  c.token = done.body.accessToken;
  if (done.body.user?.mustChangePassword) {
    const next = `${person.password}-own`;
    const set = await c.send('/api/auth/password', {
      method: 'POST', body: { currentPassword: person.password, newPassword: next },
    });
    c.token = set.body.accessToken;
    person.password = next;
  }
  return c;
}

before(async () => {
  await start();
  owner = client();
  assert.equal((await owner.signIn()).status, 200);
  ownerId = (await owner.send('/api/me')).body._id;

  const made = await owner.send('/api/admin/users', { method: 'POST', body: { ...OTHER, role: 'Admin' } });
  assert.equal(made.status, 201);
  otherId = made.body._id;
  const member = await owner.send('/api/admin/users', { method: 'POST', body: { ...MEMBER, role: 'User' } });
  assert.equal(member.status, 201);
  memberId = member.body._id;
});

after(async () => { await stop(); });

describe('who knows about the super administrator', () => {
  test('it is told, on its own profile and its own row', async () => {
    assert.equal((await owner.send('/api/me')).body.superAdmin, true);
    const list = await owner.send('/api/admin/users');
    assert.equal(list.body.canResetPasswords, true);
    const rows = list.body.data.filter((u) => u.superAdmin);
    assert.deepEqual(rows.map((u) => u.email), [ADMIN.email], 'one super administrator, and it is the founding account');
  });

  test('another administrator sees one more Admin, and nothing else', async () => {
    const other = await signInAs(OTHER);
    const me = await other.send('/api/me');
    assert.equal(me.body.superAdmin, undefined);

    const list = await other.send('/api/admin/users');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.find((u) => u._id === ownerId).role, 'Admin');
    assert.ok(!JSON.stringify(list.body).includes('superAdmin'), 'no row is marked');
    assert.equal(list.body.canResetPasswords, false);
    assert.deepEqual(list.body.roles, ['Admin', 'User'], 'the only roles there are');

    const activity = await other.send('/api/admin/activity');
    assert.ok(!/super/i.test(JSON.stringify(activity.body)), 'the activity log does not give it away');
  });
});

describe('what another administrator cannot do to it', () => {
  test('cannot change its role or suspend it', async () => {
    const other = await signInAs(OTHER);
    for (const body of [{ role: 'User' }, { status: 'suspended' }]) {
      const res = await other.send(`/api/admin/users/${ownerId}`, { method: 'PATCH', body });
      assert.equal(res.status, 403, JSON.stringify(body));
      assert.ok(!/super/i.test(res.body.detail), 'refused like any other permission, without naming it');
    }
    const me = await owner.send('/api/me');
    assert.equal(me.body.role, 'Admin');
    assert.equal(me.body.status, 'active');
  });

  test('cannot delete it, even after confirming their own password', async () => {
    const other = await signInAs(OTHER);
    const res = await other.send(`/api/admin/users/${ownerId}`, {
      method: 'DELETE', body: { confirmPassword: OTHER.password },
    });
    assert.equal(res.status, 403);
    assert.equal((await owner.send('/api/me')).status, 200, 'the account is still there');
  });

  test('cannot reset anybody’s password — its own or a member’s', async () => {
    const other = await signInAs(OTHER);
    for (const id of [ownerId, memberId]) {
      const res = await other.send(`/api/admin/users/${id}/reset-password`, {
        method: 'POST', body: { password: 'Taken-Over-Account-9931!', confirmPassword: OTHER.password },
      });
      assert.equal(res.status, 403);
    }
  });

  test('can still manage ordinary accounts', async () => {
    const other = await signInAs(OTHER);
    const res = await other.send(`/api/admin/users/${memberId}`, { method: 'PATCH', body: { status: 'suspended' } });
    assert.equal(res.status, 200);
    await other.send(`/api/admin/users/${memberId}`, { method: 'PATCH', body: { status: 'active' } });
  });
});

describe('what the super administrator can do', () => {
  test('resets another administrator’s password, ending their sessions', async () => {
    const other = await signInAs(OTHER);
    const fresh = 'Granite-Lighthouse-Shelf-6602!';
    const res = await owner.send(`/api/admin/users/${otherId}/reset-password`, {
      method: 'POST', body: { password: fresh, confirmPassword: ADMIN.password },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.mustChangePassword, true);
    assert.equal((await other.send('/api/me')).status, 401, 'their open session was ended');

    OTHER.password = fresh;
    const again = await signInAs(OTHER);
    assert.equal((await again.send('/api/me')).status, 200, 'the new password works');
  });

  test('cannot step down, suspend or delete itself', async () => {
    for (const body of [{ role: 'User' }, { status: 'suspended' }]) {
      const res = await owner.send(`/api/admin/users/${ownerId}`, { method: 'PATCH', body });
      assert.equal(res.status, 409, JSON.stringify(body));
    }
    const del = await owner.send(`/api/admin/users/${ownerId}`, { method: 'DELETE', body: { confirmPassword: ADMIN.password } });
    assert.equal(del.status, 409);
  });
});
