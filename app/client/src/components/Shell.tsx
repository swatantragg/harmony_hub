import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Home, Search, Users, Disc3, UploadCloud, Share2, ShieldCheck, ScrollText,
  UserCog, HelpCircle, Bell, LogOut, Menu, Command, RotateCcw, Folder, Copy, UserCircle2,
  RefreshCw,
} from 'lucide-react';
import { Brandmark, ThemeToggle, useClickOutside, useToast } from './ui';
import { CommandPalette } from './CommandPalette';
import { Tour } from './Tour';
import { useSession, tour } from '../app/session';
import { api } from '../lib/api';
import { initials, relative } from '../lib/format';
import { BUILD_TAG } from '../lib/version';
import { useQueue } from '../features/upload/useUploadQueue';
import { describeSync, useDriveSync, useSyncOnFocus } from '../lib/sync';

interface NavEntry { to: string; label: string; icon: typeof Home; perm?: string; end?: boolean }

const PRIMARY: NavEntry[] = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/upload', label: 'Upload', icon: UploadCloud, perm: 'asset:upload' },
  { to: '/folders', label: 'Folders', icon: Folder },
  { to: '/shares', label: 'Share links', icon: Share2, perm: 'share:create' },
];
const LIBRARY: NavEntry[] = [
  { to: '/artists', label: 'Artists', icon: Users },
  { to: '/songs', label: 'Songs', icon: Disc3 },
  { to: '/dedupe', label: 'Duplicates', icon: Copy },
];
const ADMIN: NavEntry[] = [
  { to: '/admin/storage', label: 'Storage health', icon: ShieldCheck, perm: 'admin:storage' },
  { to: '/admin/activity', label: 'Activity log', icon: ScrollText, perm: 'admin:activity' },
  { to: '/admin/users', label: 'People', icon: UserCog, perm: 'admin:users' },
];

