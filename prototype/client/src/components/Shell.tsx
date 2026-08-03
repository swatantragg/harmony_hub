import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Home, Search, Users, Disc3, UploadCloud, Share2, ShieldCheck, ScrollText,
  UserCog, HelpCircle, Bell, LogOut, Menu, Command, RotateCcw, Folder,
} from 'lucide-react';
import { Brandmark, ThemeToggle, useClickOutside, useToast } from './ui';
import { CommandPalette } from './CommandPalette';
import { Tour } from './Tour';
import { useSession, tour } from '../app/session';
import { api } from '../lib/api';
import { initials, relative } from '../lib/format';
import { useQueue } from '../features/upload/useUploadQueue';

interface NavEntry { to: string; label: string; icon: typeof Home; perm?: string; end?: boolean }

const PRIMARY: NavEntry[] = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/search', label: 'Search', icon: Search },
];
const LIBRARY: NavEntry[] = [
  { to: '/artists', label: 'Artists', icon: Users },
  { to: '/songs', label: 'Songs', icon: Disc3 },
  { to: '/folders', label: 'Folders', icon: Folder },
  { to: '/upload', label: 'Upload', icon: UploadCloud, perm: 'asset:upload' },
  { to: '/shares', label: 'Share links', icon: Share2, perm: 'share:create' },
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

  // Off-canvas navigation, on a phone, has to behave like every other off-canvas menu:
  // it closes when the route changes, when Escape is pressed, and when anything outside
  // it is tapped. The page behind it must not scroll while it is open.
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
    queryFn: () => api<{ data: { _id: string; title: string; body: string; level: string; createdAt: string; readAt: string | null }[]; unread: number }>('/notifications'),
    refetchInterval: 20_000,
  });

  const { data: health } = useQuery({
    queryKey: ['health-nav'],
    queryFn: () => api<{ counts: { openFindings: number } }>('/dashboard'),
    enabled: can('admin:storage'),
    refetchInterval: 60_000,
  });

  // Global shortcuts. Discoverable via the "?" panel and the palette footer.
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

          <ThemeToggle />

          <NotificationBell
            items={notifications?.data ?? []}
            unread={notifications?.unread ?? 0}
            onOpenStorage={() => navigate('/admin/storage')}
          />

          {/* Indigo, not spark: the brand keeps one warm signal per view, and each page
              spends it on its own most important action. */}
          {can('asset:upload') && (
            <button className="btn btn-primary" data-tour="upload" onClick={() => navigate('/upload')} aria-label="Upload">
              <UploadCloud size={16} />
              <span className="hide-on-phone">Upload</span>
            </button>
          )}
        </header>

        <Outlet />

        {/* Build marker. Sits under every overlay and ignores pointer events so it can
            never intercept a click. */}
        <div className="build-tag" aria-hidden>SK-V2.2</div>
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
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flex: 'none',
          }}
        >
          {initials(name)}
        </span>
        <span className="grow truncate" style={{ textAlign: 'left' }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{name}</span>
          <span className="t-small" style={{ fontSize: 11 }}>{role}</span>
        </span>
      </button>
    </div>
  );
}

function NotificationBell({
  items, unread, onOpenStorage,
}: {
  items: { _id: string; title: string; body: string; level: string; createdAt: string; readAt: string | null }[];
  unread: number;
  onOpenStorage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside<HTMLDivElement>(() => setOpen(false));

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="btn btn-ghost btn-icon"
        onClick={async () => { setOpen((v) => !v); if (unread) await api('/notifications/read', { method: 'POST' }); }}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        style={{ position: 'relative' }}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span style={{ position: 'absolute', top: 5, right: 5, width: 7, height: 7, borderRadius: '50%', background: 'var(--danger)' }} />
        )}
      </button>
      {open && (
        <div className="panel" style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 330, zIndex: 40, maxHeight: 420, overflowY: 'auto' }}>
          <div className="panel-head"><span className="t-h3">Notifications</span></div>
          {items.length === 0 ? (
            <div style={{ padding: 22, textAlign: 'center' }} className="t-small">Nothing needs your attention.</div>
          ) : (
            items.map((n) => (
              <button
                key={n._id}
                className="nav-item"
                style={{ alignItems: 'flex-start', padding: '11px 14px', borderRadius: 0 }}
                onClick={() => { setOpen(false); onOpenStorage(); }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', marginTop: 6, flex: 'none', background: n.level === 'danger' ? 'var(--danger)' : n.level === 'ok' ? 'var(--ok)' : 'var(--indigo)' }} />
                <span className="grow">
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{n.title}</span>
                  <span className="t-small" style={{ display: 'block', fontWeight: 400, whiteSpace: 'normal' }}>{n.body}</span>
                  <span className="t-small" style={{ fontSize: 11 }}>{relative(n.createdAt)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
