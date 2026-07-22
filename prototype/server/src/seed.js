// Seeds a realistic library: 5 artists, 12 songs, ~70 assets, with REAL objects written
// into the local object store — plus deliberate drift so Storage Health has something
// true to report on first run.
import fs from 'node:fs';
import { db, load, save, reset } from './db.js';
import { BUCKETS, PATHS } from './config.js';
import { hashPassword, uuid, token } from './util/crypto.js';
import { ASSET_TYPES, TYPE_INDEX, familyOf, CONTROLLED_TAGS } from './catalogue.js';
import * as s3 from './s3/localS3.js';
import { coverSvg, wav, lyricsDoc, creditsDoc, videoPlaceholder } from './util/media.js';
import { runReconciliation } from './services/reconcile.js';

const iso = (daysAgo, hour = 10) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/T\d\d/, `T${String(hour).padStart(2, '0')}`);

const pick = (arr, n) => arr.slice(0, n);

const USERS = [
  ['Aarti Deshmukh', 'admin@maestro.app', 'Admin', 'Head of Digital Ops'],
  ['Rohan Iyer', 'editor@maestro.app', 'Editor', 'Content Editor'],
  ['Neha Kapoor', 'marketing@maestro.app', 'Marketing', 'Marketing Lead'],
  ['Sameer Joshi', 'viewer@maestro.app', 'Viewer', 'A&R Analyst'],
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
      return creditsDoc({ title: song.title, artist: artist.name, isrc: song.isrc });
    default:
      return videoPlaceholder({ seed: `${recipe.type}${song._id}`, sizeKb: recipe.type.startsWith('BTS') ? 320 : 128 });
  }
}

