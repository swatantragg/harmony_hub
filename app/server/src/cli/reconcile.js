import { connect, disconnect } from '../db/mongo.js';
import { load } from '../db.js';
import { runReconciliation } from '../services/reconcile.js';
import * as storage from '../services/storage.js';

async function main() {
  await connect();
  await load();
  await storage.ensureRoots();
  const run = await runReconciliation(
    { ip: '127.0.0.1', get: () => 'cli', user: { name: 'cli' } },
    { trigger: 'manual' },
  );
  console.log(JSON.stringify({
    objectsScanned: run.objectsScanned,
    foldersScanned: run.foldersScanned,
    assetsScanned: run.assetsScanned,
    permanentlyLost: run.permanentlyLost,
    durationMs: run.durationMs,
    counts: run.counts,
    quota: run.quota ? { percentUsed: run.quota.percentUsed, available: run.quota.available } : null,
    ok: run.ok,
  }, null, 2));
  await disconnect();
  process.exit(run.ok ? 0 : 2);
}

main().catch((err) => {
  console.error('Reconciliation failed:', err);
  process.exit(1);
});
