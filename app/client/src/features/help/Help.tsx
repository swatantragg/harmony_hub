// "How GCloud works" — the whole product explained in one scrollable page, in plain
// language, with no jargon and no assumed background. This is the single largest lever
// on the learning curve: anyone can read it in five minutes and then use everything.
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import {
  Search, ShieldCheck, Pencil, UploadCloud, Share2, History, Trash2,
  Command, RotateCcw, Users, Globe, PenLine, UserCheck, Eye, Link2, Table2,
} from 'lucide-react';
import { AvailabilityBadge, Brandmark, useToast } from '../../components/ui';
import { STATUS_COPY } from '../../lib/assetTypes';
import { tour } from '../../app/session';
import type { Availability } from '../../lib/types';

const STATUSES: Availability[] = ['AVAILABLE', 'UNVERIFIED', 'TRASHED', 'RESTORING', 'MISSING', 'MISMATCH'];

const CONCEPTS = [
  {
    icon: Users,
    title: 'Artists hold songs. Songs hold files.',
    body: 'That is the entire structure. There are no folders to organise, no naming conventions to remember, and nothing to file in the right place. Attach a file to a song and describe it — everything else is search.',
  },
  {
    icon: Search,
    title: 'Search returns files, not folders',
    body: 'One box covers every filename, song, artist and tag. A search for “punjabi reels tagged viral” gives you those exact clips, each one showing which song and artist it came from. Filters on the left narrow it further, and the number beside each filter tells you how many files would remain.',
  },
  {
    icon: Table2,
    title: 'The master log is the register of everything',
    body: 'Search is for finding one file. The master log is for seeing all of them at once — one row per file, sixty-nine possible columns, and every one of them filterable and sortable. Language is asked for on audio and video at upload; artwork and paperwork inherit theirs from the release they belong to. Pick the columns you need (there are named presets for a delivery sheet, a storage audit and a chain of custody), narrow it however you like, and export exactly what is on screen to Excel or CSV. The workbook carries roll-ups by artist, type and folder, and a final sheet recording precisely which filters produced it.',
  },
  {
    icon: ShieldCheck,
    title: 'Every file proves it is really there',
    body: 'A catalogue entry saying a file exists is not the same as the file existing. GCloud checks the storage itself and shows the answer as a coloured badge on every card. Press “Verify now” on any file for a fresh answer in under a second — it reads only the file’s details, never its contents, so it is instant whether the file is 2 KB or 40 GB.',
  },
  {
    icon: Pencil,
    title: 'Renaming is instant and safe',
    body: 'The name people see and the place the file is stored are deliberately separate. Renaming changes only the name — no bytes move, no link breaks, no share stops working, and it takes the same time for a lyric sheet as for a feature film. The original filename it arrived with is kept forever as a record.',
  },
  {
    icon: UploadCloud,
    title: 'Uploads go straight to storage',
    body: 'Files travel from your browser directly into storage without passing through the GCloud API. Big files are split into chunks that upload four at a time; if one chunk fails it retries by itself, and you can pause and resume without losing progress.',
  },
  {
    icon: History,
    title: 'Versions live side by side',
    body: 'V1, V2 and Final are separate files that share a lineage, not overwrites. You can always open an earlier cut, and nothing is silently replaced.',
  },
  {
    icon: Share2,
    title: 'Sharing is controlled and reversible',
    body: 'A link can go to anyone, to signed-in editors, or to named people only. It expires on its own, can be capped by download count, and can be switched off instantly. Before handing anything over it confirms the file is still really in storage, and every open is recorded with time and IP.',
  },
  {
    icon: Trash2,
    title: 'Deleting has two buttons, and only one is permanent',
    body: 'Delete puts a file in the recycle bin for 30 days and leaves the stored copy exactly where it was. Purge — Admin only, and it asks you to type the file’s name — is the one that destroys the object. Deleting a folder deletes nothing at all.',
  },
];

