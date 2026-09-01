import { connect, disconnect } from '../db/mongo.js';
import { load, flushNow, allAssets, persist } from '../db.js';
import * as storage from '../services/storage.js';

// After a drive switch, every asset catalogued against the old account points at a
// file id that no longer resolves. Reconcile reports each one as MISSING_IN_DRIVE;
// clearing them one click at a time does not scale. This flags them in bulk.

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await connect();
  await load();
  await storage.ensureRoots();

  const { files } = await storage.inventory({ includeTrashed: true });
  const present = new Set(files.map((f) => f.id));

  const now = new Date().toISOString();
  const lost = [];

  for (const { asset, song } of allAssets()) {
    const fileId = asset.drive?.fileId;
    if (!fileId || present.has(fileId)) continue;
    if (asset.permanentlyLost) continue;
    lost.push({ assetId: asset.assetId, displayName: asset.displayName, song: song?.title ?? null });
    if (dryRun) continue;
    asset.availability = {
      status: 'MISSING',
      lastCheckedAt: now,
      lastVerifiedAt: asset.availability?.lastVerifiedAt ?? null,
      checkMethod: 'FILES_GET',
      detail: 'Marked permanently lost in bulk after a Drive account switch. Re-upload required.',
    };
    asset.permanentlyLost = true;
  }

  if (!dryRun && lost.length) {
    persist();
    await flushNow();
  }

  console.log(JSON.stringify({
    dryRun,
    driveFilesSeen: present.size,
    markedLost: lost.length,
    sample: lost.slice(0, 10),
  }, null, 2));

  await disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Bulk mark-lost failed:', err);
  process.exit(1);
});
