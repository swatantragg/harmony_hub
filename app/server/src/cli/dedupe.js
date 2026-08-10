// Find duplicates from the command line (§10.12).
//
//   npm run dedupe                     every tier, human-readable
//   npm run dedupe -- --level exact    only byte-identical files
//   npm run dedupe -- --family Video   only video
//   npm run dedupe -- --json           machine-readable, for piping somewhere
//
// Read-only. Nothing is trashed, linked or changed — resolving a group is a decision, and
// decisions are made in the UI where the files can be compared side by side.
import { connect, disconnect } from '../db/mongo.js';
import { load } from '../db.js';
import { scan } from '../services/dedupe.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};

const gb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

const KIND_LABEL = {
  IDENTICAL: 'Identical bytes',
  PERCEPTUAL: 'Visually the same',
  SAME_MEDIA: 'Same media, re-encoded',
  SAME_NAME: 'Same name, different file',
};

async function main() {
  await connect();
  await load();

  const report = scan({
    level: arg('level', 'all'),
    family: arg('family'),
    minSizeBytes: Number(arg('min-size', 0)) || 0,
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    await disconnect();
    process.exit(0);
  }

  console.log(`\nScanned ${report.assetsScanned} files in ${report.durationMs}ms.\n`);

  if (!report.groups.length) {
    console.log('No duplicates found.\n');
    await disconnect();
    process.exit(0);
  }

  for (const group of report.groups) {
    const label = KIND_LABEL[group.kind] ?? group.kind;
    console.log(`\x1b[1m${label}\x1b[0m  ·  ${group.count} files  ·  ${gb(group.reclaimableBytes)} recoverable`
      + `${group.spansFolders ? `  ·  across ${group.folders.length} folders` : ''}`);
    console.log(`\x1b[2m  ${group.reason}\x1b[0m`);
    for (const m of group.members) {
      const keep = m.assetId === group.suggestedKeepId ? '\x1b[32mkeep\x1b[0m' : '    ';
      console.log(`  ${keep}  ${m.displayName}`);
      console.log(`        \x1b[2m${gb(m.sizeBytes)} · ${m.folderName ?? 'library root'}${m.songTitle ? ` · ${m.songTitle}` : ''}${m.durationSec ? ` · ${m.durationSec}s` : ''}\x1b[0m`);
    }
    console.log('');
  }

  console.log('─'.repeat(60));
  console.log(`${report.totals.groups} groups · ${report.totals.files} files`);
  console.log(`\x1b[1m${gb(report.totals.certainReclaimableBytes)}\x1b[0m recoverable with certainty (identical bytes)`);
  if (report.totals.potentialReclaimableBytes > report.totals.certainReclaimableBytes) {
    console.log(`${gb(report.totals.potentialReclaimableBytes)} if the uncertain groups turn out to be duplicates too`);
  }
  if (report.totals.crossFolderGroups) {
    console.log(`${report.totals.crossFolderGroups} groups span more than one folder — the same file filed twice`);
  }
  if (!report.perceptualEnabled) {
    console.log('\n\x1b[2mPerceptual matching is off. It finds the same footage at different resolutions,\x1b[0m');
    console.log('\x1b[2mwhich no checksum can. Set DEDUPE_PERCEPTUAL=true and build the hashes from\x1b[0m');
    console.log('\x1b[2mthe De-duplication screen (needs ffmpeg).\x1b[0m');
  }
  console.log('\nResolve these at /dedupe in the app, where the files can be compared first.\n');

  await disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Duplicate scan failed:', err);
  process.exit(1);
});
