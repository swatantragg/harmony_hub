// Mint a Google Drive refresh token, without leaving the terminal.
//
//   node infra/drive-auth.mjs
//
// Why this exists: a refresh token is the one credential you cannot copy out of the Google
// Cloud console. It is only ever handed over at the end of a consent flow, exactly once,
// and every guide on the internet tells you to paste a code into a form. This script runs
// the whole flow locally — it starts a one-request server on 127.0.0.1, opens the consent
// screen, catches the redirect, exchanges the code, and prints the three lines that go in
// app/.env.
//
// Nothing is sent anywhere except Google. The client secret never leaves this machine.
import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

const here = path.dirname(new URL(import.meta.url).pathname);
for (const file of [path.resolve(here, '../.env'), path.resolve(here, '../server/.env')]) {
  if (fs.existsSync(file)) dotenv.config({ path: file });
}

// Must match one of the "Authorized redirect URIs" on the OAuth client in Google Cloud.
// Google treats http://localhost as a special case and allows it for desktop-style flows.
const PORT = 8107;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive';

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n${bold('GCloud — Google Drive authorisation')}\n`);
  console.log('Before running this you need an OAuth client. In the Google Cloud console:');
  console.log(`  1. ${dim('console.cloud.google.com')} → create or pick a project`);
  console.log('  2. APIs & Services → Library → enable "Google Drive API"');
  console.log('  3. APIs & Services → OAuth consent screen → External → add yourself');
  console.log(`     under ${bold('Test users')} (this matters — see the note at the end)`);
  console.log('  4. APIs & Services → Credentials → Create credentials → OAuth client ID');
  console.log('     Application type: Web application');
  console.log(`     Authorized redirect URI: ${bold(REDIRECT)}\n`);

  const clientId = process.env.GOOGLE_CLIENT_ID
    || (await rl.question('Client ID: ')).trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
    || (await rl.question('Client secret: ')).trim();

  if (!clientId || !clientSecret) {
    console.error('\nBoth are required. Nothing was changed.\n');
    process.exit(1);
  }

  // CSRF protection on the redirect. Cheap, and the flow is over a loopback socket any
  // other process on this machine could also talk to.
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    // Without both of these Google returns an access token and no refresh token, and the
    // whole exercise has to be repeated an hour later. `prompt=consent` is what forces a
    // refresh token even on a re-authorisation.
    access_type: 'offline',
    prompt: 'consent',
    state,
  })}`;

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }

      const error = url.searchParams.get('error');
      const returned = url.searchParams.get('code');

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>GCloud</title>
<body style="font:16px/1.6 system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#0f1020;color:#fff">
<div style="text-align:center;max-width:32rem;padding:2rem">
  <div style="font-size:2.5rem">${error ? '✕' : '✓'}</div>
  <h1 style="font-size:1.25rem;margin:.5rem 0">${error ? 'Authorisation refused' : 'GCloud is connected'}</h1>
  <p style="opacity:.7">${error ? `Google said: ${error}` : 'Close this tab and go back to your terminal.'}</p>
</div></body>`);

      server.close();
      if (error) reject(new Error(`Google refused: ${error}`));
      else if (url.searchParams.get('state') !== state) reject(new Error('State mismatch — the redirect did not come from the request this script made.'));
      else resolve(returned);
    });

    server.on('error', (err) => reject(
      err.code === 'EADDRINUSE'
        ? new Error(`Port ${PORT} is already in use. Free it and run this again.`)
        : err,
    ));

    server.listen(PORT, '127.0.0.1', () => {
      console.log(`\n${bold('Opening your browser to sign in…')}`);
      console.log(dim('If it does not open, paste this into a browser yourself:\n'));
      console.log(`  ${authUrl}\n`);
      openBrowser(authUrl);
      console.log(dim(`Waiting for the redirect on ${REDIRECT} …`));
    });
  });

  rl.close();

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }).toString(),
  });

  const payload = await res.json();
  if (!res.ok || !payload.refresh_token) {
    console.error(`\n${yellow('Google returned no refresh token.')}`);
    console.error(payload.error_description || payload.error || JSON.stringify(payload));
    console.error('\nThe usual cause: this account has already authorised this client, so Google');
    console.error('reissued only an access token. Revoke it at myaccount.google.com/permissions');
    console.error('and run this again.\n');
    process.exit(1);
  }

  // Whose Drive did we just connect to? Answering it here prevents the classic mistake of
  // authorising a personal account and wondering why the team cannot see anything.
  const who = await fetch('https://www.googleapis.com/drive/v3/about?fields=user,storageQuota', {
    headers: { authorization: `Bearer ${payload.access_token}` },
  }).then((r) => r.json()).catch(() => null);

  const gb = (n) => (n == null ? 'unlimited' : `${(Number(n) / 1024 ** 3).toFixed(1)} GB`);

  console.log(`\n${green('Connected.')}`);
  if (who?.user) console.log(`  Account   ${who.user.emailAddress}`);
  if (who?.storageQuota) {
    console.log(`  Storage   ${gb(who.storageQuota.usage)} used of ${gb(who.storageQuota.limit)}`);
  }

  console.log(`\n${bold('Put these three lines in app/.env:')}\n`);
  console.log(`GOOGLE_AUTH_MODE=oauth`);
  console.log(`GOOGLE_CLIENT_ID=${clientId}`);
  console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
  console.log(`GOOGLE_REFRESH_TOKEN=${payload.refresh_token}\n`);

  console.log(dim('Then:  npm run bootstrap:drive   — creates the folder tree and prints its id'));
  console.log(dim('       npm run drive:check       — proves upload, download and delete all work\n'));

  console.log(`${yellow('One thing that will bite you if nobody says it:')}`);
  console.log('while the OAuth consent screen is in "Testing" mode, Google expires refresh');
  console.log('tokens after 7 days. That is fine for trying this out. Before anyone relies on');
  console.log('it, click "Publish app" on the consent screen — the token then lasts until it');
  console.log('is revoked or goes six months unused. No re-verification is needed for an app');
  console.log('only your own accounts sign in to.\n');
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
