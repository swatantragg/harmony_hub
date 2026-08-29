// Sign-in throttling and the metering on mail-sending endpoints.
//
// Its own file, and nothing else may share it: exhausting a limiter is the
// point of these cases, and a limiter is process-wide. Anything that needs to
// sign in normally has to run against a different server — which, under
// `node --test`, means a different file.

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, client, start, stop } from './harness.mjs';

before(async () => {
  await start({
    env: {
      RATE_LIMIT_AUTH_MAX: '5',
      RATE_LIMIT_AUTH_IP_MAX: '8',
      RATE_LIMIT_AUTH_WINDOW_SEC: '900',
      RATE_LIMIT_MAX: '100000',
      LOGIN_MAX_FAILURES: '4',
      LOGIN_LOCKOUT_SEC: '900',
      RESET_MAX_PER_HOUR: '2',
      RATE_LIMIT_STORE: 'memory',
    },
  });
});

after(async () => { await stop(); });

describe('sign-in throttling', () => {
  test('repeated wrong passwords stop being answered', async () => {
    const c = client();
    const statuses = [];

    for (let i = 0; i < 12; i += 1) {
      const res = await c.send('/api/auth/login', {
        method: 'POST',
        body: { email: ADMIN.email, password: `wrong-attempt-number-${i}` },
      });
      statuses.push(res.status);
      if (res.status === 429) break;
    }

    assert.ok(
      statuses.includes(429),
      `an unbounded guess run must be cut off; saw ${statuses.join(',')}`,
    );
    assert.ok(statuses.indexOf(429) <= 9, 'the cut-off must arrive quickly, not eventually');
  });

  test('the correct password is refused too once the account is locked', async () => {
    const c = client();
    const res = await c.send('/api/auth/login', {
      method: 'POST', body: { email: ADMIN.email, password: ADMIN.password },
    });
    assert.equal(res.status, 429, 'a lockout is not bypassed by finally getting it right');
  });
});

describe('self-service reset throttling', () => {
  test('the reset endpoint is metered per address', async () => {
    const c = client();
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await c.send('/api/auth/forgot', {
        method: 'POST', body: { email: 'someone-else@example.test' },
      });
      statuses.push(res.status);
    }
    assert.ok(
      statuses.includes(429),
      `a mail-sending endpoint must be capped; saw ${statuses.join(',')}`,
    );
  });
});