// The three kinds of link, spelled out where someone will look for them.
const LINK_TYPES = [
  {
    icon: Globe,
    title: 'Open to all',
    who: 'Anyone holding the link',
    body: 'No account, no sign-in, no GCloud login screen. This is the link for press, DSPs, sync agencies and anyone outside the company. Control comes from the expiry, the download cap and the revoke button — not from who the visitor is.',
  },
  {
    icon: PenLine,
    title: 'Editor',
    who: 'Signed-in GCloud accounts that can edit',
    body: 'The visitor is sent to sign in first. Once in, the file opens with editing rights — rename, re-tag, replace — not just a download button. An account without edit rights is refused even with the correct link.',
  },
  {
    icon: UserCheck,
    title: 'Specific allocation',
    who: 'Only the email addresses you name',
    body: 'The visitor signs in, and the link resolves only if their account email is on the list attached to it. Forwarding it to anyone else achieves nothing. Every open is logged against the person by name rather than as “external partner”.',
  },
];

const DELETE_LEVELS = [
  {
    tone: 'warn' as const,
    label: 'Delete',
    where: 'On any file · Admin and Editor',
    api: 'DELETE /api/assets/{id}',
    what: 'Moves the file to the bin, here and in Google Drive.',
    points: [
      'The Drive file is trashed rather than deleted — every byte is still there and still recoverable.',
      'The catalogue record keeps everything; a deletedAt date is set on it and nothing else.',
      'The file leaves search, its song page and its folder immediately.',
      'Share links pointing at it stop resolving while it is in the bin.',
      'Recoverable for 30 days from either side — GCloud or drive.google.com. After that Google deletes it for good.',
      'It still occupies Drive quota until that happens. Emptying the bin from the Duplicates page frees it immediately.',
    ],
  },
  {
    tone: 'danger' as const,
    label: 'Purge permanently',
    where: 'On any file · Admin only',
    api: 'DELETE /api/assets/{id}/purge',
    what: 'Destroys the Drive file and the record together.',
    points: [
      'The Google Drive file is deleted outright — it skips the bin, and every past revision goes with it.',
      'The catalogue record is removed outright, not flagged.',
      'Every share link to the file is deleted with it.',
      'You must type the file’s exact name to confirm; nothing here or in Google Drive undoes it.',
    ],
  },
  {
    tone: 'ok' as const,
    label: 'Remove folder',
    where: 'On any folder · Admin and Editor',
    api: 'DELETE /api/folders/{id}',
    what: 'Deletes the folder. Deletes no files.',
    points: [
      'Every file inside is moved back to the library root, in GCloud and in Google Drive together.',
      'Moving a file between Drive folders re-parents it — no bytes are copied, however large it is.',
      'Only the emptied folder is trashed. The activity log records how many files were released.',
    ],
  },
];

const SHORTCUTS: [string, string][] = [
  ['⌘K  /  Ctrl-K', 'Open the command bar — jump to any screen or file'],
  ['/', 'Same thing, one keystroke'],
  ['U', 'Go to uploads'],
  ['?', 'Open this page'],
  ['Esc', 'Close whatever is open'],
];

