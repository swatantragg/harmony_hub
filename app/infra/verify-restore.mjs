// Checks that a restored catalogue is actually a catalogue.
//
// `mongorestore` exiting 0 means "the archive was read", not "the library is
// recoverable". This is the part that decides the second question: are the
// collections there, do they hold roughly what production holds, and — the one
// that matters most — does a restored row still point at a file that exists in
// Google Drive?
//
// That last check is the whole point. The library is two halves: Drive holds the
// bytes, MongoDB holds everything that makes them findable. A backup of one half
// that no longer lines up with the other is not a backup of anything.
//
// Called by scripts/verify-restore.sh, which does the restore and the cleanup.
// Run alone with --db <name> against a database already restored.

import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const here = path.dirname(new URL(import.meta.url).pathname);
for (const file of [path.resolve(here, '../.env'), path.resolve(here, '../server/.env')]) {
  if (fs.existsSync(file)) dotenv.config({ path: file });
}

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
};

// An exported-but-empty variable is not the same as an unset one: dotenv leaves
// the empty value in place, so the connection string ends up blank and the
// failure surfaces later as "invalid scheme" rather than "you forgot to set it".
const set = (name) => (process.env[name]?.trim() ? process.env[name].trim() : null);

const LIVE_URI = set('MONGODB_URI');
const LIVE_DB = set('MONGODB_DB') || 'gcloud';
const TARGET_URI = set('VERIFY_TARGET_URI') || LIVE_URI;
const SCRATCH_DB = arg('db');
const TOLERANCE = Number(set('VERIFY_TOLERANCE') || 0.10);
const SKIP_DRIVE = process.argv.includes('--no-drive');

if (!SCRATCH_DB) {
  console.error('verify-restore.mjs needs --db <restored database name>');
  process.exit(2);
}
if (!LIVE_URI) {
  console.error('MONGODB_URI is unset or empty — nothing to compare the restore against.');
  process.exit(2);
}

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

let failures = 0;
let warnings = 0;
const ok = (label, detail = '') => console.log(`  ${green('✓')} ${label}${detail ? dim(`  ${detail}`) : ''}`);
const bad = (label, detail = '') => { failures += 1; console.log(`  ${red('✕')} ${label}${detail ? `\n      ${detail}` : ''}`); };
const meh = (label, detail = '') => { warnings += 1; console.log(`  ${yellow('!')} ${label}${detail ? dim(`  ${detail}`) : ''}`); };

// A backup is always older than production, so a restored collection is
// expected to be *smaller*. What must not happen is it being empty, or having
// lost a large fraction of what production holds.
//
//   core   the library itself. A ratio check applies: these change slowly, so a
//          big shortfall means the dump lost something rather than that the
//          library grew.
//   churn  rows that accumulate fast enough that a ratio check would cry wolf
//          the morning after a busy day. Presence only.
const CORE = ['users', 'artists', 'songs', 'folders', 'unfiled', 'tags', 'customTypes'];
const CHURN = ['shares', 'activityLog', 'notifications', 'reconciliationRuns', 'dedupeIgnores', 'restoreRequests', 'meta'];

// Sessions are deliberately absent: they are short-lived, and a restore that
// brought back none of them is working exactly as intended.

const counts = async (conn, names) => {
  const out = {};
  for (const name of names) {
    out[name] = await conn.collection(name).countDocuments().catch(() => null);
  }
  return out;
};

/** Pulls one asset out of the restored catalogue, wherever it happens to live. */
async function sampleAsset(conn) {
  const [unfiled] = await conn.collection('unfiled')
    .find({ 'drive.fileId': { $exists: true, $ne: null }, deletedAt: null })
    .limit(1).toArray();
  if (unfiled) return { asset: unfiled, from: 'unfiled' };

  const [song] = await conn.collection('songs').aggregate([
    { $unwind: '$assets' },
    { $match: { 'assets.drive.fileId': { $exists: true, $ne: null }, 'assets.deletedAt': null } },
    { $limit: 1 },
  ]).toArray();
  if (song) return { asset: song.assets, from: `song “${song.title}”` };

  return null;
}

