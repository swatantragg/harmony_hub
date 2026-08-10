// Seeds a realistic library: 5 artists, 12 songs, ~120 assets, with REAL files written
// into Google Drive — plus deliberate drift so Storage Health has something true to
// report, and deliberate duplicates so the de-duplication screen does too.
//
// Every file here is a genuine, openable one. That matters: preview, waveform scrubbing,
// Range streaming, checksum drift detection, de-duplication by checksum and the
// in-browser OOXML reader all run against real bytes rather than a mock. Because Drive
// computes sha256 and md5 on arrival, the seeded duplicates are detected by exactly the
// same mechanism a real duplicate would be — nothing about the demo is faked.
//
// Total upload is a few megabytes, so this is safe to run against a personal 15 GB Drive.
import { db, flushNow, reset, writeMeta } from './db.js';
import { ROOTS, SEED_PASSWORD } from './config.js';
import { hashPassword, uuid, token } from './util/crypto.js';
import { TYPE_INDEX, familyOf, CONTROLLED_TAGS } from './catalogue.js';
import * as storage from './services/storage.js';
import { mapLimit, properties } from './storage/drive.js';
import {
  coverSvg, wav, lyricsDoc, videoPlaceholder,
  pdfDoc, xlsxDoc, docxDoc, csvDoc,
} from './util/media.js';
import { runReconciliation } from './services/reconcile.js';

const iso = (daysAgo, hour = 10) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/T\d\d/, `T${String(hour).padStart(2, '0')}`);

const pick = (arr, n) => arr.slice(0, n);

// Uploads run under a concurrency cap rather than one at a time: 120 sequential round
// trips to Google is a minute of waiting for no reason. Kept modest because Drive's
// enforces a per-user request ceiling.
const PUT_CONCURRENCY = 6;

const USERS = [
  ['Aarti Deshmukh', 'admin@harmonyhub.app', 'Admin', 'Head of Digital Ops'],
  ['Rohan Iyer', 'editor@harmonyhub.app', 'Editor', 'Content Editor'],
  ['Neha Kapoor', 'marketing@harmonyhub.app', 'Marketing', 'Marketing Lead'],
  ['Sameer Joshi', 'viewer@harmonyhub.app', 'Viewer', 'A&R Analyst'],
];

const ARTISTS = [
  ['Raju Singh', 'Punjabi', 'Northlight Records', 'Chandigarh'],
  ['Meera Nair', 'Indie Pop', 'Northlight Records', 'Kochi'],
  ['The Sundown Collective', 'Alt Rock', 'Basement Tapes', 'Mumbai'],
  ['Kabir Rao', 'Hip Hop', 'Northlight Records', 'Delhi'],
  ['Ananya Bose', 'Classical Fusion', 'Raag House', 'Kolkata'],
];

const SONGS = [
  ['Dil Se', 0, 'Hindi', 'Romantic', 'INH252600141', 42],
  ['Chandni Raat', 0, 'Punjabi', 'Festive', 'INH252600142', 118],
  ['Long Way Home', 1, 'English', 'Acoustic', 'INE252600211', 27],
  ['Kaanch Ke Sapne', 1, 'Hindi', 'Sad', 'INH252600212', 96],
  ['Neon Monsoon', 2, 'English', 'Party', 'INE252600301', 61],
  ['Static Bloom', 2, 'English', 'Motivational', 'INE252600302', 145],
  ['Sheher Ka Shor', 3, 'Hindi', 'Motivational', 'INH252600401', 33],
  ['Roshni', 3, 'Hindi', 'Romantic', 'INH252600402', 208],
  ['Bhor', 4, 'Bengali', 'Devotional', 'INB252600501', 74],
  ['Raag Prayog', 4, 'Bengali', 'Devotional', 'INB252600502', 260],
  ['Saanjh', 0, 'Punjabi', 'Sad', 'INH252600143', 12],
  ['Aaj Ki Raat', 3, 'Hindi', 'Party', 'INH252600403', 5],
];

