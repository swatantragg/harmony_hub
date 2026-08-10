// The Google Drive REST client, and the only file in the codebase that knows what a
// Drive HTTP request looks like (§9.2). services/storage.js is the only importer.
//
// There is no Google SDK here on purpose. The whole surface the application needs is
// eleven endpoints, and hand-rolling them keeps three things visible that a wrapper hides:
// which fields are actually requested, where `supportsAllDrives` has to appear, and the
// exact shape of a resumable upload session — which is the one piece the browser talks to
// directly and therefore the one piece that has to be exactly right.
import jwt from 'jsonwebtoken';
import { DRIVE_ID, GOOGLE, GOOGLE_CONFIGURED, LIST_PAGE_SIZE } from '../config.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// drive.file would be tighter, but it only ever sees files this app itself created —
// which makes "adopt an object somebody dropped in the folder" impossible, and that is a
// feature of reconciliation, not an accident.
export const SCOPE = 'https://www.googleapis.com/auth/drive';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

// Google Workspace documents have no bytes of their own: size is absent and a download
// has to name an export format. They are legal library members — a lyric sheet written in
// Docs is still a lyric sheet — so they are recognised rather than rejected.
export const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';
export const isGoogleNative = (mimeType) => String(mimeType || '').startsWith(GOOGLE_NATIVE_PREFIX);

export const EXPORT_FORMATS = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx',
  },
  'application/vnd.google-apps.drawing': { mimeType: 'image/png', ext: '.png' },
};

// Everything the application ever needs to know about a file, in one field mask. Drive
// returns only what is asked for, and asking for `*` on a 5,000-file listing is the
// difference between a fast reconciliation and a slow one.
export const FILE_FIELDS = [
  'id', 'name', 'mimeType', 'size', 'md5Checksum', 'sha1Checksum', 'sha256Checksum',
  'parents', 'trashed', 'explicitlyTrashed', 'createdTime', 'modifiedTime', 'version',
  'headRevisionId', 'webViewLink', 'iconLink', 'thumbnailLink', 'appProperties', 'driveId',
  'videoMediaMetadata(width,height,durationMillis)', 'imageMediaMetadata(width,height)',
  'lastModifyingUser(displayName,emailAddress)', 'shortcutDetails(targetId,targetMimeType)',
].join(',');

// ── Errors ──────────────────────────────────────────────────────────────────
// Drive reports "gone" and "not allowed" as distinguishable reason strings, and the
// availability decision table (§10.5.1) depends on telling them apart.

export class DriveError extends Error {
  constructor(status, reason, message, detail) {
    super(message || `Google Drive returned ${status}`);
    this.name = 'DriveError';
    this.status = status;
    this.reason = reason;
    this.detail = detail;
  }
}

export const driveErrorCode = (err) => err?.reason || err?.name || err?.status || 'UnknownError';

export const isNotFound = (err) => err?.status === 404 || err?.reason === 'notFound';

export const isAccessDenied = (err) =>
  err?.status === 401 || err?.status === 403
    ? err.reason !== 'storageQuotaExceeded' && err.reason !== 'rateLimitExceeded'
    : false;

export const isQuotaExceeded = (err) =>
  err?.reason === 'storageQuotaExceeded' || err?.reason === 'quotaExceeded';

const isRetryable = (status, reason) =>
  status === 429 || status >= 500 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';

// ── Access tokens ───────────────────────────────────────────────────────────
// One token, cached until a minute before it expires, and a single in-flight refresh no
// matter how many callers arrive at once.

let cached = { token: null, expiresAt: 0 };
let refreshing = null;

async function exchange(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = payload.error || 'invalid_grant';
    throw new DriveError(
      res.status,
      reason,
      // These two are the failures people actually hit, and the generic Google wording
      // for them says nothing useful.
      reason === 'invalid_grant'
        ? 'Google rejected the stored credential. A refresh token expires if it is unused for six months, if the account password changed, or if the OAuth consent screen is still in Testing mode (those tokens last seven days). Run `npm run drive:auth` to mint a new one.'
        : reason === 'invalid_client'
          ? 'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET does not match a client in your Google Cloud project.'
          : payload.error_description || `Token exchange failed: ${reason}`,
      payload,
    );
  }
  return payload;
}