async function main() {
  console.log(`\n${bold('  Restore verification')}`);
  console.log(`  ${dim(`restored “${SCRATCH_DB}” vs live “${LIVE_DB}”`)}\n`);

  const live = mongoose.createConnection(LIVE_URI, { dbName: LIVE_DB, serverSelectionTimeoutMS: 15000 });
  const scratch = mongoose.createConnection(TARGET_URI, { dbName: SCRATCH_DB, serverSelectionTimeoutMS: 15000 });
  await Promise.all([live.asPromise(), scratch.asPromise()]);

  const names = [...CORE, ...CHURN];
  const liveCounts = await counts(live.db, names);
  const restoredCounts = await counts(scratch.db, names);

  console.log(bold('  Collections'));

  for (const name of CORE) {
    const l = liveCounts[name] ?? 0;
    const r = restoredCounts[name] ?? 0;
    const label = `${name.padEnd(18)} ${String(r).padStart(6)} restored ${dim(`/ ${l} live`)}`;

    if (l === 0 && r === 0) { ok(label, 'empty in both'); continue; }
    if (r === 0) { bad(label, 'production holds rows here and the restore holds none — the dump lost this collection'); continue; }
    if (r < l * (1 - TOLERANCE)) {
      bad(label, `short by more than ${Math.round(TOLERANCE * 100)}% — expected at least ${Math.ceil(l * (1 - TOLERANCE))}`);
      continue;
    }
    ok(label);
  }

  for (const name of CHURN) {
    const l = liveCounts[name] ?? 0;
    const r = restoredCounts[name] ?? 0;
    const label = `${name.padEnd(18)} ${String(r).padStart(6)} restored ${dim(`/ ${l} live`)}`;
    if (l > 0 && r === 0) meh(label, 'empty in the restore — check whether the dump reached it');
    else ok(label);
  }

  // The catalogue is worthless without accounts: nobody could sign in to reach
  // any of it, and there is no way to recreate a password hash.
  console.log(`\n${bold('  Must not be empty')}`);
  if ((restoredCounts.users ?? 0) === 0) bad('users', 'a restore with no accounts is a library nobody can open');
  else ok('users', `${restoredCounts.users} account(s)`);

  // ── The half that actually matters ────────────────────────────────────────
  console.log(`\n${bold('  Catalogue-to-Drive link')}`);

  if (SKIP_DRIVE) {
    meh('skipped', '--no-drive was passed');
  } else {
    const sample = await sampleAsset(scratch.db);
    if (!sample) {
      meh('no asset to sample', 'the restore holds no asset with a Drive file id');
    } else {
      const { GOOGLE_CONFIGURED } = await import('../server/src/config.js');
      if (!GOOGLE_CONFIGURED) {
        meh('skipped', 'Google Drive is not configured in this environment');
      } else {
        const { getFile, isNotFound } = await import('../server/src/storage/drive.js');
        const { asset, from } = sample;
        try {
          const file = await getFile(asset.drive.fileId, 'id,name,size,trashed');
          const detail = `“${file.name}” ${dim(`(${asset.drive.fileId})`)}`;
          if (file.trashed) {
            meh(`the sampled asset is in the Drive trash`, detail);
          } else {
            ok(`a restored row still resolves to a real Drive file`, `${detail} from ${from}`);
          }
        } catch (err) {
          if (isNotFound(err)) {
            bad(
              'a restored row points at a Drive file that no longer exists',
              `${asset.displayName ?? asset.drive.fileId} — the two halves of the library have drifted apart`,
            );
          } else {
            meh('the Drive check could not complete', err.message);
          }
        }
      }
    }
  }

  await Promise.all([live.close(), scratch.close()]);

  console.log('');
  if (failures > 0) {
    console.log(`  ${red(`${failures} failure(s)`)}, ${warnings} warning(s)\n`);
    console.log(`  ${bold('This backup would not rebuild the library.')} Do not rely on it.\n`);
    process.exit(1);
  }
  console.log(`  ${green('restore verified')} — ${warnings} warning(s)\n`);
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`\n  ${red('verification could not run')}\n\n    ${err.message}\n`);
  process.exit(2);
});
