// Authentication and session regressions.
//
// Each case here corresponds to something that was either broken or absent, so
// a failure means a specific protection has come back off.

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, client, start, stop } from './harness.mjs';

before(async () => { await start(); });
after(async () => { await stop(); });

describe('the front door', () => {
  test('a correct password alone does not produce a session', async () => {
    const c = client();
    await c.send('/api/auth/providers');
    const res = await c.send('/api/auth/login', {
      method: 'POST',
      body: { email: ADMIN.email, password: ADMIN.password },
    });

    assert.equal(res.status, 202, 'password step should be accepted but incomplete');
    assert.equal(res.body.otpRequired, true);
    assert.ok(res.body.otpToken, 'a ticket for the passcode step');
    assert.equal(res.body.accessToken, undefined, 'no access token before the passcode');
    assert.match(res.body.sentTo, /•/, 'the address it went to is masked');
  });

  test('a wrong password is refused without issuing a passcode', async () => {
    const c = client();
    const res = await c.send('/api/auth/login', {
      method: 'POST',
      body: { email: ADMIN.email, password: 'not-the-password-at-all' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.otpToken, undefined);
  });

  test('an unknown address is refused in the same words as a wrong password', async () => {
    const c = client();
    const unknown = await c.send('/api/auth/login', {
      method: 'POST', body: { email: 'nobody@example.test', password: 'whatever-it-is' },
    });
    const wrong = await c.send('/api/auth/login', {
      method: 'POST', body: { email: ADMIN.email, password: 'whatever-it-is' },
    });
    assert.equal(unknown.status, wrong.status);
    assert.equal(unknown.body.detail, wrong.body.detail, 'no account-existence oracle');
  });

  test('the passcode completes the sign-in and stamps the day', async () => {
    const c = client();
    const res = await c.signIn();
    assert.equal(res.status, 200);
    assert.ok(res.body.accessToken);
    assert.ok(res.body.session?.dayKey, 'the session carries the day it was verified for');
    assert.ok(res.body.session?.validUntil);
  });

  test('a wrong passcode is refused and burns an attempt', async () => {
    const c = client();
    await c.send('/api/auth/providers');
    const first = await c.send('/api/auth/login', {
      method: 'POST', body: { email: ADMIN.email, password: ADMIN.password },
    });
    const bad = await c.send('/api/auth/otp', {
      method: 'POST', body: { otpToken: first.body.otpToken, code: '000000' },
    });
    assert.equal(bad.status, 401);
    assert.ok(bad.body.attemptsLeft < 5, 'an attempt was consumed');
  });

  test('a passcode cannot be used twice', async () => {
    const c = client();
    await c.send('/api/auth/providers');
    const first = await c.send('/api/auth/login', {
      method: 'POST', body: { email: ADMIN.email, password: ADMIN.password },
    });
    const ok = await c.send('/api/auth/otp', {
      method: 'POST', body: { otpToken: first.body.otpToken, code: first.body.devCode },
    });
    assert.equal(ok.status, 200);

    const replay = await c.send('/api/auth/otp', {
      method: 'POST', body: { otpToken: first.body.otpToken, code: first.body.devCode },
    });
    assert.equal(replay.status, 401, 'a spent passcode is refused');
  });

  test('a forged passcode ticket is refused', async () => {
    const c = client();
    const res = await c.send('/api/auth/otp', {
      method: 'POST', body: { otpToken: 'eyJ1IjoidXNlcl9hZG1pbiJ9.notasignature', code: '123456' },
    });
    assert.equal(res.status, 401);
  });
});

describe('access tokens', () => {
  test('an unsigned request reaches nothing', async () => {
    const c = client();
    for (const route of ['/api/me', '/api/assets/catalogue', '/api/folders', '/api/admin/users']) {
      const res = await c.send(route);
      assert.equal(res.status, 401, `${route} must require authentication`);
    }
  });

  test('a token signed with the wrong key is refused', async () => {
    const c = client();
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({
        sub: 'user_admin', role: 'Admin', tv: 0,
        exp: Math.floor(Date.now() / 1000) + 3600, iss: 'gcloud', aud: 'gcloud-api',
      })).toString('base64url'),
      'this-is-not-a-valid-signature',
    ].join('.');

    const res = await c.send('/api/me', { token: forged });
    assert.equal(res.status, 401);
  });

  test('the alg=none downgrade is refused', async () => {
    const c = client();
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${
      Buffer.from(JSON.stringify({
        sub: 'user_admin', role: 'Admin', tv: 0,
        exp: Math.floor(Date.now() / 1000) + 3600, iss: 'gcloud', aud: 'gcloud-api',
      })).toString('base64url')}.`;
    const res = await c.send('/api/me', { token: none });
    assert.equal(res.status, 401);
  });

  test('a token stamped with yesterday is refused', async () => {
    const c = client();
    await c.signIn();

    // Same secret the harness gave the server, so the only thing wrong with
    // this token is its day stamp.
    const { default: jwt } = await import('jsonwebtoken');
    const stale = jwt.sign(
      { sub: 'user_admin', role: 'Admin', name: 'Harness Admin', tv: 0, dk: '2000-01-01' },
      'hRnEsS-0nly-k3y-mAterial-l0ng-enough-0123456789',
      { algorithm: 'HS256', expiresIn: 900, issuer: 'gcloud', audience: 'gcloud-api' },
    );
    const res = await c.send('/api/me', { token: stale });
    assert.equal(res.status, 401);
    assert.equal(res.body.otpRequired, true, 'the client is told to ask for a passcode');
  });
});

describe('sessions', () => {
  test('a session can be listed and ended on its own', async () => {
    const c = client();
    await c.signIn();

    const listed = await c.send('/api/me/sessions');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.length >= 1);
    assert.ok(listed.body.data.some((s) => s.current), 'the current session is identified');

    const target = listed.body.data[0].familyId;
    const killed = await c.send(`/api/me/sessions/${target}`, { method: 'DELETE' });
    assert.equal(killed.status, 200);
    assert.equal(killed.body.ok, true);
  });

  test("one account cannot end another account's session", async () => {
    const c = client();
    await c.signIn();
    const res = await c.send('/api/me/sessions/00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    assert.equal(res.status, 404, 'a session that is not yours is simply not found');
  });

  test('a spent refresh token is refused, and its whole family with it', async () => {
    const c = client();
    await c.signIn();

    // Keep a copy of the token before it is rotated away.
    const spent = c.jar.get('gcloud.rt');
    const csrf = c.jar.get('gcloud.csrf');

    const rotated = await c.send('/api/auth/refresh', { method: 'POST' });
    assert.equal(rotated.status, 200, 'the first rotation works');
    assert.notEqual(c.jar.get('gcloud.rt'), spent, 'the cookie was replaced');

    const replay = await c.send('/api/auth/refresh', {
      method: 'POST',
      headers: { cookie: `gcloud.rt=${spent}; gcloud.csrf=${csrf}`, 'x-csrf-token': csrf },
    });
    assert.equal(replay.status, 401, 'the spent token is refused');

    // Reuse is treated as theft: the successor is revoked too, so the thief and
    // the victim both lose the session rather than the thief keeping it.
    const after = await c.send('/api/auth/refresh', { method: 'POST' });
    assert.equal(after.status, 401, 'the whole family was revoked');
  });
});

describe('cross-site request forgery', () => {
  test('refresh without the token header is refused', async () => {
    const c = client();
    await c.signIn();
    const res = await c.send('/api/auth/refresh', {
      method: 'POST',
      headers: { 'x-csrf-token': '' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.csrf, true);
  });

  test('refresh with a mismatched token is refused', async () => {
    const c = client();
    await c.signIn();
    const res = await c.send('/api/auth/refresh', {
      method: 'POST',
      headers: { 'x-csrf-token': 'a-token-that-is-not-the-cookie' },
    });
    assert.equal(res.status, 403);
  });

  test('sign-in itself does not require a token, or nobody could ever get one', async () => {
    const c = client();
    const res = await c.send('/api/auth/login', {
      method: 'POST', body: { email: ADMIN.email, password: 'wrong-on-purpose' },
    });
    assert.equal(res.status, 401, 'refused for the password, not for CSRF');
  });
});

describe('self-service password reset', () => {
  test('an unknown address answers exactly like a known one', async () => {
    const c = client();
    const known = await c.send('/api/auth/forgot', { method: 'POST', body: { email: ADMIN.email } });
    const unknown = await c.send('/api/auth/forgot', { method: 'POST', body: { email: 'nobody@example.test' } });

    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.equal(known.body.message, unknown.body.message, 'no membership oracle');
  });

  test('a reset needs the emailed code', async () => {
    const c = client();
    const asked = await c.send('/api/auth/forgot', { method: 'POST', body: { email: ADMIN.email } });
    const res = await c.send('/api/auth/reset', {
      method: 'POST',
      body: { resetToken: asked.body.resetToken, code: '000000', newPassword: 'a-brand-new-Passw0rd!' },
    });
    assert.equal(res.status, 401);
  });

  test('a weak replacement password is refused even with a valid code', async () => {
    const c = client();
    const asked = await c.send('/api/auth/forgot', { method: 'POST', body: { email: ADMIN.email } });
    const res = await c.send('/api/auth/reset', {
      method: 'POST',
      body: { resetToken: asked.body.resetToken, code: asked.body.devCode, newPassword: 'short' },
    });
    assert.equal(res.status, 422);
  });
});