// Which asset types a song gets, and how the file is generated.
const RECIPE = [
  { type: 'Song Cover', ext: '.svg', mime: 'image/svg+xml', tags: ['Promo'] },
  { type: 'Master Audio', ext: '.wav', mime: 'audio/wav', tags: ['Master'], version: 'Final Master' },
  { type: 'Audio Snippet', ext: '.wav', mime: 'audio/wav', tags: ['Promo', 'Viral'] },
  { type: 'Reel - BTS/MV', ext: '.mp4', mime: 'video/mp4', tags: ['Reel', 'BTS', 'Viral'], version: 'V2' },
  { type: 'Lyrics', ext: '.txt', mime: 'text/plain', tags: [] },
  { type: 'Banner Image', ext: '.svg', mime: 'image/svg+xml', tags: ['Promo'] },
  { type: 'Horizontal Video', ext: '.mp4', mime: 'video/mp4', tags: ['Promo', 'Teaser'] },
  { type: 'Credits / Metadata Sheet', ext: '.pdf', mime: 'application/pdf', tags: [] },
  { type: 'Demo / Scratch', ext: '.wav', mime: 'audio/wav', tags: ['Demo'], version: 'V1' },
  { type: 'BTS - Unedited Footage', ext: '.mp4', mime: 'video/mp4', tags: ['BTS'] },
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function makeBody({ recipe, song, artist }) {
  switch (recipe.type) {
    case 'Song Cover':
      return coverSvg({ title: song.title, subtitle: artist.name, seed: song._id, width: 1200, height: 1200 });
    case 'Banner Image':
      return coverSvg({ title: song.title, subtitle: `${artist.name} · out now`, seed: `b${song._id}`, width: 1920, height: 1080 });
    case 'Master Audio':
      return wav({ seconds: 10, seed: `m${song._id}` });
    case 'Audio Snippet':
      return wav({ seconds: 4, seed: `s${song._id}` });
    case 'Demo / Scratch':
      return wav({ seconds: 5, seed: `d${song._id}` });
    case 'Lyrics':
      return lyricsDoc({ title: song.title, artist: artist.name });
    case 'Credits / Metadata Sheet':
      // A real PDF, so the preview panel opens a genuine document rather than a stand-in.
      return pdfDoc({
        title: `Credits — ${song.title}`,
        subtitle: `${artist.name} · ISRC ${song.isrc}`,
        lines: [
          '# Personnel',
          `Primary artist    ${artist.name}`,
          'Producer          A. Mehra',
          'Mix engineer      S. Kulkarni',
          'Master engineer   R. D’Souza',
          '',
          '# Release',
          `Language          ${song.language}`,
          `Mood              ${song.mood}`,
          'Label             Northlight Records',
          '',
          'Generated by Harmony Hub for the seeded demo library.',
        ],
      });
    default:
      return videoPlaceholder({ seed: `${recipe.type}${song._id}`, sizeKb: recipe.type.startsWith('BTS') ? 320 : 128 });
  }
}

// Bodies for the loose, song-less files — one real file per format the preview supports.
function unfiledBody({ displayName, mime }) {
  if (mime.startsWith('audio')) return wav({ seconds: 8, seed: displayName });
  if (mime === 'image/svg+xml') {
    return coverSvg({ title: 'Northlight', subtitle: 'Records', seed: displayName, width: 900, height: 900 });
  }
  if (mime === 'text/csv') {
    return csvDoc({
      rows: [
        ['Platform', 'Territory', 'Delivered', 'Live', 'Notes'],
        ['Spotify', 'IN', 'yes', 'yes', 'Editorial pitch sent'],
        ['Apple Music', 'IN', 'yes', 'yes', ''],
        ['YouTube Music', 'IN', 'yes', 'no', 'Art track processing'],
        ['JioSaavn', 'IN', 'yes', 'yes', ''],
        ['Apple Music', 'IN', 'no', 'no', 'Awaiting artwork approval'],
        ['Gaana', 'IN', 'yes', 'yes', ''],
      ],
    });
  }
  if (mime.endsWith('spreadsheetml.sheet')) {
    return xlsxDoc({
      sheetName: 'Q1 2026',
      rows: [
        ['Song', 'Platform', 'Streams', 'Rate (₹)', 'Gross (₹)', 'Artist split'],
        ['Dil Se', 'Spotify', 1284300, 0.18, 231174, '50%'],
        ['Dil Se', 'Apple Music', 402118, 0.42, 168889, '50%'],
        ['Chandni Raat', 'Spotify', 887204, 0.18, 159697, '45%'],
        ['Chandni Raat', 'JioSaavn', 1902441, 0.06, 114146, '45%'],
        ['Neon Monsoon', 'YouTube Music', 2213908, 0.03, 66417, '60%'],
        ['Roshni', 'Spotify', 512776, 0.18, 92300, '50%'],
        ['', '', '', 'Total', 832623, ''],
      ],
    });
  }
  if (mime.endsWith('wordprocessingml.document')) {
    return docxDoc({
      paragraphs: [
        '# Dil Se — launch plan',
        'Owner: Neha Kapoor · Marketing Lead. Reviewed weekly until release + 14 days.',
        '# Week −2',
        'Lock artwork and hand the master to distribution. Press kit out to tier-one publications.',
        '# Week −1',
        'Teaser reel on all social channels. Playlist pitches submitted with the editorial one-pager.',
        '# Release week',
        'Reel series daily. BTS cut on Thursday. Radio servicing Friday morning.',
        '# Week +2',
        'Pull performance by platform, decide on a second wave of paid support.',
      ],
    });
  }
  return pdfDoc({
    title: displayName.replace(/\.[^.]+$/, '').replace(/_/g, ' '),
    subtitle: 'Northlight Records',
    lines: [
      '# Summary',
      'This document is stored as its own file in Google Drive and is',
      'served to the preview panel through a short-lived signed URL.',
      '',
      '# Notes',
      'Renaming this file renames it in Google Drive too — the file id never changes.',
      'Sharing it issues a token, never a Drive address.',
    ],
  });
}

// ── Deferred uploads ────────────────────────────────────────────────────────
// An asset document is built with the size it will have, and the Drive file id, checksums
// and revision are patched in once Google has confirmed the write. That keeps the seed
// readable, lets every upload fly concurrently, and — because the parent folder is
// resolved at write time rather than at stage time — lets the folder tree be created
// after the assets that live in it have already been described.
function uploader() {
  const queue = [];
  const stage = ({ asset, body, contentType, appProperties }) => {
    queue.push({ asset, body, contentType, appProperties });
    return { sizeBytes: body.length };
  };
  const run = async (label, log) => {
    if (!queue.length) return 0;
    const jobs = queue.splice(0, queue.length);
    let done = 0;
    await mapLimit(jobs, PUT_CONCURRENCY, async (job) => {
      const folder = job.asset.folderId ? db.folders.find((f) => f._id === job.asset.folderId) : null;
      const drive = await storage.putFile({
        name: job.asset.displayName,
        parentId: folder?.driveFolderId || ROOTS.assets,
        mimeType: job.contentType,
        body: job.body,
        appProperties: job.appProperties,
      });
      Object.assign(job.asset.drive, drive, {
        path: `${folder?.name ? `${folder.name}/` : ''}${job.asset.displayName}`,
        uploadedAt: job.asset.drive.uploadedAt,
      });
      // The checksum the catalogue records is Drive's own, which is what makes the
      // duplicate scan authoritative rather than advisory.
      job.asset.checksumSHA256 = drive.sha256;
      done += 1;
    });
    if (log) log(`  ${label}: ${done} files written to Google Drive`);
    return done;
  };
  return { stage, run };
}

// Everything the previous library left in the Drive. Seeding wipes MongoDB, so the
// matching files have to go too — otherwise the next reconciliation correctly reports
// every one of them as UNTRACKED_IN_DRIVE, and a re-seed quietly doubles the space used.
//
// files.delete rather than trash, deliberately: a trashed file still occupies quota, and
// a re-seed that silently consumed another few megabytes of a 15 GB Drive every time
// would be a nasty surprise.
async function clearLibraryFolder(log) {
  const { files, folders } = await storage.inventory({ includeTrashed: true });
  const doomed = [...files, ...folders];
  if (!doomed.length) return 0;
  log(`  Clearing ${doomed.length} files and folders left by the previous library…`);
  await mapLimit(doomed, PUT_CONCURRENCY, (f) => storage.destroy(f.id).catch(() => null));
  return doomed.length;
}

export async function seed({ log = console.log } = {}) {
  log('Seeding Harmony Hub…');
  await storage.ensureRoots();
  await clearLibraryFolder(log);
  await reset();

  const put = uploader();
  // Every seeded account shares one password, so one bcrypt hash is computed rather than
  // four. Real accounts created through Admin → Users each get their own.
  const passwordHash = await hashPassword(SEED_PASSWORD);

  // ── Users ────────────────────────────────────────────────────────────────
  db.users = USERS.map(([name, email, role, jobTitle], i) => ({
    _id: `user_${i + 1}`,
    name,
    email,
    jobTitle,
    passwordHash,
    role,
    status: 'active',
    createdAt: iso(240),
    lastLoginAt: iso(i),
  }));
  const editor = db.users[1];

  // ── Tags ─────────────────────────────────────────────────────────────────
  db.tags = [];
  for (const [group, names] of Object.entries(CONTROLLED_TAGS)) {
    for (const name of names) {
      db.tags.push({ _id: uuid(), name, group, type: 'controlled', usageCount: 0, createdAt: iso(200) });
    }
  }
  for (const name of ['Launch Week', 'Radio Edit', 'Client Approved']) {
    db.tags.push({ _id: uuid(), name, group: 'Custom', type: 'custom', usageCount: 0, createdAt: iso(30) });
  }

  // ── Artists ──────────────────────────────────────────────────────────────
  db.artists = ARTISTS.map(([name, genre, label, city], i) => ({
    _id: `artist_${i + 1}`,
    name,
    slug: slug(name),
    genre,
    label,
    city,
    contact: `${slug(name)}@northlight.example`,
    bio: `${name} records with ${label} out of ${city}. ${genre} catalogue managed end to end in Harmony Hub.`,
    socials: [
      { platform: 'Instagram', handle: `@${slug(name).replace(/_/g, '')}` },
      { platform: 'YouTube', handle: `${name} Official` },
    ],
    imageAssetId: null,
    createdAt: iso(300 - i * 10),
    deletedAt: null,
  }));

  // ── Songs + assets ───────────────────────────────────────────────────────
  db.songs = [];
  let assetCounter = 0;

  SONGS.forEach(([title, artistIdx, language, mood, isrc, daysAgo], si) => {
    const artist = db.artists[artistIdx];
    const song = {
      _id: `song_${1000 + si}`,
      title,
      artistId: artist._id,
      featuring: si % 4 === 0 ? [db.artists[(artistIdx + 1) % db.artists.length].name] : [],
      language,
      mood,
      isrc,
      releaseDate: iso(daysAgo),
      tags: pick([mood, language, si % 3 === 0 ? 'Viral' : 'Promo'], 3),
      description: `${title} — ${language} ${mood.toLowerCase()} single by ${artist.name}.`,
      assets: [],
      createdAt: iso(daysAgo + 20),
      updatedAt: iso(Math.max(0, daysAgo - 4)),
      deletedAt: null,
    };

    // Older songs carry the full asset set; the newest are still being filled in.
    const count = daysAgo < 15 ? 4 : daysAgo < 60 ? 7 : RECIPE.length;
    for (const recipe of RECIPE.slice(0, count)) {
      assetCounter += 1;
      const assetId = uuid();
      const displayName = `${slug(title)}_${slug(recipe.type)}${recipe.ext}`;
      const body = makeBody({ recipe, song, artist });
      const typeInfo = TYPE_INDEX[recipe.type];
      const uploadedAt = iso(Math.max(0, daysAgo - 2), 9 + (assetCounter % 8));

      const asset = {
        assetId,
        displayName,
        originalName: `${title} ${recipe.type} FINAL edit ${(assetCounter % 3) + 1}${recipe.ext}`,
        description: `${recipe.type} for ${title}.`,
        type: recipe.type,
        family: familyOf(recipe.type),
        format: typeInfo.formats[0],
        folderId: null,
        // Filled in by put.run() once Google has confirmed the write. Until then the size
        // is the only field that is known, and it is the one the catalogue is built from.
        drive: {
          fileId: null, name: displayName, parentId: null, driveId: null, path: displayName,
          revisionId: null, sizeBytes: body.length, md5: null, sha256: null, sha1: null,
          mimeType: recipe.mime, webViewLink: null, thumbnailLink: null,
          trashed: false, googleNative: false, uploadedAt,
        },
        availability: {
          status: 'AVAILABLE',
          lastCheckedAt: iso(1, 2),
          lastVerifiedAt: iso(1, 2),
          checkMethod: 'LIST_RECONCILE',
          detail: null,
        },
        lastHead: null,
        versionGroupId: `vg_${assetId.slice(0, 8)}`,
        version: recipe.version || 'V1',
        isCurrent: true,
        supersedes: null,
        mimeType: recipe.mime,
        durationSec: recipe.mime.startsWith('audio') ? 10 : recipe.mime.startsWith('video') ? 28 : null,
        dimensions: recipe.mime === 'image/svg+xml' ? (recipe.type === 'Banner Image' ? '1920×1080' : '1200×1200') : null,
        tags: [...recipe.tags, ...(si % 3 === 0 ? ['Viral'] : [])].filter((v, i2, a) => a.indexOf(v) === i2),
        uploadedBy: editor._id,
        createdAt: uploadedAt,
        updatedAt: uploadedAt,
        renamedAt: null,
        deletedAt: null,
        relocateStatus: null,
      };

      put.stage({
        asset,
        body,
        contentType: recipe.mime,
        // Written onto the Drive file itself, so the folder reads correctly to anyone who
        // opens it at drive.google.com without ever having heard of Harmony Hub.
        appProperties: properties({
          app: 'harmonyhub',
          assetId,
          songId: song._id,
          song: song.title,
          artist: artist.name,
          assetType: recipe.type,
          family: familyOf(recipe.type),
          version: recipe.version || 'V1',
          uploadedBy: editor._id,
        }),
      });

      song.assets.push(asset);
    }
    db.songs.push(song);
  });

  // Artist profile photos, stored as assets on the artist's first song.
  db.artists.forEach((artist) => {
    const song = db.songs.find((s) => s.artistId === artist._id);
    if (!song) return;
    const assetId = uuid();
    const displayName = `${artist.slug}_portrait.svg`;
    const body = coverSvg({ title: artist.name, subtitle: artist.genre, seed: artist._id, width: 900, height: 900 });

    const asset = {
      assetId,
      displayName,
      originalName: `${artist.name} press shot RAW.svg`,
      description: `Primary portrait for ${artist.name}.`,
      type: 'Artist Photo',
      family: 'Image',
      format: '1:1',
      folderId: null,
      drive: {
        fileId: null, name: displayName, parentId: null, driveId: null, path: displayName,
        revisionId: null, sizeBytes: body.length, md5: null, sha256: null, sha1: null,
        mimeType: 'image/svg+xml', webViewLink: null, thumbnailLink: null,
        trashed: false, googleNative: false, uploadedAt: iso(150),
      },
      availability: { status: 'AVAILABLE', lastCheckedAt: iso(1, 2), lastVerifiedAt: iso(1, 2), checkMethod: 'LIST_RECONCILE', detail: null },
      lastHead: null,
      versionGroupId: `vg_${assetId.slice(0, 8)}`,
      version: 'V1', isCurrent: true, supersedes: null,
      mimeType: 'image/svg+xml', durationSec: null, dimensions: '900×900',
      tags: ['Promo'], uploadedBy: editor._id,
      createdAt: iso(150), updatedAt: iso(150), renamedAt: null, deletedAt: null, relocateStatus: null,
    };

    put.stage({
      asset,
      body,
      contentType: 'image/svg+xml',
      appProperties: properties({
        app: 'harmonyhub', assetId, artist: artist.name, assetType: 'Artist Photo', family: 'Image',
      }),
    });

    song.assets.push(asset);
    artist.imageAssetId = assetId;
  });

  // A version lineage on the flagship song, so the timeline has something to show.
  const flagship = db.songs[0];
  const reel = flagship.assets.find((a) => a.type === 'Reel - BTS/MV');
  if (reel) {
    const oldId = uuid();
    const oldBody = videoPlaceholder({ seed: 'v1reel', sizeKb: 110 });
    const prior = {
      ...structuredClone(reel),
      assetId: oldId,
      displayName: 'dil_se_reel_bts_mv_v1.mp4',
      originalName: 'BTS REEL rough cut.mp4',
      drive: {
        ...structuredClone(reel.drive),
        fileId: null, name: 'dil_se_reel_bts_mv_v1.mp4', path: 'dil_se_reel_bts_mv_v1.mp4',
        revisionId: null, md5: null, sha256: null, sizeBytes: oldBody.length,
      },
      versionGroupId: reel.versionGroupId,
      version: 'V1',
      isCurrent: false,
      createdAt: iso(60),
      updatedAt: iso(60),
    };
    put.stage({
      asset: prior,
      body: oldBody,
      contentType: 'video/mp4',
      appProperties: properties({ app: 'harmonyhub', assetId: oldId, version: 'V1' }),
    });
    flagship.assets.push(prior);
    reel.supersedes = oldId;
  }

  // ── Unfiled assets — real files with no song ─────────────────────────────
  // These prove the "song is optional" path end to end: they are catalogued, searchable,
  // taggable and foldered, and Drive treats them exactly like everything else. The office
  // formats are real OOXML packages and the PDFs are real PDFs, so the preview panel is
  // reading genuine bytes out of storage for every format the product claims to show.
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const unfiledSpecs = [
    ['northlight_logo_master.svg', 'Artist Photo', 'image/svg+xml', ['Promo'], 2, 'Primary label logo, master artwork.'],
    ['northlight_letterhead.pdf', 'Credits / Metadata Sheet', 'application/pdf', [], 2, 'Label letterhead template.'],
    ['raju_singh_press_kit_2026.pdf', 'Press Kit', 'application/pdf', ['Promo'], 2, 'One-page press kit for press and partners.'],
    ['sync_licence_dilse_ott.pdf', 'Sync Licence', 'application/pdf', [], 3, 'OTT sync licence, countersigned.'],
    ['studio_walkthrough_ep01.wav', 'Podcast Episode', 'audio/wav', ['BTS'], null, 'Episode one of the studio podcast.'],
    ['royalty_statement_q1_2026.xlsx', 'Royalty Statement', XLSX, [], 3, 'Quarterly royalty split by song and platform.'],
    ['launch_plan_dil_se.docx', 'Marketing Plan', DOCX, ['Promo', 'Launch Week'], 0, 'Week-by-week rollout plan for the Dil Se launch.'],
    ['platform_delivery_checklist.csv', 'Marketing Plan', 'text/csv', ['Promo'], 0, 'Delivery status per DSP, exported from the tracker.'],
  ];

  // ── Custom asset types ───────────────────────────────────────────────────
  // Types the team added beyond the built-in 21, to show that the catalogue extends.
  db.customTypes = [
    ['Press Kit', 'Document'],
    ['Sync Licence', 'Document'],
    ['Podcast Episode', 'Audio'],
    ['Royalty Statement', 'Document'],
    ['Marketing Plan', 'Document'],
  ].map(([type, family]) => ({
    _id: `type_${uuid().slice(0, 8)}`,
    type, family, tier: 'HOT',
    createdBy: db.users[0]._id,
    createdAt: iso(40),
    deletedAt: null,
  }));

  // ── Folders ──────────────────────────────────────────────────────────────
  // Real Google Drive folders, created before any file is written so the uploads land
  // straight into them. The last one is nested inside the third, because Drive supports a
  // tree.
  const folderSpecs = [
    ['Dil Se — launch kit', 'Everything the marketing team needs for the Dil Se rollout.', ['Promo', 'Launch Week'], db.songs[0]._id, null],
    ['Chandni Raat — BTS shoot', 'Raw footage and stills from the two-day shoot.', ['BTS'], db.songs[1]._id, null],
    ['Brand & label assets', 'Logos, letterheads and label-wide artwork. Not tied to a release.', ['Promo'], null, null],
    ['Contracts & licences', 'Signed paperwork. Restricted to Admin and Editor in practice.', [], null, 2],
  ];
  db.folders = [];
  for (const [i, [name, description, tags, songId, parentIdx]] of folderSpecs.entries()) {
    const parent = parentIdx == null ? null : db.folders[parentIdx];
    // eslint-disable-next-line no-await-in-loop
    const driveFolder = await storage.makeFolder({ name, parentId: parent?.driveFolderId || ROOTS.assets });
    db.folders.push({
      _id: `folder_${uuid().slice(0, 8)}`,
      name, description, tags, songId,
      parentId: parent?._id ?? null,
      driveFolderId: driveFolder.fileId,
      driveWebViewLink: driveFolder.webViewLink,
      artistId: songId ? db.songs.find((s) => s._id === songId)?.artistId ?? null : null,
      createdBy: db.users[1]._id,
      createdAt: iso(30 - i * 4),
      updatedAt: iso(5 - i),
      deletedAt: null,
    });
  }

  // Put the first song's promo-facing assets into its launch kit, and the BTS footage
  // into the shoot folder. Because the uploads have not run yet, this is still just a
  // field — the files are written directly into the right Drive folder, so nothing is
  // ever copied or moved.
  for (const asset of db.songs[0].assets) {
    if (['Song Cover', 'Banner Image', 'Reel - BTS/MV', 'Horizontal Video'].includes(asset.type)) {
      asset.folderId = db.folders[0]._id;
    }
  }
  for (const asset of db.songs[1].assets) {
    if (asset.type.startsWith('BTS') || asset.type === 'Reel - BTS/MV') asset.folderId = db.folders[1]._id;
  }

  db.unfiled = unfiledSpecs.map(([displayName, type, mime, tags, folderIdx, description], i) => {
    const assetId = uuid();
    const body = unfiledBody({ displayName, mime });
    const at = iso(20 - i * 2, 11);

    const asset = {
      assetId,
      displayName,
      originalName: displayName.replace(/\.[^.]+$/, ' ORIGINAL$&'),
      description,
      type,
      family: type === 'Podcast Episode'
        ? 'Audio'
        : ['Press Kit', 'Sync Licence', 'Royalty Statement', 'Marketing Plan'].includes(type)
          ? 'Document'
          : familyOf(type),
      format: '',
      folderId: folderIdx == null ? null : db.folders[folderIdx]._id,
      drive: {
        fileId: null, name: displayName, parentId: null, driveId: null, path: displayName,
        revisionId: null, sizeBytes: body.length, md5: null, sha256: null, sha1: null,
        mimeType: mime, webViewLink: null, thumbnailLink: null,
        trashed: false, googleNative: false, uploadedAt: at,
      },
      availability: { status: 'AVAILABLE', lastCheckedAt: iso(1, 2), lastVerifiedAt: iso(1, 2), checkMethod: 'LIST_RECONCILE', detail: null },
      lastHead: null,
      versionGroupId: `vg_${assetId.slice(0, 8)}`,
      version: 'V1', isCurrent: true, supersedes: null,
      mimeType: mime, durationSec: mime.startsWith('audio') ? 8 : null,
      dimensions: mime === 'image/svg+xml' ? '900×900' : null,
      tags,
      uploadedBy: db.users[1]._id,
      createdAt: at, updatedAt: at, renamedAt: null, deletedAt: null, relocateStatus: null,
    };

    put.stage({
      asset,
      body,
      contentType: mime,
      appProperties: properties({
        app: 'harmonyhub', assetId, assetType: type, family: familyOf(type) || 'Document',
        tags: tags.join(', '),
      }),
    });

    return asset;
  });

  // ── Deliberate duplicates, so the de-duplication screen is honest on first run ──
  //
  // This is the exact situation the feature exists for, reproduced faithfully: the same
  // reel filed in two different folders under two different names, plus a near-miss pair
  // that only *looks* like a duplicate. Nothing here is annotated as a duplicate — the
  // scan finds them the same way it would find a real one, by comparing the sha256 that
  // Google computes on arrival.
  const duplicates = [];
  const sourceReel = db.songs[0].assets.find((a) => a.type === 'Reel - BTS/MV');
  if (sourceReel) {
    // 1. Byte-for-byte identical, different folder, different name. IDENTICAL tier.
    const dupId = uuid();
    const dupBody = videoPlaceholder({ seed: `reel-${sourceReel.assetId}`, sizeKb: 120 });
    const identical = {
      ...structuredClone(sourceReel),
      assetId: dupId,
      displayName: 'Dil Se Reel FINAL (client copy).mp4',
      originalName: 'Dil Se Reel FINAL (client copy).mp4',
      description: 'Copy handed to the agency. Nobody noticed it was already in the launch kit.',
      folderId: db.folders[2]._id,
      versionGroupId: `vg_${dupId.slice(0, 8)}`,
      supersedes: null,
      drive: {
        ...structuredClone(sourceReel.drive),
        fileId: null, name: 'Dil Se Reel FINAL (client copy).mp4', revisionId: null,
        md5: null, sha256: null, sizeBytes: dupBody.length,
      },
      createdAt: iso(12), updatedAt: iso(12),
    };
    db.unfiled.push(identical);
    duplicates.push('IDENTICAL');

    // The source has to hold the identical bytes for this to be a real duplicate, so it
    // is re-staged with the same body rather than the recipe's.
    put.stage({
      asset: sourceReel,
      body: dupBody,
      contentType: 'video/mp4',
      appProperties: properties({ app: 'harmonyhub', assetId: sourceReel.assetId }),
    });
    put.stage({
      asset: identical,
      body: dupBody,
      contentType: 'video/mp4',
      appProperties: properties({ app: 'harmonyhub', assetId: dupId }),
    });

    // 2. Same name pattern, genuinely different bytes. SAME_NAME tier — the one that must
    // never be acted on blindly, and the reason the UI labels it "worth a look".
    const nearId = uuid();
    const nearBody = videoPlaceholder({ seed: 'reel-recut', sizeKb: 118 });
    const near = {
      ...structuredClone(sourceReel),
      assetId: nearId,
      displayName: 'dil_se_reel_bts_mv_v2_FINAL_final.mp4',
      originalName: 'dil_se_reel_bts_mv_v2_FINAL_final.mp4',
      description: 'A genuinely different cut, despite the name. Not a duplicate.',
      folderId: null,
      versionGroupId: `vg_${nearId.slice(0, 8)}`,
      supersedes: null,
      durationSec: 28,
      drive: {
        ...structuredClone(sourceReel.drive),
        fileId: null, name: 'dil_se_reel_bts_mv_v2_FINAL_final.mp4', revisionId: null,
        md5: null, sha256: null, sizeBytes: nearBody.length,
      },
      createdAt: iso(9), updatedAt: iso(9),
    };
    db.unfiled.push(near);
    put.stage({
      asset: near,
      body: nearBody,
      contentType: 'video/mp4',
      appProperties: properties({ app: 'harmonyhub', assetId: nearId }),
    });
    duplicates.push('SAME_NAME');
  }

  // Everything catalogued so far now goes into Google Drive, concurrently.
  await put.run('Library', log);

  // ── Deliberate drift, so Storage Health is honest on first run ────────────
  // Each of these is a real Drive operation performed out of band, exactly the way the
  // corresponding accident would happen in production — somebody working in
  // drive.google.com rather than in Harmony Hub. Which is the whole category of drift that
  // only exists because a Drive is a place people can open and rearrange by hand.
  const drift = [];

  // 1. MISSING — catalogued, but permanently deleted from Drive.
  const missing = db.songs[2].assets.find((a) => a.type === 'Audio Snippet');
  if (missing?.drive.fileId) {
    await storage.destroy(missing.drive.fileId);
    missing.availability = {
      status: 'MISSING', lastCheckedAt: iso(1, 2), lastVerifiedAt: iso(9),
      checkMethod: 'LIST_RECONCILE',
      detail: 'Google Drive has no file with this id — it was permanently deleted.',
    };
    drift.push('MISSING');
  }

  // 2. MISMATCH — the file was overwritten in Drive, so size and checksum drift.
  const mismatch = db.songs[4].assets.find((a) => a.type === 'Banner Image');
  if (mismatch?.drive.fileId) {
    await storage.putFile({
      fileId: mismatch.drive.fileId,
      name: mismatch.displayName,
      mimeType: 'image/svg+xml',
      body: coverSvg({ title: 'Neon Monsoon', subtitle: 'REPLACED OUT OF BAND', seed: 'drift', width: 1920, height: 1080 }),
    });
    mismatch.availability = {
      status: 'MISMATCH', lastCheckedAt: iso(1, 2), lastVerifiedAt: iso(1, 2),
      checkMethod: 'LIST_RECONCILE',
      detail: 'The file was changed in Google Drive outside Harmony Hub (size drift)',
    };
    drift.push('MISMATCH');
  }

  // 3. TRASHED — somebody dragged a master into the Drive bin. On a 30-day clock, after
  //    which Google deletes it and no backup here can bring it back.
  const trashed = db.songs[1].assets.find((a) => a.type === 'BTS - Unedited Footage');
  if (trashed?.drive.fileId) {
    await storage.trash(trashed.drive.fileId);
    trashed.drive.trashed = true;
    trashed.availability = {
      status: 'TRASHED', lastCheckedAt: iso(1, 2), lastVerifiedAt: iso(1, 2),
      checkMethod: 'LIST_RECONCILE',
      detail: "In Google Drive's trash. Restore it to make it downloadable again.",
    };
    db.restoreRequests.push({
      _id: uuid(), assetId: trashed.assetId, assetName: trashed.displayName,
      requestedBy: editor._id, requestedByName: editor.name,
      status: 'PENDING', requestedAt: iso(0, 8), source: 'DRIVE_TRASH',
    });
    drift.push('TRASHED');
  }

  // 4. PARENT_DRIFT — a file dragged into a different folder in the Drive UI. Nothing is
  //    damaged; the catalogue simply now describes the wrong shelf.
  const moved = db.songs[0].assets.find((a) => a.type === 'Horizontal Video' && a.drive.fileId);
  if (moved) {
    await storage.move(moved.drive.fileId, {
      toParentId: db.folders[1].driveFolderId,
      fromParentId: moved.drive.parentId,
    });
    drift.push('PARENT_DRIFT');
  }

  // 5. NAME_DRIFT — renamed by hand in Drive, so the two names disagree.
  const renamed = db.songs[3].assets.find((a) => a.type === 'Song Cover' && a.drive.fileId);
  if (renamed) {
    await storage.rename(renamed.drive.fileId, 'USE THIS ONE - cover.svg');
    drift.push('NAME_DRIFT');
  }

  // 6. UNTRACKED — a file somebody dropped straight into the Drive folder.
  const orphan = await storage.putFile({
    name: 'unknown_bounce_0417.wav',
    parentId: ROOTS.assets,
    mimeType: 'audio/wav',
    body: wav({ seconds: 3, seed: 'orphan' }),
    appProperties: properties({ note: 'dropped in by hand' }),
  });
  void orphan;
  drift.push('UNTRACKED');

  // 7. UNVERIFIED — never checked, older than 24 h.
  for (const song of db.songs.slice(8)) {
    for (const asset of song.assets.slice(0, 2)) {
      asset.availability = { status: 'UNVERIFIED', lastCheckedAt: null, lastVerifiedAt: null, checkMethod: null, detail: 'Never verified against Google Drive' };
    }
  }
  drift.push('UNVERIFIED');

  // ── Shares ───────────────────────────────────────────────────────────────
  // One live link of each audience, so the Share links page shows all three on first open.
  const shareables = [
    [db.songs[0].assets[0], 7, true, 10, 3, 'PUBLIC', [], 'Sent to launch partner'],
    [db.songs[1].assets[3], 2, true, 5, 5, 'RESTRICTED', ['neha.k@northlight.example'], 'Countersignature copy'],
    [db.songs[5].assets[1], -1, true, 20, 8, 'PUBLIC', [], 'Expired — kept for the audit trail'],
  ];
  db.shares = shareables
    .filter(([a]) => a)
    .map(([asset, days, canDownload, maxDownloads, used, audience, allowedEmails, note]) => ({
      _id: uuid(),
      target: 'ASSET',
      targetId: asset.assetId,
      targetName: asset.displayName,
      assetId: asset.assetId,
      assetName: asset.displayName,
      fileCount: 1,
      songTitle: null,
      artistName: null,
      audience,
      allowedEmails,
      canEdit: audience === 'EDITOR',
      token: token(24),
      createdBy: db.users[2]._id,
      createdByName: db.users[2].name,
      note,
      createdAt: iso(3),
      expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
      canDownload,
      maxDownloads,
      downloadCount: used,
      revokedAt: null,
    }));

  // A whole-folder link. Editor audience: the recipient signs in and can work on the
  // files, not just read them. The folder is a catalogue grouping, so the link resolves
  // to a manifest and each file is signed separately at the moment it is opened.
  db.shares.push({
    _id: uuid(),
    target: 'FOLDER',
    targetId: db.folders[0]._id,
    targetName: db.folders[0].name,
    assetId: null,
    assetName: db.folders[0].name,
    fileCount: db.songs[0].assets.filter((a) => a.folderId === db.folders[0]._id).length,
    songTitle: null,
    artistName: null,
    audience: 'EDITOR',
    allowedEmails: [],
    canEdit: true,
    token: token(24),
    createdBy: db.users[0]._id,
    createdByName: db.users[0].name,
    note: 'Launch kit for the agency team',
    createdAt: iso(1),
    expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    canDownload: true,
    maxDownloads: null,
    downloadCount: 2,
    revokedAt: null,
  });

  // ── Tag usage counts ─────────────────────────────────────────────────────
  const usage = new Map();
  for (const song of db.songs) for (const a of song.assets) for (const t of a.tags) usage.set(t, (usage.get(t) || 0) + 1);
  for (const a of db.unfiled) for (const t of a.tags) usage.set(t, (usage.get(t) || 0) + 1);
  for (const tag of db.tags) tag.usageCount = usage.get(tag.name) || 0;

  // A pair of tags that are the same idea spelled two ways — the vocabulary check on the
  // upload screen catches exactly this before a third spelling appears.
  db.tags.push({ _id: uuid(), name: 'Raju Singh', group: 'Custom', type: 'custom', usageCount: 0, createdAt: iso(25) });

  // ── Seed activity, so the audit view is not empty ─────────────────────────
  const actions = [
    ['ASSET_UPLOAD', 'Uploaded dil_se_master_audio.wav', db.users[1]],
    ['ASSET_RENAME', 'Renamed chandni_raat_reel_bts_mv.mp4', db.users[1]],
    ['SHARE_CREATE', 'Created a 7-day share link', db.users[2]],
    ['ASSET_DOWNLOAD', 'Downloaded long_way_home_song_cover.svg', db.users[3]],
    ['RECONCILE_RUN', 'Nightly reconciliation completed', db.users[0]],
    ['ASSET_VERIFY', 'Verified 24 assets against storage', db.users[0]],
  ];
  db.activityLog = actions.map(([action, label, user], i) => ({
    _id: uuid(), userId: user._id, userName: user.name, userRole: user.role,
    action, entity: 'asset', entityId: uuid(), label, before: null, after: null, meta: null,
    ip: '10.0.2.14', userAgent: 'Mozilla/5.0', timestamp: iso(i * 0.4, 12 - i),
  }));

  // A prior, inventory-only reconciliation run so Storage Health has real findings the
  // first time it is opened, without overwriting the never-checked assets above.
  await runReconciliation({ ip: '127.0.0.1', get: () => 'scheduler', user: null }, {
    trigger: 'scheduled',
    applyAvailability: false,
  });

  await writeMeta({
    seededAt: new Date().toISOString(),
    driveRootFolderId: ROOTS.root,
    driveAssetsFolderId: ROOTS.assets,
  });
  await flushNow();

  const stats = {
    users: db.users.length,
    artists: db.artists.length,
    songs: db.songs.length,
    folders: db.folders.length,
    customTypes: db.customTypes.length,
    assets: db.songs.reduce((n, s) => n + s.assets.length, 0) + db.unfiled.length,
    drift,
    duplicates,
  };
  log(`  Seeded ${stats.assets} assets across ${stats.songs} songs · drift: ${drift.join(', ')}`);
  log(`  Planted duplicates: ${duplicates.join(', ')} — open /dedupe to see them found by checksum.`);
  return stats;
}
