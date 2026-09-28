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
    version: 'SK-V5.0.1',
    date: '2026-09-28',
    headline: 'Text now sizes itself to the device, and nothing needs scrolling sideways.',
    highlights: [
      'Type scales smoothly with the screen instead of stepping down once at 720px \u2014 a 360px phone and a 700px tablet no longer get the same size.',
      'The app now respects the default font size set in your browser or phone, which a fixed size had been overriding. That is why it read as too large on one device and too small on the next.',
      'Nothing scrolls sideways: wide images, long file ids and headings without spaces are all contained.',
      'Tapping a search or text field on an iPhone no longer zooms the page in and leaves it there.',
      'The update notice keeps its dismiss button on screen no matter how long the note is, and its text scrolls instead of the card growing past the top of the screen.',
      'Dialogs use the full width of a phone screen rather than 80% of it.',
      'Menus, the date picker and toasts fit within the narrowest screens.',
    ],
  },
  {
    version: 'SK-V5.0.0',
    date: '2026-09-28',
    headline: 'Tags can now be renamed and deleted across every file at once — and searching is four to seventeen times faster.',
    highlights: [
      'New: Manage tags, under Administration. Every tag by section, with the number of files carrying it beside it. Click one to see those files.',
      'Renaming a tag rewrites it on every file and folder at once, and settles two spellings of one tag into one. Deleting a tag takes it off everything \u2014 no file is deleted, moved or re-uploaded.',
      'Search now answers in 18\u201373ms where it took 259\u2013335ms. The folder lookup behind every result was scanning the whole folder list once per file \u2014 39 million comparisons for one search.',
      'Opening a screen no longer waits up to six seconds for a Drive sync. The sync still runs; the screen arrives first.',
      'The Song, Artist and Event tag lists are rebuilt straight from the content sheets: 133 songs, 98 artists, 12 events. Sixteen song titles carried an invisible character or a stray comma that made them a second tag matching nothing.',
      'Storage health\u2019s space bar now covers the whole allowance \u2014 what is used, then free space as its own labelled slice \u2014 instead of leaving the free space as an unlabelled gap.',
      'Search results can be paged by cursor, so a page no longer repeats or skips files while a Drive sync is changing the catalogue underneath it.',
      'The catalogue is measured rather than guessed: `npm run measure` reports its size, memory and search latency, and Storage health warns before it outgrows the current design.',
    ],
  },
  {
    version: 'SK-V4.8.1',
    date: '2026-09-28',
    headline: 'The Song, Artist and Event tag lists are rebuilt from the content sheets.',
    highlights: [
      'Six song titles carried an invisible trailing comma, which made them a second tag that matched nothing. Ten more carried a hidden character from the spreadsheet. Both are gone.',
      '133 songs, 98 artists and 12 events, generated straight from the sheets in doc/ rather than transcribed.',
      'The tag picker now says when the Song, Artist and Event lists are still loading, or failed to \u2014 before, it quietly showed two sections where there are five.',
    ],
  },
  {
    version: 'SK-V4.8.0',
    date: '2026-09-28',
    headline: 'Search is four to seventeen times faster, and the Drive space bar reads as free space.',
    highlights: [
      'Search now answers in 18\u201373ms where it took 259\u2013335ms \u2014 the folder lookup behind every result was scanning the whole folder list once per file.',
      'Opening a screen no longer waits up to six seconds for a Drive sync. The sync still runs; the screen arrives first.',
      'The bar on Storage health covers the whole allowance: every used slice, then free space as its own labelled slice.',
      'What the library itself takes up is shown again \u2014 it had been missing, so a full Drive could draw as an empty bar.',
      'Bin space is no longer counted twice, and each slice carries its own share of the allowance.',
    ],
  },
  {
    version: 'SK-V4.7.2',
    date: '2026-09-18',
    headline: 'Sign-in fixes: new accounts work straight away, and Google comes back to the right address.',
    highlights: [
      'Somebody added by an administrator can sign in immediately, on whichever instance answers them.',
      'A passcode now reaches every account that exists, rather than only the ones the answering instance had seen.',
      '"Continue with Google" returns to the address people actually visited.',
      'A deployment configured to talk to itself now refuses to start, instead of failing quietly at sign-in.',
    ],
  },
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
