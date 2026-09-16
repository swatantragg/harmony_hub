/**
 * Share lifetime, in one place.
 *
 * A share link may have no expiry at all. That is stored as a null (or absent)
 * `expiresAt` rather than a date far in the future, so every screen and every
 * counter can say "never" honestly instead of "in 99 years". Revocation, not
 * time, is what ends such a link — and it is instant.
 */

/** True when this link has no expiry. Absent and null both mean never. */
export const neverExpires = (share) => share?.expiresAt == null;

/** True only when the link had an expiry and it has passed. */
export const hasExpired = (share) =>
  !neverExpires(share) && Date.parse(share.expiresAt) < Date.now();

/** Not revoked and not lapsed. What "active links" means everywhere. */
export const isLiveShare = (share) => !share?.revokedAt && !hasExpired(share);