async function mintToken() {
  if (!GOOGLE_CONFIGURED) {
    throw new DriveError(
      412,
      'notConfigured',
      GOOGLE.mode === 'oauth'
        ? 'Google Drive is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN in app/.env — `npm run drive:auth` walks you through it.'
        : 'Google Drive is not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY (or GOOGLE_SERVICE_ACCOUNT_KEY_FILE) in app/.env.',
    );
  }

  if (GOOGLE.mode === 'oauth') {
    const out = await exchange({
      client_id: GOOGLE.clientId,
      client_secret: GOOGLE.clientSecret,
      refresh_token: GOOGLE.refreshToken,
      grant_type: 'refresh_token',
    });
    return { token: out.access_token, expiresIn: Number(out.expires_in ?? 3600) };
  }

  // Service account: a self-signed JWT is traded for an access token. RS256 signing is
  // already in the dependency tree for the app's own sessions, so no new one is needed.
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: GOOGLE.serviceAccountEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
      // Only set for domain-wide delegation, where the robot acts as a real Workspace user.
      ...(GOOGLE.subject ? { sub: GOOGLE.subject } : {}),
    },
    GOOGLE.privateKey,
    { algorithm: 'RS256' },
  );
  const out = await exchange({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  return { token: out.access_token, expiresIn: Number(out.expires_in ?? 3600) };
}

export async function accessToken({ force = false } = {}) {
  if (!force && cached.token && Date.now() < cached.expiresAt) return cached.token;
  if (!refreshing) {
    refreshing = mintToken()
      .then(({ token, expiresIn }) => {
        cached = { token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
        return token;
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

export function forgetToken() {
  cached = { token: null, expiresAt: 0 };
}

// ── Request plumbing ────────────────────────────────────────────────────────

// Shared Drives are opt-in on every single call. Forgetting one of these flags is the
// classic cause of "the file exists in the Drive and the API says 404".
function sharedDriveParams({ list = false } = {}) {
  const params = { supportsAllDrives: 'true' };
  if (list) {
    params.includeItemsFromAllDrives = 'true';
    if (DRIVE_ID) {
      params.corpora = 'drive';
      params.driveId = DRIVE_ID;
    }
  }
  return params;
}

const query = (params = {}) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

async function readError(res) {
  const text = await res.text().catch(() => '');
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  const first = payload?.error?.errors?.[0];
  return new DriveError(
    res.status,
    first?.reason || payload?.error?.status || payload?.error || String(res.status),
    payload?.error?.message || payload?.error_description || text.slice(0, 400) || res.statusText,
    payload,
  );
}

// Every Drive call goes through here: one token, one retry on a 401 in case the cached
// token was revoked mid-flight, and bounded backoff on the rate limits Google actually
// applies (1,000 requests / 100 s / user is easy to hit during reconciliation).
const MAX_ATTEMPTS = 5;

export async function request(url, { method = 'GET', headers = {}, body, raw = false, retry = true } = {}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const token = await accessToken({ force: attempt === 2 && retry });
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...headers },
      body,
      // A resumable session responds 308, which fetch would otherwise chase.
      redirect: 'manual',
    });

    if (res.ok || (raw && res.status === 308)) return raw ? res : res.status === 204 ? null : res.json();

    // eslint-disable-next-line no-await-in-loop
    const err = await readError(res);
    if (attempt < MAX_ATTEMPTS && retry && (res.status === 401 || isRetryable(res.status, err.reason))) {
      if (res.status === 401) forgetToken();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, Math.min(8000, 2 ** attempt * 250) + Math.random() * 250));
      continue;
    }
    throw err;
  }
}

const api = (path, params, options) => request(`${API}${path}${query(params)}`, options);

