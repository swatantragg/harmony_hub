// ── Why this exists ─────────────────────────────────────────────────────────
// A file or folder put straight into Google Drive — from the Drive web UI, the
// desktop client or a phone — is adopted by the sync with a guessed type and a
// placeholder "Imported" tag. Nobody chose either, and nothing on screen said
// so: it looked exactly like a file somebody had uploaded and tagged properly.
//
// So an adopted row remembers where it came from, and carries a "New · from
// Drive" badge until a person has looked at it. Editing its details counts as
// that look, and so does saying outright that it is fine as it is.
//
// Only rows adopted from here on are marked. Everything the sync adopted before
// this existed is left as it was — flagging a whole back catalogue as "new"
// would make the badge mean nothing.

export const FROM_DRIVE = 'DRIVE';

/** Stamped onto a row at the moment it is adopted from Drive. */
export const arrivedFromDrive = () => ({ origin: FROM_DRIVE, reviewedAt: null, reviewedBy: null });

/** True while a row adopted from Drive is still waiting for a person. */
export const awaitingReview = (row) => row?.origin === FROM_DRIVE && !row.reviewedAt;

/** Marks a row reviewed. Returns whether anything changed. */
export function markReviewed(row, userId, now = new Date().toISOString()) {
  if (!awaitingReview(row)) return false;
  row.reviewedAt = now;
  row.reviewedBy = userId ?? null;
  return true;
}
