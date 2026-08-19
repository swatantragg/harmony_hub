// Repository facade. Everything above this line works against the catalogue's shape; the
// storage of that catalogue lives in db/store.js and db/models.js.
export {
  db,
  load,
  flush,
  flushNow,
  persist,
  reset,
  readMeta,
  writeMeta,
  isEmpty,
  live,
  folderOf,
  assetContext,
  allAssets,
  assetsInFolder,
  assetsUnderFolder,
  folderSubtreeIds,
} from './db/store.js';