const json = (value) => ({
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: JSON.stringify(value),
});

// ── Properties ──────────────────────────────────────────────────────────────
// Arbitrary key/value metadata carried on the file itself. Values may be full UTF-8, so a
// Hindi song title survives intact — but key + value together are capped at 124 bytes and
// a file may carry 100 of them. So values are truncated by *byte* length, not character
// length: cutting a multi-byte character in half is what makes Drive reject the write.

const enc = new TextEncoder();

export function truncateBytes(value, budget) {
  const s = String(value ?? '');
  if (enc.encode(s).length <= budget) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const size = enc.encode(ch).length;
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return out;
}

export function properties(input = {}) {
  const out = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (count >= 100) break;
    const key = String(rawKey).slice(0, 60);
    const budget = 124 - enc.encode(key).length;
    if (budget <= 0) continue;
    const value = truncateBytes(rawValue, budget);
    if (value === '') continue;
    out[key] = value;
    count += 1;
  }
  return out;
}

// A Drive `q` string is a small expression language, and a single unescaped apostrophe in
// a song title turns a search into a syntax error. Everything user-supplied goes through
// this before it is interpolated.
export const escapeQuery = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// ── Files ───────────────────────────────────────────────────────────────────

export const getFile = (fileId, fields = FILE_FIELDS) =>
  api(`/files/${encodeURIComponent(fileId)}`, { fields, ...sharedDriveParams() });

export function listFiles({ q, pageToken, pageSize = LIST_PAGE_SIZE, fields = FILE_FIELDS, orderBy } = {}) {
  return api('/files', {
    q,
    pageSize: Math.min(1000, pageSize),
    pageToken,
    orderBy,
    fields: `nextPageToken,files(${fields})`,
    ...sharedDriveParams({ list: true }),
  });
}

// Paginated to exhaustion. `onPage` exists so reconciliation can report progress over a
// large Drive without holding two copies of the listing.
export async function listAll({ q, fields = FILE_FIELDS, onPage } = {}) {
  const files = [];
  let pageToken;
  let pages = 0;
  do {
    // eslint-disable-next-line no-await-in-loop
    const out = await listFiles({ q, pageToken, fields });
    pages += 1;
    const page = out.files || [];
    files.push(...page);
    if (onPage) onPage(page, pages);
    pageToken = out.nextPageToken;
  } while (pageToken);
  return { files, pages };
}

