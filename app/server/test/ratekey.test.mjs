// Rate-limit keying.
//
// The bug this exists for: the global limiter's key generator read `req.user`,
// but it was mounted before anything that populates it, so the value was always
// undefined and every request fell back to the address. One office behind one
// NAT therefore shared a single budget between everybody in it, and the only
// symptom was colleagues throttling each other.

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, start, stop } from './harness.mjs';

// Low enough that address-keying would certainly trip; high enough that
// per-account keying comfortably will not.
const CEILING = 25;

before(async () => {
  await start({
    env: {
      RATE_LIMIT_MAX: String(CEILING),
      RATE_LIMIT_WINDOW_SEC: '900',
      RATE_LIMIT_STORE: 'memory',
      RATE_LIMIT_AUTH_MAX: '100000',
      RATE_LIMIT_AUTH_IP_MAX: '100000',
    },
  });
});

after(async () => { await stop(); });

describe('two accounts, one address', () => {
  test('one account spending its budget does not spend another’s', async () => {
    const a = client();
    assert.equal((await a.signIn()).status, 200);

    // Create a second account and sign it in from the same address.
    const email = `harness-second-${Date.now()}@example.test`;
    const password = 'Amber-Quill-Meadow-3391!';
    const made = await a.send('/api/admin/users', {
      method: 'POST', body: { name: 'Second Person', email, role: 'User', password },
    });
    assert.equal(made.status, 201);

    const b = client();
    await b.send('/api/auth/providers');
    const start1 = await b.send('/api/auth/login', { method: 'POST', body: { email, password } });
    const done = await b.send('/api/auth/otp', {
      method: 'POST', body: { otpToken: start1.body.otpToken, code: start1.body.devCode },
    });
    b.token = done.body.accessToken;

    // Spend most of one account's budget.
    for (let i = 0; i < CEILING - 2; i += 1) await a.send('/api/me');

    // The other account, from the same address, must still be served.
    const res = await b.send('/api/me');
    assert.notEqual(
      res.status, 429,
      'a second account behind the same address inherited the first one’s consumption',
    );
    assert.ok(res.status === 200 || res.status === 403, `unexpected ${res.status}`);
  });
});
