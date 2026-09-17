/**
 * What shipped, in the order it shipped.
 *
 * Read twice: once by the running app (to tell somebody what changed after a
 * reload), and once by the build (vite.config.ts writes the first entry into
 * dist/version.json so a *running* tab can describe an update it has not
 * loaded yet). Newest first — index 0 is the release being built.
 */
export interface ReleaseNote {
  /** Matches BUILD_TAG for that release. */
  version: string;
  /** ISO date, for display only. */
  date: string;
  headline: string;
  highlights: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: 'SK-V4.7.1',
    date: '2026-09-17',
    headline: 'Songs, artists and events are now tags you pick, not names you retype.',
    highlights: [
      'The tag picker has three new sections — Song, Artist and Event — filled from the Goongoonalo content sheets.',
      'Long sections are searched rather than scrolled, and anything already on the file stays pinned at the front.',
      'The Custom tag box can file a new tag into a section, so it joins that list for everyone instead of standing alone.',
    ],
  },
  {
    version: 'SK-V4.7.0',
    date: '2026-09-16',
    headline: 'Links that never lapse, results grouped by kind, and updates that announce themselves.',
    highlights: [
      'Share links can now be set to never expire — and revoking one is still instant, everywhere.',
      'Search groups its results: songs and audio first, then videos, images, documents and anything else.',
      'Folders, songs, share links, duplicates and people are all paged now, with a rows-per-page picker.',
      'The app tells you when a new version is live, says what changed, and reloads on one press.',
      'The master log has been retired — search and the folder views cover it.',
    ],
  },
];

export const CURRENT_RELEASE: ReleaseNote | null = RELEASE_NOTES[0] ?? null;

export const releaseFor = (version: string): ReleaseNote | null =>
  RELEASE_NOTES.find((r) => r.version === version) ?? null;
