// Prepares a Google Drive for Harmony Hub, and proves it works (§6.1).
//
//   node infra/bootstrap-drive.mjs          show what it would do, change nothing
//   node infra/bootstrap-drive.mjs --apply  create the folder tree
//   node infra/bootstrap-drive.mjs --check  run a full write/read/delete round trip
//
// There is very little to set up: Drive needs no globally unique name reserved, no
// public-access switch turned off, no access policy written, no versioning enabled
// (revisions are always on) and no CORS rule (Google mirrors the request Origin into each
// upload session itself). What is left is a folder tree and a straight answer about
// whether the credentials actually work.
//
// It is idempotent: run it twice and the second run finds what the first one made.
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

const here = path.dirname(new URL(import.meta.url).pathname);
for (const file of [path.resolve(here, '../.env'), path.resolve(here, '../server/.env')]) {
  if (fs.existsSync(file)) dotenv.config({ path: file });
}

// The server's own modules, so this script and the running app can never disagree about
// what "the Harmony Hub folder" means.
const { GOOGLE, GOOGLE_CONFIGURED, DRIVE_ID, DRIVE_ROOT_FOLDER_NAME, ROOTS } =
  await import('../server/src/config.js');
const storage = await import('../server/src/services/storage.js');
const drive = await import('../server/src/storage/drive.js');