export function Shell() {
  const { user, logout, can } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [showTour, setShowTour] = useState(!tour.done());
  const queue = useQueue((s) => s.items);
  const uploading = queue.filter((i) => ['UPLOADING', 'FINALISING', 'HASHING'].includes(i.state)).length;

  // Files put straight into the Drive folder have no catalogue row until a sync
  // makes one, and until then the library cannot show them. The server syncs on a
  // timer and lazily behind library reads; this is the same pass on demand, plus
  // one whenever the tab is brought back to the front.
  const sync = useDriveSync({
    onDone: (summary) => {
      if (summary.changed > 0) {
        toast({ kind: 'ok', title: 'Synced with Google Drive', body: describeSync(summary) });
      }
    },
  });
  const syncSilently = useCallback(() => { if (!sync.isPending) sync.mutate(false); }, [sync.mutate, sync.isPending]);
  useSyncOnFocus(syncSilently);

  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [navOpen]);

  const { data: notifications } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotificationFeed>('/notifications'),
    refetchInterval: 20_000,
  });

  const { data: health } = useQuery({
    queryKey: ['health-nav'],
    queryFn: () => api<{ counts: { openFindings: number } }>('/dashboard'),
    enabled: can('admin:storage'),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); return; }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); setPaletteOpen(true); }
      if (e.key === '?') { e.preventDefault(); navigate('/help'); }
      if (e.key === 'u' && can('asset:upload')) { e.preventDefault(); navigate('/upload'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, can]);

  const item = (entry: NavEntry) => {
    if (entry.perm && !can(entry.perm)) return null;
    const Icon = entry.icon;
    const findings = entry.to === '/admin/storage' ? health?.counts.openFindings ?? 0 : 0;
    const badge = entry.to === '/upload' && uploading > 0 ? uploading : 0;
    return (
      <NavLink
        key={entry.to}
        to={entry.to}
        end={entry.end}
        className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        onClick={() => setNavOpen(false)}
      >
        <Icon size={17} />
        {entry.label}
        {findings > 0 && <span className="badge-count">{findings}</span>}
        {badge > 0 && <span className="badge-count neutral">{badge}</span>}
      </NavLink>
    );
  };

  return (
    <div className="shell">
      {navOpen && <div className="sidebar-scrim" onClick={() => setNavOpen(false)} aria-hidden />}
      <aside className={`sidebar ${navOpen ? 'open' : ''}`} data-tour="nav">
        <div className="sidebar-brand">
          <Brandmark />
        </div>

        <nav className="sidebar-nav">
          <div className="nav-group">{PRIMARY.map(item)}</div>
          <div className="nav-group">
            <div className="nav-group-label eyebrow">Library</div>
            {LIBRARY.map(item)}
          </div>
          {(can('admin:storage') || can('admin:activity') || can('admin:users')) && (
            <div className="nav-group">
              <div className="nav-group-label eyebrow">Administration</div>
              {ADMIN.map(item)}
            </div>
          )}
          <div className="nav-group">
            <div className="nav-group-label eyebrow">Getting started</div>
            <NavLink to="/help" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} data-tour="help" onClick={() => setNavOpen(false)}>
              <HelpCircle size={17} />
              How GCloud works
            </NavLink>
          </div>
        </nav>

        <div className="sidebar-foot">
          <UserMenu name={user?.name ?? ''} role={user?.role ?? ''} onLogout={async () => { await logout(); navigate('/login'); }} />
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost btn-icon topbar-menu" onClick={() => setNavOpen((v) => !v)} aria-label="Toggle navigation">
            <Menu size={18} />
          </button>

          <button
            className="searchbar grow topbar-search"
            data-tour="search"
            onClick={() => setPaletteOpen(true)}
          >
            <Search size={17} color="var(--ink-3)" />
            <span className="grow t-small truncate" style={{ fontWeight: 400, textAlign: 'left' }}>Search files, songs, artists…</span>
            <span className="kbd"><Command size={9} style={{ verticalAlign: -1 }} /> K</span>
          </button>

          <div className="grow" />

          {/* A large Drive takes a while to read. The spinner alone cannot say
              whether it is working or stuck, so the seconds are shown climbing. */}
          <button
            className={`btn btn-ghost ${sync.isPending ? 'btn-sm' : 'btn-icon'}`}
            onClick={() => sync.mutate(false)}
            disabled={sync.isPending}
            title={
              sync.isPending
                ? `Reading Google Drive — ${sync.elapsed} so far`
                : sync.lastSyncedAt
                  ? `Last checked ${relative(sync.lastSyncedAt)}. Click to check again.`
                  : 'Check Google Drive for anything added outside the app'
            }
            aria-label={sync.isPending ? `Syncing with Google Drive, ${sync.elapsed} elapsed` : 'Sync with Google Drive'}
            aria-live="polite"
          >
            <RefreshCw size={17} className={sync.isPending ? 'spin' : undefined} />
            {sync.isPending && (
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{sync.elapsed}</span>
            )}
          </button>

          <ThemeToggle />

          <NotificationBell
            feed={notifications}
            onNavigate={(to) => navigate(to)}
          />

          {can('asset:upload') && (
            <button className="btn btn-primary" data-tour="upload" onClick={() => navigate('/upload')} aria-label="Upload">
              <UploadCloud size={16} />
              <span className="hide-on-phone">Upload</span>
            </button>
          )}
        </header>

        <Outlet />

        <footer className="build-tag">{BUILD_TAG}</footer>
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {showTour && <Tour onDone={() => { setShowTour(false); toast({ kind: 'ok', title: 'You are set up', body: 'Press ⌘K any time, or open “How GCloud works” from the sidebar.' }); }} />}
    </div>
  );
}

function UserMenu({ name, role, onLogout }: { name: string; role: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside<HTMLDivElement>(() => setOpen(false));
  const navigate = useNavigate();
  const toast = useToast();

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {open && (
        <div className="panel" style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, right: 0, padding: 6, zIndex: 40 }}>
          <button className="nav-item" onClick={() => { navigate('/profile'); setOpen(false); }}>
            <UserCircle2 size={16} /> View profile
          </button>
          <button
            className="nav-item"
            onClick={() => { tour.reset(); toast({ kind: 'info', title: 'Tour reset', body: 'Reload the page to see the walkthrough again.' }); setOpen(false); }}
          >
            <RotateCcw size={16} /> Replay the tour
          </button>
          <button className="nav-item" onClick={() => { navigate('/help'); setOpen(false); }}>
            <HelpCircle size={16} /> How GCloud works
          </button>
          <button className="nav-item" onClick={onLogout} style={{ color: 'var(--danger)' }}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      )}
      <button className="nav-item" onClick={() => setOpen((v) => !v)} style={{ padding: 8 }}>
        <span
          style={{
            width: 30, height: 30, borderRadius: 9, background: 'var(--indigo-soft)', color: 'var(--indigo-deep)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14.5, fontWeight: 700, flex: 'none',
          }}
        >
          {initials(name)}
        </span>
        <span className="grow truncate" style={{ textAlign: 'left' }}>
          <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>{name}</span>
          <span className="t-small" style={{ fontSize: 13.5 }}>{role}</span>
        </span>
      </button>
    </div>
  );
}

