// Re-seed the library from the command line.
//
//   npm run seed            fills an empty library, refuses to touch one that has data
//   npm run seed -- --force wipes MongoDB and every file under the Drive's Harmony Hub
//                           folder
//
// The force path is destructive on purpose and says so before it runs.
import { connect, disconnect } from '../db/mongo.js';
import { ensureIndexes } from '../db/models.js';
import { isEmpty, load } from '../db.js';
import { seed } from '../seed.js';
import { MONGODB_DB } from '../config.js';
import * as storage from '../services/storage.js';

const force = process.argv.includes('--force');

async function main() {
  await connect();
  await ensureIndexes();
  await load();

  const folders = await storage.ensureRoots();

  if (!isEmpty() && !force) {
    console.error(
      '\nThis library already has documents. Re-run with --force to wipe MongoDB and'
      + `\nevery file under “${folders.root.name}” in the connected Google Drive.\n`,
    );
    process.exit(1);
  }

  if (force) {
    const { files, folders: subfolders } = await storage.inventory({ includeTrashed: true });
    console.log(
      `\nThis wipes the ${MONGODB_DB} database and permanently deletes ${files.length} files`
      + `\nand ${subfolders.length} folders under “${folders.root.name}” in Google Drive.`
      + `\n${folders.root.webViewLink ?? ''}`
      + '\n\nDeletion is permanent — these do not go to the trash, so the space is freed'
      + '\nimmediately and nothing is recoverable. Starting in 5 seconds — Ctrl-C to stop.\n',
    );
    await new Promise((r) => { setTimeout(r, 5000); });
  }

  // seed() clears the library folder itself, so MongoDB and the Drive can never end up
  // describing two different libraries.
  const stats = await seed();
  console.log('\nSeeded Harmony Hub:', stats);
  const quota = await storage.quota().catch(() => null);
  if (quota && !quota.unlimited) {
    const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;
    console.log(`Drive now at ${quota.percentUsed}% — ${gb(quota.usage)} of ${gb(quota.limit)} used.`);
  }
  await disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('\nSeed failed:\n', err);
  process.exit(1);
});
