// Run reconciliation once, from the command line (§10.11).
//
// The API runs this on a schedule; this entry point exists so it can also be a one-off
// ECS task, a cron job on a jump box, or something you run by hand after an incident.
import { connect, disconnect } from '../db/mongo.js';
import { load } from '../db.js';
import { runReconciliation } from '../services/reconcile.js';
import * as storage from '../services/storage.js';

async function main() {
  await connect();
  await load();
  // The folder ids have to be resolved before the walk knows where to start.
  await storage.ensureRoots();
  const run = await runReconciliation(
    { ip: '127.0.0.1', get: () => 'cli', user: { name: 'cli' } },
    { trigger: 'manual' },
  );
  console.log(JSON.stringify({
    objectsScanned: run.objectsScanned,
    foldersScanned: run.foldersScanned,
    assetsScanned: run.assetsScanned,
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