interface NotificationRow {
  _id: string;
  title: string;
  body: string;
  level: string;
  link: string | null;
  category: string;
  createdAt: string;
  read: boolean;
  mine: boolean;
}

interface NotificationFeed {
  data: NotificationRow[];
  unread: number;
  counts: Record<string, number>;
  tabs: { key: string; label: string }[];
}

const DOT: Record<string, string> = {
  danger: 'var(--danger)',
  warn: 'var(--warn, var(--danger))',
  ok: 'var(--ok)',
};

/**
 * The notification panel.
 *
 * Tabs, because the four kinds want different attention and used to be one
 * undifferentiated list: what arrived in the library, what happened to a link
 * of yours, what happened to your account, and what is wrong with storage. The
 * server decides which tabs exist for this person and what goes in them — this
 * only renders what came back.
 */
function NotificationBell({
  feed, onNavigate,
}: {
  feed: NotificationFeed | undefined;
  onNavigate: (to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('all');
  const ref = useClickOutside<HTMLDivElement>(() => setOpen(false));
  const queryClient = useQueryClient();

  const tabs = feed?.tabs ?? [{ key: 'all', label: 'All' }];
  const counts = feed?.counts ?? {};
  const unread = feed?.unread ?? 0;

  const rows = (feed?.data ?? []).filter((n) => tab === 'all' || n.category === tab);

  const markRead = async (category: string) => {
    const pending = category === 'all' ? unread : (counts[category] ?? 0);
    if (!pending) return;
    await api('/notifications/read', { method: 'POST', body: { category } });
    await queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="btn btn-ghost btn-icon"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void markRead(tab);
        }}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        style={{ position: 'relative' }}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span style={{ position: 'absolute', top: 5, right: 5, width: 7, height: 7, borderRadius: '50%', background: 'var(--danger)' }} />
        )}
      </button>
      {open && (
        <div
          className="panel"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 40,
            width: 'min(380px, calc(100vw - 24px))', maxHeight: 'min(480px, 70vh)',
            display: 'flex', flexDirection: 'column',
          }}
        >
          <div className="panel-head"><span className="t-h3">Notifications</span></div>

          <div
            className="row"
            style={{
              gap: 4, padding: '8px 10px', borderBottom: '1px solid var(--edge)',
              overflowX: 'auto', flex: 'none',
            }}
            role="tablist"
          >
            {tabs.map((t) => {
              const n = counts[t.key] ?? 0;
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={active}
                  className={active ? 'btn btn-secondary' : 'btn btn-ghost'}
                  style={{ padding: '4px 10px', fontSize: 13, whiteSpace: 'nowrap', flex: 'none' }}
                  onClick={() => { setTab(t.key); void markRead(t.key); }}
                >
                  {t.label}
                  {n > 0 && (
                    <span
                      style={{
                        marginLeft: 6, fontSize: 11, fontWeight: 700, lineHeight: 1,
                        padding: '2px 5px', borderRadius: 999,
                        background: 'var(--danger)', color: '#fff',
                      }}
                    >
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div style={{ overflowY: 'auto' }}>
            {rows.length === 0 ? (
              <div style={{ padding: 22, textAlign: 'center' }} className="t-small">
                Nothing here.
              </div>
            ) : (
              rows.map((n) => (
                <button
                  key={n._id}
                  className="nav-item"
                  style={{
                    alignItems: 'flex-start', padding: '11px 14px', borderRadius: 0,
                    opacity: n.read ? 0.72 : 1,
                  }}
                  onClick={() => { setOpen(false); onNavigate(n.link || '/'); }}
                >
                  <span
                    style={{
                      width: 7, height: 7, borderRadius: '50%', marginTop: 6, flex: 'none',
                      background: DOT[n.level] ?? 'var(--indigo)',
                    }}
                  />
                  <span className="grow">
                    <span style={{ display: 'block', fontSize: 15, fontWeight: n.read ? 500 : 650, color: 'var(--ink)', whiteSpace: 'normal' }}>
                      {n.title}
                    </span>
                    <span className="t-small" style={{ display: 'block', fontWeight: 400, whiteSpace: 'normal' }}>{n.body}</span>
                    <span className="t-small" style={{ fontSize: 13.5 }}>{relative(n.createdAt)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