export function Help() {
  const toast = useToast();

  return (
    <div className="page stack-5" style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div style={{ marginBottom: 20 }}><Brandmark size="lg" /></div>
        <h1 className="t-display" style={{ fontSize: 'clamp(30px,4vw,44px)', marginBottom: 14 }}>
          How GCloud works
        </h1>
        <p className="t-body" style={{ fontSize: 18.5, maxWidth: '58ch' }}>
          GCloud keeps every file made for a release — masters, covers, videos, reels, lyric sheets —
          in one place that can be searched, versioned and shared. Five minutes here and you will know
          everything the product does.
        </p>
      </div>

      {/* Concepts */}
      <section className="stack-3">
        {CONCEPTS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="panel">
            <div className="panel-body" style={{ display: 'flex', gap: 16 }}>
              <span
                style={{
                  width: 40, height: 40, borderRadius: 12, flex: 'none',
                  background: 'var(--indigo-soft)', color: 'var(--indigo)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Icon size={19} />
              </span>
              <div>
                <h2 className="t-h2" style={{ marginBottom: 6 }}>{title}</h2>
                <p className="t-body" style={{ margin: 0, maxWidth: '66ch' }}>{body}</p>
              </div>
            </div>
          </div>
        ))}
      </section>

      {/* The badge system — the one thing worth memorising */}
      <section>
        <h2 className="t-h1" style={{ fontSize: 26, marginBottom: 8 }}>The six badges</h2>
        <p className="t-body" style={{ marginBottom: 18, maxWidth: '62ch' }}>
          This is the only vocabulary GCloud asks you to learn. Every file carries exactly one of
          these, everywhere it appears.
        </p>
        <div className="stack-3">
          {STATUSES.map((status) => (
            <div key={status} className="panel" data-status={status} style={{ borderLeft: '3px solid var(--st)' }}>
              <div className="panel-body">
                <div className="spread" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                  <AvailabilityBadge status={status} size="lg" />
                  <Link className="btn btn-ghost btn-sm" to={`/?availability=${status}`}>
                    Show these files
                  </Link>
                </div>
                <p className="t-body" style={{ margin: 0, fontSize: 16 }}>{STATUS_COPY[status].meaning}</p>
                <p className="t-small" style={{ margin: '6px 0 0', fontWeight: 600, color: 'var(--st-ink)' }}>
                  What to do: {STATUS_COPY[status].next}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Sharing — the three kinds of link, and what the link actually is */}
      <section>
        <h2 className="t-h1" style={{ fontSize: 26, marginBottom: 8 }}>Three kinds of share link</h2>
        <p className="t-body" style={{ marginBottom: 18, maxWidth: '64ch' }}>
          You choose who a link is for when you create it, on a single file or on a whole folder.
          Every rule below is enforced by the server on every open — never by the page the visitor sees.
        </p>
        <div className="stack-3">
          {LINK_TYPES.map(({ icon: Icon, title, who, body }) => (
            <div key={title} className="panel">
              <div className="panel-body" style={{ display: 'flex', gap: 16 }}>
                <span
                  style={{
                    width: 40, height: 40, borderRadius: 12, flex: 'none',
                    background: 'var(--indigo-soft)', color: 'var(--indigo)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Icon size={19} />
                </span>
                <div>
                  <h3 className="t-h2" style={{ marginBottom: 2 }}>{title}</h3>
                  <div className="eyebrow" style={{ marginBottom: 7 }}>{who}</div>
                  <p className="t-body" style={{ margin: 0, maxWidth: '66ch' }}>{body}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="note indigo" style={{ marginTop: 16 }}>
          <Link2 size={15} />
          <div>
            <b>What the link actually is.</b> A GCloud address — <span className="t-mono">/#/s/&lt;token&gt;</span> — never
            a Google Drive address. It carries a random token and nothing else: no file id, no folder, no
            account. When someone opens it, GCloud re-checks the expiry, the revocation, the download
            cap, who the visitor is, and whether the file is still really in Drive. Only then does it mint a
            second signed link, good for minutes, that streams the bytes.
            <br /><br />
            The important part is what it does <i>not</i> do: it never changes the file&rsquo;s sharing
            settings in Google Drive. Nothing is ever made &ldquo;anyone with the link can view&rdquo;. That
            is why revoking works here and does not work when you paste a Drive link into an email — a
            Google sharing permission stays granted until somebody remembers to take it away, and this
            expires on its own.
          </div>
        </div>

        <div className="note" style={{ marginTop: 12 }}>
          <Eye size={15} />
          <div>
            <b>Look before you send.</b> Every file previews in the page — audio, video, images, PDFs,
            spreadsheets, Word documents, slides, CSVs and plain text — both for you before sharing and
            for the recipient before downloading. Folder links show the file list beside the viewer, so a
            recipient can go through the whole kit without downloading any of it.
          </div>
        </div>
      </section>

      {/* Deleting — the two buttons, and the folder case */}
      <section>
        <h2 className="t-h1" style={{ fontSize: 26, marginBottom: 8 }}>The delete buttons</h2>
        <p className="t-body" style={{ marginBottom: 18, maxWidth: '64ch' }}>
          There are two on a file and one on a folder. Only the middle one destroys anything, and it is
          the only one that asks you to type a name.
        </p>
        <div className="stack-3">
          {DELETE_LEVELS.map(({ tone, label, where, api, what, points }) => (
            <div key={label} className="panel">
              <div className="panel-body">
                <div className="spread" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                  <span className="row-tight">
                    <Trash2 size={15} color={tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--ok)'} />
                    <span className="t-h3">{label}</span>
                  </span>
                  <span className="t-small">{where}</span>
                </div>
                <p className="t-body" style={{ margin: '0 0 8px', fontWeight: 600 }}>{what}</p>
                <ul className="t-body" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.75, fontSize: 16 }}>
                  {points.map((point) => <li key={point}>{point}</li>)}
                </ul>
                <div className="keytext" style={{ marginTop: 10, display: 'inline-block' }}>{api}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* First tasks */}
      <section>
        <h2 className="t-h1" style={{ fontSize: 26, marginBottom: 8 }}>Try these four things</h2>
        <p className="t-body" style={{ marginBottom: 18, maxWidth: '62ch' }}>
          Doing each one takes under a minute, and between them they cover almost everything you will
          ever do in GCloud.
        </p>
        <div className="stack-3">
          {[
            ['Find something', 'Search for an artist name, then narrow it with the Family filter on the left.', '/?q=raju'],
            ['Prove a file exists', 'Open any file, then press “Verify now” in the panel at the top of the drawer.', '/?availability=UNVERIFIED'],
            ['Rename a file', 'Open a file, press Rename, and watch the “downloads as” preview change while the stored location stays put.', '/'],
            ['Share something', 'Open a file, press Share, pick 24 hours, and open the link that comes back in a new tab.', '/shares'],
          ].map(([title, body, to], i) => (
            <Link key={title} to={to} className="panel" style={{ display: 'block', textDecoration: 'none' }}>
              <div className="panel-body row" style={{ gap: 14 }}>
                <span
                  style={{
                    width: 28, height: 28, borderRadius: 9, flex: 'none', background: 'var(--spark-soft)',
                    color: 'var(--spark-deep)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14.5,
                  }}
                >
                  {i + 1}
                </span>
                <span className="grow">
                  <span className="t-h3" style={{ display: 'block', color: 'var(--ink)' }}>{title}</span>
                  <span className="t-small" style={{ fontWeight: 400, whiteSpace: 'normal' }}>{body}</span>
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Shortcuts */}
      <section className="auto-grid" style={{ '--min': '290px' } as CSSProperties}>
        <div className="panel">
          <div className="panel-head"><span className="t-h3 row-tight"><Command size={15} color="var(--ink-3)" /> Keyboard shortcuts</span></div>
          <div className="panel-body stack-2">
            {SHORTCUTS.map(([key, what]) => (
              <div key={key} className="spread">
                <span className="kbd">{key}</span>
                <span className="t-small" style={{ textAlign: 'right' }}>{what}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><span className="t-h3">Still stuck?</span></div>
          <div className="panel-body stack-3">
            <p className="t-body" style={{ margin: 0, fontSize: 16 }}>
              Every screen explains itself as you go, and the small <span className="help" style={{ display: 'inline-flex' }}>?</span> marks
              give a one-line explanation wherever a term might be unfamiliar.
            </p>
            <button
              className="btn btn-secondary btn-block"
              onClick={() => {
                tour.reset();
                toast({ kind: 'info', title: 'Tour reset', body: 'Reload the page and the walkthrough starts again.' });
              }}
            >
              <RotateCcw size={14} /> Replay the walkthrough
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