export function seed() {
  reset();
  s3.initBuckets(BUCKETS);
  // Stamps this library so a stale process cannot write over it (see db.save).
  db._generation = `${Date.now().toString(36)}-${uuid().slice(0, 6)}`;

  // ── Users ────────────────────────────────────────────────────────────────
  db.users = USERS.map(([name, email, role, jobTitle], i) => ({
    _id: `user_${i + 1}`,
    name,
    email,
    jobTitle,
    passwordHash: hashPassword('maestro'),
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
    bio: `${name} records with ${label} out of ${city}. ${genre} catalogue managed end to end in Maestro.`,
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
      const key = `assets/${assetId}/original${recipe.ext}`;
      const displayName = `${slug(title)}_${slug(recipe.type)}${recipe.ext}`;
      const body = makeBody({ recipe, song, artist });
      const typeInfo = TYPE_INDEX[recipe.type];

      const meta = s3.putObject({
        bucket: BUCKETS.assets,
        key,
        body,
        contentType: recipe.mime,
        metadata: {
          'asset-id': assetId,
          'display-name': displayName,
          'song-id': song._id,
          'song-title': song.title,
          artist: artist.name,
          'asset-type': recipe.type,
          family: familyOf(recipe.type),
          version: recipe.version || 'V1',
          'uploaded-by': editor._id,
        },
      });

      const uploadedAt = iso(Math.max(0, daysAgo - 2), 9 + (assetCounter % 8));
      song.assets.push({
        assetId,
        displayName,
        originalName: `${title} ${recipe.type} FINAL edit ${(assetCounter % 3) + 1}${recipe.ext}`,
        description: `${recipe.type} for ${title}.`,
        type: recipe.type,
        family: familyOf(recipe.type),
        format: typeInfo.formats[0],
        folderId: null,
        s3: {
          bucket: BUCKETS.assets,
          key,
          versionId: meta.versionId,
          region: meta.region,
          storageClass: meta.storageClass,
          sizeBytes: meta.size,
          etag: meta.etag,
          checksumSHA256: null,
          contentType: recipe.mime,
          uploadedAt,
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
        rekeyStatus: null,
      });
    }
    db.songs.push(song);
  });

  // Artist profile photos, stored as assets on the artist's first song.
  db.artists.forEach((artist) => {
    const song = db.songs.find((s) => s.artistId === artist._id);
    if (!song) return;
    const assetId = uuid();
    const key = `assets/${assetId}/original.svg`;
    const body = coverSvg({ title: artist.name, subtitle: artist.genre, seed: artist._id, width: 900, height: 900 });
    const meta = s3.putObject({
      bucket: BUCKETS.assets,
      key,
      body,
      contentType: 'image/svg+xml',
      metadata: { 'asset-id': assetId, 'display-name': `${artist.slug}_portrait.svg`, artist: artist.name, 'asset-type': 'Artist Photo', family: 'Image' },
    });
    song.assets.push({
      assetId,
      displayName: `${artist.slug}_portrait.svg`,
      originalName: `${artist.name} press shot RAW.svg`,
      description: `Primary portrait for ${artist.name}.`,
      type: 'Artist Photo',
      family: 'Image',
      format: '1:1',
      folderId: null,
      s3: {
        bucket: BUCKETS.assets, key, versionId: meta.versionId, region: meta.region,
        storageClass: 'STANDARD', sizeBytes: meta.size, etag: meta.etag, checksumSHA256: null,
        contentType: 'image/svg+xml', uploadedAt: iso(150),
      },
      availability: { status: 'AVAILABLE', lastCheckedAt: iso(1, 2), lastVerifiedAt: iso(1, 2), checkMethod: 'LIST_RECONCILE', detail: null },
      lastHead: null,
      versionGroupId: `vg_${assetId.slice(0, 8)}`,
      version: 'V1', isCurrent: true, supersedes: null,
      mimeType: 'image/svg+xml', durationSec: null, dimensions: '900×900',
      tags: ['Promo'], uploadedBy: editor._id,
      createdAt: iso(150), updatedAt: iso(150), renamedAt: null, deletedAt: null, rekeyStatus: null,
    });
    artist.imageAssetId = assetId;
  });

  // A version lineage on the flagship song, so the timeline has something to show.
  const flagship = db.songs[0];
  const reel = flagship.assets.find((a) => a.type === 'Reel - BTS/MV');
  if (reel) {
    const oldId = uuid();
    const oldKey = `assets/${oldId}/original.mp4`;
    const oldBody = videoPlaceholder({ seed: 'v1reel', sizeKb: 110 });
    const oldMeta = s3.putObject({
      bucket: BUCKETS.assets, key: oldKey, body: oldBody, contentType: 'video/mp4',
      metadata: { 'asset-id': oldId, 'display-name': 'dil_se_reel_bts_mv_v1.mp4', version: 'V1' },
    });
    flagship.assets.push({
      ...structuredClone(reel),
      assetId: oldId,
      displayName: 'dil_se_reel_bts_mv_v1.mp4',
      originalName: 'BTS REEL rough cut.mp4',
      s3: { ...reel.s3, key: oldKey, versionId: oldMeta.versionId, sizeBytes: oldMeta.size, etag: oldMeta.etag },
      versionGroupId: reel.versionGroupId,
      version: 'V1',
      isCurrent: false,
      createdAt: iso(60),
      updatedAt: iso(60),
    });
    reel.supersedes = oldId;
  }

  // ── Deliberate drift, so Storage Health is honest on first run ────────────
  // 1. MISSING — catalogued, but the object is gone from the bucket.
  const missing = db.songs[2].assets.find((a) => a.type === 'Audio Snippet');
  if (missing) {
    s3.deleteObject({ bucket: BUCKETS.assets, key: missing.s3.key });
    missing.availability = {
      status: 'MISSING', lastCheckedAt: iso(1, 2), lastVerifiedAt: iso(9),
      checkMethod: 'LIST_RECONCILE', detail: `NoSuchKey — object not found in ${BUCKETS.assets}`,
    };
  }

  // 2. MISMATCH — the object was overwritten out of band, so size and ETag drift.
  const mismatch = db.songs[4].assets.find((a) => a.type === 'Banner Image');
  if (mismatch) {
    s3.putObject({
      bucket: BUCKETS.assets,
      key: mismatch.s3.key,
      body: coverSvg({ title: 'Neon Monsoon', subtitle: 'REPLACED OUT OF BAND', seed: 'drift', width: 1920, height: 1080 }),
      contentType: 'image/svg+xml',
    });
    mismatch.availability = {
      status: 'MISMATCH', lastCheckedAt: iso(1, 2), lastVerifiedAt: iso(1, 2),
      checkMethod: 'LIST_RECONCILE',
      detail: 'Object present but differs from the catalogue record (size drift)',
    };
  }

  // 3. ARCHIVED + 4. RESTORING — cold-tier BTS footage moved to Glacier.
  const archived = db.songs[1].assets.find((a) => a.type === 'BTS - Unedited Footage');
  if (archived) {
    s3.setStorageClass({ bucket: BUCKETS.assets, key: archived.s3.key, storageClass: 'GLACIER' });
    archived.availability = { status: 'ARCHIVED', lastCheckedAt: iso(1, 2), lastVerifiedAt: iso(1, 2), checkMethod: 'LIST_RECONCILE', detail: 'Stored in GLACIER — restore required before download' };
  }
  const restoring = db.songs[3].assets.find((a) => a.type === 'BTS - Unedited Footage');
  if (restoring) {
    s3.setStorageClass({ bucket: BUCKETS.assets, key: restoring.s3.key, storageClass: 'GLACIER' });
    s3.restoreObject({ bucket: BUCKETS.assets, key: restoring.s3.key, tier: 'Standard' });
    restoring.availability = { status: 'RESTORING', lastCheckedAt: iso(0, 8), lastVerifiedAt: iso(0, 8), checkMethod: 'HEAD_OBJECT', detail: 'Standard retrieval in progress' };
    db.restoreRequests.push({
      _id: uuid(), assetId: restoring.assetId, requestedBy: editor._id, tier: 'Standard',
      status: 'IN_PROGRESS', requestedAt: iso(0, 8), availableUntil: null,
    });
  }

  // 5. UNTRACKED — an orphan object nobody catalogued.
  s3.putObject({
    bucket: BUCKETS.assets,
    key: `assets/${uuid()}/original.wav`,
    body: wav({ seconds: 3, seed: 'orphan' }),
    contentType: 'audio/wav',
    metadata: { 'display-name': 'unknown_bounce_0417.wav' },
  });

  // 6. UNVERIFIED — never checked, older than 24 h.
  for (const song of db.songs.slice(8)) {
    for (const asset of song.assets.slice(0, 2)) {
      asset.availability = { status: 'UNVERIFIED', lastCheckedAt: null, lastVerifiedAt: null, checkMethod: null, detail: 'Never verified against storage' };
    }
  }

  // ── Shares ───────────────────────────────────────────────────────────────
  const shareables = [
    [db.songs[0].assets[0], 7, true, 10, 3],
    [db.songs[1].assets[3], 2, true, 5, 5],
    [db.songs[5].assets[1], -1, true, 20, 8],
  ];
  db.shares = shareables
    .filter(([a]) => a)
    .map(([asset, days, canDownload, maxDownloads, used]) => ({
      _id: uuid(),
      assetId: asset.assetId,
      assetName: asset.displayName,
      token: token(24),
      createdBy: db.users[2]._id,
      createdByName: db.users[2].name,
      note: 'Sent to launch partner',
      createdAt: iso(3),
      expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
      canDownload,
      maxDownloads,
      downloadCount: used,
      revokedAt: null,
    }));

  // ── Tag usage counts ─────────────────────────────────────────────────────
  const usage = new Map();
  for (const song of db.songs) for (const a of song.assets) for (const t of a.tags) usage.set(t, (usage.get(t) || 0) + 1);
  for (const tag of db.tags) tag.usageCount = usage.get(tag.name) || 0;

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

  // ── Custom asset types ───────────────────────────────────────────────────
  // Types the team added beyond the built-in 21, to show that the catalogue extends.
  db.customTypes = [
    ['Press Kit', 'Document'],
    ['Sync Licence', 'Document'],
    ['Podcast Episode', 'Audio'],
  ].map(([type, family]) => ({
    _id: `type_${uuid().slice(0, 8)}`,
    type, family, tier: 'HOT',
    createdBy: db.users[0]._id,
    createdAt: iso(40),
    deletedAt: null,
  }));

  // ── Folders ──────────────────────────────────────────────────────────────
  // Grouping lives here, in the catalogue. Nothing about the objects in storage changes:
  // each file below is still its own object under its own UUID key.
  const folderSpecs = [
    ['Dil Se — launch kit', 'Everything the marketing team needs for the Dil Se rollout.', ['Promo', 'Launch Week'], db.songs[0]._id],
    ['Chandni Raat — BTS shoot', 'Raw footage and stills from the two-day shoot.', ['BTS'], db.songs[1]._id],
    ['Brand & label assets', 'Logos, letterheads and label-wide artwork. Not tied to a release.', ['Promo'], null],
    ['Contracts & licences', 'Signed paperwork. Restricted to Admin and Editor in practice.', [], null],
  ];
  db.folders = folderSpecs.map(([name, description, tags, songId], i) => ({
    _id: `folder_${uuid().slice(0, 8)}`,
    name, description, tags, songId,
    artistId: songId ? db.songs.find((s) => s._id === songId)?.artistId ?? null : null,
    createdBy: db.users[1]._id,
    createdAt: iso(30 - i * 4),
    updatedAt: iso(5 - i),
    deletedAt: null,
  }));

  // Put the first song's promo-facing assets into its launch kit, and the BTS footage
  // into the shoot folder — membership is one field, no object is copied or moved.
  for (const asset of db.songs[0].assets) {
    if (['Song Cover', 'Banner Image', 'Reel - BTS/MV', 'Horizontal Video'].includes(asset.type)) {
      asset.folderId = db.folders[0]._id;
    }
  }
  for (const asset of db.songs[1].assets) {
    if (asset.type.startsWith('BTS') || asset.type === 'Reel - BTS/MV') asset.folderId = db.folders[1]._id;
  }

  // ── Unfiled assets — real files with no song ─────────────────────────────
  // These prove the "song is optional" path end to end: they are catalogued, searchable,
  // taggable and foldered, and storage treats them exactly like everything else.
  const unfiledSpecs = [
    ['northlight_logo_master.svg', 'Artist Photo', 'image/svg+xml', ['Promo'], db.folders[2]._id, 'Primary label logo, master artwork.'],
    ['northlight_letterhead.pdf', 'Credits / Metadata Sheet', 'application/pdf', [], db.folders[2]._id, 'Label letterhead template.'],
    ['raju_singh_press_kit_2026.pdf', 'Press Kit', 'application/pdf', ['Promo'], db.folders[2]._id, 'One-page press kit for press and partners.'],
    ['sync_licence_dilse_ott.pdf', 'Sync Licence', 'application/pdf', [], db.folders[3]._id, 'OTT sync licence, countersigned.'],
    ['studio_walkthrough_ep01.wav', 'Podcast Episode', 'audio/wav', ['BTS'], null, 'Episode one of the studio podcast.'],
  ];
  db.unfiled = unfiledSpecs.map(([displayName, type, mime, tags, folderId, description], i) => {
    const assetId = uuid();
    const ext = displayName.slice(displayName.lastIndexOf('.'));
    const key = `assets/${assetId}/original${ext}`;
    const body = mime.startsWith('audio')
      ? wav({ seconds: 8, seed: displayName })
      : mime === 'image/svg+xml'
        ? coverSvg({ title: 'Northlight', subtitle: 'Records', seed: displayName, width: 900, height: 900 })
        : creditsDoc({ title: displayName, artist: 'Northlight Records', isrc: '—' });
    const meta = s3.putObject({
      bucket: BUCKETS.assets, key, body, contentType: mime,
      metadata: { 'asset-id': assetId, 'display-name': displayName, 'asset-type': type, family: familyOf(type) || 'Document' },
    });
    const at = iso(20 - i * 2, 11);
    return {
      assetId, displayName,
      originalName: displayName.replace(/\.[^.]+$/, ' ORIGINAL$&'),
      description,
      type,
      family: ['Press Kit', 'Sync Licence'].includes(type) ? 'Document' : type === 'Podcast Episode' ? 'Audio' : familyOf(type),
      format: '',
      folderId,
      s3: {
        bucket: BUCKETS.assets, key, versionId: meta.versionId, region: meta.region,
        storageClass: 'STANDARD', sizeBytes: meta.size, etag: meta.etag, checksumSHA256: null,
        contentType: mime, uploadedAt: at,
      },
      availability: { status: 'AVAILABLE', lastCheckedAt: iso(1, 2), lastVerifiedAt: iso(1, 2), checkMethod: 'LIST_RECONCILE', detail: null },
      lastHead: null,
      versionGroupId: `vg_${assetId.slice(0, 8)}`,
      version: 'V1', isCurrent: true, supersedes: null,
      mimeType: mime, durationSec: mime.startsWith('audio') ? 8 : null,
      dimensions: mime === 'image/svg+xml' ? '900×900' : null,
      tags,
      uploadedBy: db.users[1]._id,
      createdAt: at, updatedAt: at, renamedAt: null, deletedAt: null, rekeyStatus: null,
    };
  });

  // A pair of tags that are the same idea spelled two ways — the vocabulary check on the
  // upload screen catches exactly this before a third spelling appears.
  db.tags.push({ _id: uuid(), name: 'Raju Singh', group: 'Custom', type: 'custom', usageCount: 0, createdAt: iso(25) });

  // A prior, inventory-only reconciliation run so Storage Health has real findings the
  // first time it is opened, without overwriting the never-checked assets above.
  runReconciliation({ ip: '127.0.0.1', get: () => 'scheduler', user: null }, {
    trigger: 'scheduled',
    applyAvailability: false,
  });

  save({ force: true });
  return {
    users: db.users.length,
    artists: db.artists.length,
    songs: db.songs.length,
    folders: db.folders.length,
    customTypes: db.customTypes.length,
    assets: db.songs.reduce((n, s) => n + s.assets.length, 0) + db.unfiled.length,
  };
}

export function ensureSeeded({ force = false } = {}) {
  if (force || !fs.existsSync(PATHS.db)) {
    const stats = seed();
    return { seeded: true, stats };
  }
  load();
  s3.initBuckets(BUCKETS);
  return { seeded: false, stats: null };
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const stats = seed();
  console.log('Seeded Maestro library:', stats);
}