const APPLY = process.argv.includes('--apply');
const CHECK = process.argv.includes('--check');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const ok = (label, detail = '') => console.log(`  ${green('✓')} ${label}${detail ? dim(`  ${detail}`) : ''}`);
const bad = (label, detail = '') => console.log(`  ${red('✕')} ${label}${detail ? `\n      ${detail}` : ''}`);
const gb = (n) => (n == null ? 'unlimited' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(0)} MB`);

let failures = 0;

async function step(label, fn) {
  try {
    const detail = await fn();
    ok(label, detail || '');
    return true;
  } catch (err) {
    failures += 1;
    bad(label, err.message);
    return false;
  }
}

console.log(`\n${bold('Harmony Hub — Google Drive bootstrap')}`);
console.log(dim(APPLY ? 'apply mode — changes will be made' : CHECK ? 'check mode — a temporary file will be written and deleted' : 'dry run — nothing will be changed\n'));

// ── 1. Credentials ──────────────────────────────────────────────────────────
console.log(bold('\nCredentials'));

if (!GOOGLE_CONFIGURED) {
  bad(
    `GOOGLE_AUTH_MODE=${GOOGLE.mode} is missing its settings`,
    GOOGLE.mode === 'oauth'
      ? 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.\n      Run `npm run drive:auth` to obtain them.'
      : 'Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY,\n      or GOOGLE_SERVICE_ACCOUNT_KEY_FILE pointing at the downloaded JSON.',
  );
  console.log('');
  process.exit(1);
}

ok(`auth mode  ${GOOGLE.mode}`, GOOGLE.mode === 'oauth' ? GOOGLE.clientId : GOOGLE.serviceAccountEmail);

const authed = await step('access token', async () => {
  await drive.accessToken({ force: true });
  return 'Google accepted the credential';
});
if (!authed) {
  console.log(`\n${yellow('Nothing further can be checked until the credential works.')}`);
  console.log(dim('  npm run drive:auth   mints a fresh refresh token\n'));
  process.exit(1);
}

let quota = null;
await step('account', async () => {
  quota = await storage.quota();
  return quota.account ? `${quota.account.email}` : 'no user profile (service account)';
});

// ── 2. Storage ──────────────────────────────────────────────────────────────
console.log(bold('\nStorage'));

if (quota) {
  if (quota.unlimited) {
    ok('space', 'unlimited — pooled Shared Drive storage');
  } else {
    const tight = quota.percentUsed >= 85;
    (tight ? bad : ok)(
      `space  ${gb(quota.usage)} of ${gb(quota.limit)} used (${quota.percentUsed}%)`,
      tight ? `Only ${gb(quota.available)} free. Uploads fail when this reaches zero.` : `${gb(quota.available)} free`,
    );
    if (tight) failures += 1;
    if (quota.usageInTrash > 0) {
      console.log(dim(`      ${gb(quota.usageInTrash)} of that is trashed files, which still count against quota`));
    }
    if (quota.usageElsewhere > 0) {
      console.log(dim(`      ${gb(quota.usageElsewhere)} is Gmail and Google Photos, which share the same allowance`));
    }
  }
  if (quota.maxUploadSize) ok('max single file', gb(quota.maxUploadSize));
}

if (DRIVE_ID) {
  await step(`shared drive  ${DRIVE_ID}`, async () => {
    const d = await drive.getDrive(DRIVE_ID);
    if (!d.capabilities?.canAddChildren) throw new Error(`The account cannot add files to "${d.name}". Add it as a Content manager or Manager.`);
    return d.name;
  });
} else if (GOOGLE.mode === 'service_account' && !GOOGLE.subject) {
  bad(
    'service account with no Shared Drive',
    'A service account has no Drive storage of its own — uploads will fail with\n'
    + '      storageQuotaExceeded. Either set DRIVE_ID to a Shared Drive the service\n'
    + '      account is a member of, or set GOOGLE_IMPERSONATE_SUBJECT to a Workspace\n'
    + '      user and enable domain-wide delegation. GOOGLE_AUTH_MODE=oauth avoids both.',
  );
  failures += 1;
} else {
  ok('drive', 'My Drive');
}

// ── 3. Folder tree ──────────────────────────────────────────────────────────
console.log(bold('\nFolders'));

if (!APPLY && !CHECK) {
  console.log(dim(`      Would find or create "${DRIVE_ROOT_FOLDER_NAME}" and four folders inside it:`));
  console.log(dim('        Assets · Quarantine · Backups · Logs'));
  console.log(dim('\n      Re-run with --apply to create them.\n'));
  process.exit(failures ? 1 : 0);
}

let folders;
const built = await step('folder tree', async () => {
  folders = await storage.ensureRoots();
  return folders.root.id;
});
if (!built) process.exit(1);

for (const [role, folder] of Object.entries(folders)) {
  if (role === 'root') continue;
  console.log(`      ${dim(role.padEnd(11))} ${folder.name.padEnd(12)} ${dim(folder.id)}`);
}

// ── 4. Round trip ───────────────────────────────────────────────────────────
// The only check that actually proves the thing works. Everything above can pass while
// the app still cannot upload — a read-only scope, a Shared Drive with the account as a
// Viewer, a full quota. This writes a real file, reads it back, renames it, moves it and
// deletes it, in the same code paths the product uses.
if (CHECK) {
  console.log(bold('\nRound trip'));
  const body = Buffer.from(`Harmony Hub connectivity check — ${new Date().toISOString()}\n`, 'utf8');
  let file = null;

  const wrote = await step('write a file', async () => {
    file = await storage.putFile({
      name: `harmonyhub-check-${Date.now()}.txt`,
      parentId: ROOTS.assets,
      mimeType: 'text/plain',
      body,
      appProperties: { app: 'harmonyhub', check: 'connectivity' },
    });
    return `${file.sizeBytes} bytes`;
  });

  if (wrote) {
    await step('checksums returned by Drive', async () => {
      if (!file.sha256 && !file.md5) {
        throw new Error('Drive returned no checksum. Exact de-duplication will fall back to size and name comparison.');
      }
      return file.sha256 ? `sha256 ${file.sha256.slice(0, 16)}…` : `md5 ${file.md5.slice(0, 16)}…`;
    });

    await step('read it back', async () => {
      const res = await drive.downloadResponse(file.fileId);
      const text = Buffer.from(await res.arrayBuffer());
      if (!text.equals(body)) throw new Error('The bytes that came back are not the bytes that went in.');
      return `${text.length} bytes, identical`;
    });

    await step('range request', async () => {
      const res = await drive.downloadResponse(file.fileId, { range: 'bytes=0-9' });
      if (res.status !== 206) throw new Error('Drive did not honour a Range request — video scrubbing will not work.');
      return 'HTTP 206, so media seeking works';
    });

    await step('rename', async () => {
      const renamed = await storage.rename(file.fileId, 'harmonyhub-check-renamed.txt');
      return `${renamed.name} — same file id, no bytes copied`;
    });

    await step('move between folders', async () => {
      await storage.move(file.fileId, { toParentId: ROOTS.quarantine, fromParentId: ROOTS.assets });
      await storage.move(file.fileId, { toParentId: ROOTS.assets, fromParentId: ROOTS.quarantine });
      return 'Assets → Quarantine → Assets';
    });

    await step('open a resumable upload session', async () => {
      const session = await storage.beginUpload({
        name: 'harmonyhub-check-session.bin',
        parentId: ROOTS.assets,
        mimeType: 'application/octet-stream',
        sizeBytes: 1024,
        origin: process.env.APP_ORIGIN || 'http://localhost:8101',
      });
      await storage.abortUpload(session.sessionUri);
      return 'browser-direct uploads will work';
    });

    await step('delete permanently', async () => {
      await storage.destroy(file.fileId);
      return 'cleaned up, no quota consumed';
    });
  }
}

console.log('');
if (failures) {
  console.log(`${red(`${failures} problem${failures === 1 ? '' : 's'} found.`)} Fix the items marked ✕ above, then run this again.\n`);
  process.exit(1);
}
console.log(`${green('Google Drive is ready.')}`);
if (folders?.root?.webViewLink) console.log(dim(`Open the library folder: ${folders.root.webViewLink}`));
console.log(dim(`\nPin the root folder so it never has to be searched for again:\n  DRIVE_ROOT_FOLDER_ID=${folders?.root?.id ?? ''}\n`));
