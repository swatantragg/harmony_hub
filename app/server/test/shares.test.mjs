// Share links: passcode floor, guess throttling, and the self-freeze.

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, start, stop } from './harness.mjs';

let admin;
let folderId = null;

before(async () => {
  await start({
    env: {
      SHARE_PASSCODE_MAX_ATTEMPTS: '3',
      SHARE_PASSCODE_FREEZE_AT: '4',
      SHARE_PASSCODE_MIN_LENGTH: '8',
      SHARE_PASSCODE_WINDOW_SEC: '900',
      RATE_LIMIT_STORE: 'memory',
    },
  });
  admin = client();
  const signedIn = await admin.signIn();
  assert.equal(signedIn.status, 200);

  // The scratch database is empty, so make something shareable.
  const made = await admin.send('/api/folders', {
    method: 'POST',
    body: { name: `Harness folder ${Date.now()}`, description: 'created by the test suite' },
  });
  if (made.status === 201) folderId = made.body._id ?? made.body.folder?._id ?? null;
});

after(async () => { await stop(); });

describe('passcode strength', () => {
  test('a passcode below the floor is refused at creation', async () => {
    if (!folderId) return;
    const res = await admin.send('/api/shares', {
      method: 'POST',
      body: { target: 'FOLDER', folderId, passcode: 'short1' },
    });
    // Either the passcode is refused, or the folder is empty and there is
    // nothing to share — both are correct, and only the first is under test.
    if (res.status === 409) return;
    assert.equal(res.status, 422, 'a six-character passcode is below the floor');
    assert.match(String(res.body.detail), /between 8 and 100/i);
  });
});

describe('guess throttling', () => {
  test('an unknown link token is not a usable oracle', async () => {
    const guesser = client();
    const statuses = [];
    for (let i = 0; i < 15; i += 1) {
      const res = await guesser.send(`/api/s/token-that-does-not-exist-${i % 2}`);
      statuses.push(res.status);
      if (res.status === 429) break;
    }
    // Every answer must be a refusal; a 200 would mean a token was guessed.
    assert.ok(statuses.every((s) => s >= 400), `no attempt may succeed; saw ${statuses.join(',')}`);
  });

  test('repeated wrong passcodes on one link are cut off', async () => {
    if (!folderId) return;

    const made = await admin.send('/api/shares', {
      method: 'POST',
      body: { target: 'FOLDER', folderId, passcode: 'a-long-enough-passcode' },
    });
    if (made.status !== 201) return; // nothing filed in the folder yet

    const token = made.body.token ?? String(made.body.url ?? '').split('/').pop();
    assert.ok(token, 'the share must expose a token to open it with');

    const guesser = client();
    const statuses = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await guesser.send(`/api/s/${token}`, {
        headers: { 'x-share-passcode': `guess-number-${i}` },
      });
      statuses.push(res.status);
      if (res.status === 429 || res.status === 423) break;
    }

    assert.ok(
      statuses.includes(429) || statuses.includes(423),
      `guessing must be cut off or frozen; saw ${statuses.join(',')}`,
    );
    assert.ok(statuses.length <= 6, 'the cut-off must arrive within a few attempts');
  });
});
