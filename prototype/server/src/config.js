// Runtime config — mirrors the env-schema layer of the reference architecture (§9.1 config/).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const PORT = Number(process.env.PORT || 4000);
export const ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
// Where a person opens the app. Same origin as the API in the deployed architecture — the
// built bundle is served by the same task. Set APP_ORIGIN=http://localhost:5173 when
// running the Vite dev server so share links point at the dev front end.
export const APP_ORIGIN = process.env.APP_ORIGIN || ORIGIN;

// Secrets — in production these come from AWS Secrets Manager (§12.1).
export const JWT_SECRET = process.env.JWT_SECRET || 'maestro-dev-jwt-secret';
export const SIGNING_KEY = process.env.S3_SIGNING_KEY || 'maestro-dev-s3-signing-key';

export const REGION = 'ap-south-1';
export const ENV = process.env.APP_ENV || 'dev';

export const BUCKETS = {
  assets: `maestro-assets-${ENV}`,
  uploads: `maestro-uploads-${ENV}`,
  backups: `maestro-backups-${ENV}`,
  logs: `maestro-logs-${ENV}`,
};

export const PATHS = {
  data: path.join(ROOT, 'data'),
  db: path.join(ROOT, 'data', 'db.json'),
  s3: path.join(ROOT, 'data', 's3'),
};

// Presigned URL TTLs, by role (§12.3).
export const TTL = {
  download: 5 * 60,
  preview: 60 * 60,
  uploadPart: 60 * 60,
  share: 60 * 60,
};

export const ACCESS_TTL_SEC = 60 * 60 * 8; // generous for a prototype session
export const PART_SIZE = 8 * 1024 * 1024; // 8 MB multipart chunk (§8.3)
