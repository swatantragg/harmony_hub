import { connect, disconnect } from '../db/mongo.js';
import { load, flushNow } from '../db.js';
import { importDrive } from '../services/import-drive.js';
import * as storage from '../services/storage.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await connect();
  await load();
  await storage.ensureRoots();
  const summary = await importDrive({ dryRun, userId: 'cli' });
  if (!dryRun) await flushNow();
  console.log(JSON.stringify(summary, null, 2));
  await disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Drive import failed:', err);
  process.exit(1);
});