export const createFolder = ({ name, parentId }) =>
  api('/files', { fields: FILE_FIELDS, ...sharedDriveParams() }, {
    method: 'POST',
    ...json({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
  });

export async function findFolder({ name, parentId }) {
  const q = [
    `mimeType = '${FOLDER_MIME}'`,
    `name = '${escapeQuery(name)}'`,
    'trashed = false',
    parentId ? `'${escapeQuery(parentId)}' in parents` : null,
  ].filter(Boolean).join(' and ');
  const out = await listFiles({ q, pageSize: 10 });
  return out.files?.[0] ?? null;
}

// Idempotent. Two boots racing each other can both create a folder called "Assets", so
// the existence check is repeated after the create and the older id wins.
export async function ensureFolder({ name, parentId }) {
  const found = await findFolder({ name, parentId });
  if (found) return found;
  const made = await createFolder({ name, parentId });
  const all = await listFiles({
    q: [
      `mimeType = '${FOLDER_MIME}'`,
      `name = '${escapeQuery(name)}'`,
      'trashed = false',
      parentId ? `'${escapeQuery(parentId)}' in parents` : null,
    ].filter(Boolean).join(' and '),
    pageSize: 10,
    fields: 'id,name,createdTime',
  });
  const winner = (all.files || []).sort((a, b) => Date.parse(a.createdTime) - Date.parse(b.createdTime))[0];
  if (winner && winner.id !== made.id) {
    await deleteFile(made.id).catch(() => null);
    return getFile(winner.id);
  }
  return made;
}

export function updateFile(fileId, { addParents, removeParents, ...patch } = {}) {
  return api(`/files/${encodeURIComponent(fileId)}`, {
    fields: FILE_FIELDS,
    addParents: Array.isArray(addParents) ? addParents.join(',') : addParents,
    removeParents: Array.isArray(removeParents) ? removeParents.join(',') : removeParents,
    // Renaming or moving a file inside Drive normally bumps it to the top of everyone's
    // "Recent". The library does both routinely, and it is not what a rename means here.
    keepRevisionForever: undefined,
    ...sharedDriveParams(),
  }, { method: 'PATCH', ...json(patch) });
}

export const copyFile = (fileId, { name, parentId, appProperties } = {}) =>
  api(`/files/${encodeURIComponent(fileId)}/copy`, { fields: FILE_FIELDS, ...sharedDriveParams() }, {
    method: 'POST',
    ...json({ ...(name ? { name } : {}), ...(parentId ? { parents: [parentId] } : {}), ...(appProperties ? { appProperties } : {}) }),
  });

export const trashFile = (fileId) => updateFile(fileId, { trashed: true });
export const untrashFile = (fileId) => updateFile(fileId, { trashed: false });

// Permanent. Drive skips the trash entirely for this one and there is no undo.
export const deleteFile = (fileId) =>
  api(`/files/${encodeURIComponent(fileId)}`, sharedDriveParams(), { method: 'DELETE' });

export const emptyTrash = () => api('/files/trash', { ...sharedDriveParams() }, { method: 'DELETE' });

// ── Revisions — Drive's own version history for a file ──────────────────────

export const listRevisions = (fileId) =>
  api(`/files/${encodeURIComponent(fileId)}/revisions`, {
    fields: 'revisions(id,modifiedTime,size,md5Checksum,keepForever,originalFilename,lastModifyingUser(displayName))',
    pageSize: 200,
  });

// Drive keeps 100 revisions or 30 days by default, whichever comes first — a master that
// gets replaced twice a week silently loses its history otherwise.
export const keepRevisionForever = (fileId, revisionId) =>
  api(`/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`, {}, {
    method: 'PATCH', ...json({ keepForever: true }),
  });

export const deleteRevision = (fileId, revisionId) =>
  api(`/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`, {}, { method: 'DELETE' });

// ── Uploads ─────────────────────────────────────────────────────────────────

// Small server-side writes (the seeder, a generated cover) go in one multipart/related
// request. Anything a person uploads goes through a resumable session instead.
export async function uploadSimple({ name, parentId, mimeType, body, appProperties, fileId }) {
  const boundary = `hh-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const metadata = fileId
    ? { name, ...(appProperties ? { appProperties } : {}) }
    : { name, ...(parentId ? { parents: [parentId] } : {}), ...(appProperties ? { appProperties } : {}), mimeType };

  const head = Buffer.from(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\ncontent-type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const payload = Buffer.concat([head, Buffer.isBuffer(body) ? body : Buffer.from(body), tail]);

  const url = `${UPLOAD}/files${fileId ? `/${encodeURIComponent(fileId)}` : ''}${query({
    uploadType: 'multipart', fields: FILE_FIELDS, ...sharedDriveParams(),
  })}`;
  return request(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body: payload,
  });
}

// Opens a resumable session and hands back the session URI.
//
// This URI is the whole point of the Drive upload story: it is itself the credential, it
// is valid for about a week, and Google serves it with permissive CORS. So the browser
// can PUT bytes straight to Google without an access token and without those bytes ever
// touching this process. Pass `fileId` to open a session that writes a *new revision* of
// an existing file rather than creating one.
export async function createResumableSession({
  name, parentId, mimeType, sizeBytes, appProperties, fileId, origin,
}) {
  const metadata = fileId
    ? { name, ...(appProperties ? { appProperties } : {}) }
    : {
      name,
      ...(parentId ? { parents: [parentId] } : {}),
      ...(appProperties ? { appProperties } : {}),
      mimeType: mimeType || 'application/octet-stream',
    };

  const url = `${UPLOAD}/files${fileId ? `/${encodeURIComponent(fileId)}` : ''}${query({
    uploadType: 'resumable', fields: FILE_FIELDS, ...sharedDriveParams(),
  })}`;

  const res = await request(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': mimeType || 'application/octet-stream',
      ...(sizeBytes ? { 'x-upload-content-length': String(sizeBytes) } : {}),
      // Google echoes the origin into the session's CORS policy. Without it the browser's
      // PUT is blocked, which looks like a network error and is not one.
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(metadata),
    raw: true,
  });

  const sessionUri = res.headers.get('location');
  if (!sessionUri) {
    throw new DriveError(502, 'noSession', 'Google accepted the upload request but returned no session URI.');
  }
  return { sessionUri, expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString() };
}

// Discards a half-finished session. Without it the partial bytes sit in Google's staging
// area for a week; they are not billed against Drive quota, but they are still litter.
export async function cancelResumableSession(sessionUri) {
  const res = await fetch(sessionUri, { method: 'DELETE', headers: { 'content-length': '0' } });
  return res.status === 499 || res.status === 200 || res.status === 204 || res.status === 404;
}

// Asks a session how much of the file Google already holds — the resume handshake, and
// the reason a dropped connection costs one round trip instead of a whole upload.
export async function probeResumableSession(sessionUri, totalBytes) {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'content-range': `bytes */${totalBytes}`, 'content-length': '0' },
  });
  if (res.status === 200 || res.status === 201) return { complete: true, received: totalBytes };
  if (res.status === 308) {
    const range = res.headers.get('range');
    const received = range ? Number(range.split('-')[1]) + 1 : 0;
    return { complete: false, received };
  }
  throw new DriveError(res.status, 'sessionGone', 'That upload session is no longer valid. Start the upload again.');
}

// ── Download ────────────────────────────────────────────────────────────────

// Returns the live fetch Response so the caller can stream it. Range is forwarded
// verbatim, which is what makes scrubbing through a two-hour video work without pulling
// two hours of video.
export async function downloadResponse(fileId, { range, exportMimeType, signal } = {}) {
  const url = exportMimeType
    ? `${API}/files/${encodeURIComponent(fileId)}/export${query({ mimeType: exportMimeType })}`
    : `${API}/files/${encodeURIComponent(fileId)}${query({ alt: 'media', acknowledgeAbuse: 'true', ...sharedDriveParams() })}`;

  const token = await accessToken();
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, ...(range ? { range } : {}) },
    signal,
  });
  if (!res.ok && res.status !== 206) throw await readError(res);
  return res;
}

// ── Permissions ─────────────────────────────────────────────────────────────

export const listPermissions = (fileId) =>
  api(`/files/${encodeURIComponent(fileId)}/permissions`, {
    fields: 'permissions(id,type,role,emailAddress,domain)', ...sharedDriveParams(),
  });

export const createPermission = (fileId, permission) =>
  api(`/files/${encodeURIComponent(fileId)}/permissions`, { fields: 'id', sendNotificationEmail: 'false', ...sharedDriveParams() }, {
    method: 'POST', ...json(permission),
  });

export const deletePermission = (fileId, permissionId) =>
  api(`/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`, sharedDriveParams(), {
    method: 'DELETE',
  });

// ── Account ─────────────────────────────────────────────────────────────────

export const about = () =>
  api('/about', { fields: 'user(displayName,emailAddress,photoLink),storageQuota,maxUploadSize,canCreateDrives' });

export const getDrive = (driveId) =>
  api(`/drives/${encodeURIComponent(driveId)}`, { fields: 'id,name,capabilities(canAddChildren,canDeleteChildren)' });

// ── Bounded fan-out ─────────────────────────────────────────────────────────
// Every place that issues files.get over a list uses this. Drive's per-user rate limit is
// enforces a per-user request ceiling, so the default is deliberately conservative (§10.5.3).

export async function mapLimit(items, limit, fn) {
  const list = [...items];
  const out = new Array(list.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
  return out;
}
