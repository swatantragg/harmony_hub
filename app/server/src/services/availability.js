// How old an availability check may get before it counts as stale (see
// storage.staleness), and the rule the Drive mirror and reconciliation share for
// deciding whether a check that found nothing new is worth writing down.

export const STALE_AFTER_MS = 24 * 3_600_000;

// Moving a timestamp on a row that is otherwise unchanged still makes it dirty,
// and both passes used to stamp every row they looked at: the whole catalogue
// rewritten to MongoDB on every full walk. Half the stale window keeps every row
// fresh while writing an unchanged one at most twice a day.
const RESTAMP_AFTER_MS = STALE_AFTER_MS / 2;

/**
 * Records the outcome of a check on an asset. Leaves the row alone when the
 * outcome is the one already recorded and that record is recent. Returns
 * whether anything was written.
 */
export function setAvailability(asset, next) {
  const was = asset.availability;
  const unchanged = Boolean(was)
    && was.status === next.status
    && (was.detail ?? null) === (next.detail ?? null)
    && Date.now() - Date.parse(was.lastCheckedAt) < RESTAMP_AFTER_MS;
  if (unchanged) return false;
  asset.availability = next;
  return true;
}
