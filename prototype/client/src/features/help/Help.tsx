// "How Maestro works" — the whole product explained in one scrollable page, in plain
// language, with no jargon and no assumed background. This is the single largest lever
// on the learning curve: anyone can read it in five minutes and then use everything.
import { Link } from 'react-router-dom';
import {
  Search, ShieldCheck, Pencil, UploadCloud, Share2, History, Trash2,
  Command, RotateCcw, Users,
} from 'lucide-react';
import { AvailabilityBadge, Brandmark, useToast } from '../../components/ui';
import { STATUS_COPY } from '../../lib/assetTypes';
import { tour } from '../../app/session';
import type { Availability } from '../../lib/types';

const STATUSES: Availability[] = ['AVAILABLE', 'UNVERIFIED', 'ARCHIVED', 'RESTORING', 'MISSING', 'MISMATCH'];

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
    icon: ShieldCheck,
    title: 'Every file proves it is really there',
    body: 'A catalogue entry saying a file exists is not the same as the file existing. Maestro checks the storage itself and shows the answer as a coloured badge on every card. Press “Verify now” on any file for a fresh answer in under a second — it reads only the file’s details, never its contents, so it is instant whether the file is 2 KB or 40 GB.',
  },
  {
    icon: Pencil,
    title: 'Renaming is instant and safe',
    body: 'The name people see and the place the file is stored are deliberately separate. Renaming changes only the name — no bytes move, no link breaks, no share stops working, and it takes the same time for a lyric sheet as for a feature film. The original filename it arrived with is kept forever as a record.',
  },
  {
    icon: UploadCloud,
    title: 'Uploads go straight to storage',
    body: 'Files travel from your browser directly into storage without passing through Maestro’s servers. Big files are split into chunks that upload four at a time; if one chunk fails it retries by itself, and you can pause and resume without losing progress.',
  },
  {
    icon: History,
    title: 'Versions live side by side',
    body: 'V1, V2 and Final are separate files that share a lineage, not overwrites. You can always open an earlier cut, and nothing is silently replaced.',
  },
  {
    icon: Share2,
    title: 'Sharing is controlled and reversible',
    body: 'A share link works without an account, expires on its own, can be capped by download count, and can be switched off instantly. Before handing anything over it confirms the file is still really in storage, and every open is recorded with time and IP.',
  },
  {
    icon: Trash2,
    title: 'Deleting has three levels',
    body: 'Removing a file puts it in a recycle bin for 30 days and leaves the stored copy alone. Only a permanent purge — which asks you to type the file’s name — actually destroys anything.',
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
          How Maestro works
        </h1>
        <p className="t-body" style={{ fontSize: 17, maxWidth: '58ch' }}>
          Maestro keeps every file made for a release — masters, covers, videos, reels, lyric sheets —
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
        <h2 className="t-h1" style={{ fontSize: 25, marginBottom: 8 }}>The six badges</h2>
        <p className="t-body" style={{ marginBottom: 18, maxWidth: '62ch' }}>
          This is the only vocabulary Maestro asks you to learn. Every file carries exactly one of
          these, everywhere it appears.
        </p>
        <div className="stack-3">
          {STATUSES.map((status) => (
            <div key={status} className="panel" data-status={status} style={{ borderLeft: '3px solid var(--st)' }}>
              <div className="panel-body">
                <div className="spread" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                  <AvailabilityBadge status={status} size="lg" />
                  <Link className="btn btn-ghost btn-sm" to={`/search?availability=${status}`}>
                    Show these files
                  </Link>
                </div>
                <p className="t-body" style={{ margin: 0, fontSize: 14 }}>{STATUS_COPY[status].meaning}</p>
                <p className="t-small" style={{ margin: '6px 0 0', fontWeight: 600, color: 'var(--st-ink)' }}>
                  What to do: {STATUS_COPY[status].next}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* First tasks */}
      <section>
        <h2 className="t-h1" style={{ fontSize: 25, marginBottom: 8 }}>Try these four things</h2>
        <p className="t-body" style={{ marginBottom: 18, maxWidth: '62ch' }}>
          Doing each one takes under a minute, and between them they cover almost everything you will
          ever do in Maestro.
        </p>
        <div className="stack-3">
          {[
            ['Find something', 'Search for an artist name, then narrow it with the Family filter on the left.', '/search?q=raju'],
            ['Prove a file exists', 'Open any file, then press “Verify now” in the panel at the top of the drawer.', '/search?availability=UNVERIFIED'],
            ['Rename a file', 'Open a file, press Rename, and watch the “downloads as” preview change while the stored location stays put.', '/search'],
            ['Share something', 'Open a file, press Share, pick 24 hours, and open the link that comes back in a new tab.', '/shares'],
          ].map(([title, body, to], i) => (
            <Link key={title} to={to} className="panel" style={{ display: 'block', textDecoration: 'none' }}>
              <div className="panel-body row" style={{ gap: 14 }}>
                <span
                  style={{
                    width: 28, height: 28, borderRadius: 9, flex: 'none', background: 'var(--spark-soft)',
                    color: 'var(--spark-deep)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 12,
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
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px,1fr))', gap: 18 }}>
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
            <p className="t-body" style={{ margin: 0, fontSize: 14 }}>
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
