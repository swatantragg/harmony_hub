// ⌘K / Ctrl-K — one keystroke to anything. A new user learns the whole navigation model
// from this list, which is why every destination carries a plain-language description.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Search, Home, Users, Disc3, UploadCloud, Share2, ShieldCheck,
  ScrollText, UserCog, Music4, FileAudio, CornerDownLeft, HelpCircle, Folder, Tag,
} from 'lucide-react';
import { api, qs } from '../lib/api';
import { useDebounced, AvailabilityBadge } from './ui';
import { useSession } from '../app/session';
import type { Availability } from '../lib/types';

interface Quick {
  assets: { assetId: string; displayName: string; type: string; family: string; songTitle: string; status: Availability }[];
  tags: { name: string; count: number }[];
  folders: { _id: string; name: string; tags: string[]; assetCount: number }[];
  songs: { _id: string; title: string; artistName: string; assetCount: number }[];
  artists: { _id: string; name: string; genre: string }[];
}

const DESTINATIONS = [
  { to: '/', label: 'Home', hint: 'Search, storage health and what changed recently', icon: Home, perm: null },
  { to: '/search', label: 'Search the library', hint: 'Every asset, filtered by type, family, tag or availability', icon: Search, perm: null },
  { to: '/artists', label: 'Artists', hint: 'Profiles, discography and image galleries', icon: Users, perm: null },
  { to: '/songs', label: 'Songs', hint: 'Releases and the assets attached to each', icon: Disc3, perm: null },
  { to: '/folders', label: 'Folders', hint: 'Grouped files — launch kits, shoots, paperwork', icon: Folder, perm: null },
  { to: '/upload', label: 'Upload assets', hint: 'Drop files, tag them, watch each part land in storage', icon: UploadCloud, perm: 'asset:upload' },
  { to: '/shares', label: 'Share links', hint: 'Active external links, expiry and download counts', icon: Share2, perm: 'share:create' },
  { to: '/admin/storage', label: 'Storage health', hint: 'Drift between the catalogue and the bucket', icon: ShieldCheck, perm: 'admin:storage' },
  { to: '/admin/activity', label: 'Activity log', hint: 'Who did what, to which file, and when', icon: ScrollText, perm: 'admin:activity' },
  { to: '/admin/users', label: 'People and roles', hint: 'Accounts and what each role may do', icon: UserCog, perm: 'admin:users' },
  { to: '/help', label: 'How GCloud works', hint: 'A five-minute tour of the whole product', icon: HelpCircle, perm: null },
];

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [quick, setQuick] = useState<Quick>({ assets: [], tags: [], folders: [], songs: [], artists: [] });
  const debounced = useDebounced(q, 200);
  const navigate = useNavigate();
  const can = useSession((s) => s.can);

  useEffect(() => {
    if (!debounced.trim()) { setQuick({ assets: [], tags: [], folders: [], songs: [], artists: [] }); return; }
    let alive = true;
    api<Quick>(`/search/quick${qs({ q: debounced })}`)
      .then((r) => alive && setQuick(r))
      .catch(() => {});
    return () => { alive = false; };
  }, [debounced]);

  const destinations = useMemo(
    () => DESTINATIONS
      .filter((d) => !d.perm || can(d.perm))
      .filter((d) => !q.trim() || `${d.label} ${d.hint}`.toLowerCase().includes(q.toLowerCase())),
    [q, can],
  );

  const rows = useMemo(() => [
    ...destinations.map((d) => ({ kind: 'go' as const, key: d.to, go: () => navigate(d.to), payload: d })),
    ...quick.tags.map((t) => ({ kind: 'tag' as const, key: `tag-${t.name}`, go: () => navigate(`/search?tags=${encodeURIComponent(t.name)}`), payload: t })),
    ...quick.assets.map((a) => ({ kind: 'asset' as const, key: a.assetId, go: () => navigate(`/search?asset=${a.assetId}`), payload: a })),
    ...quick.folders.map((f) => ({ kind: 'folder' as const, key: f._id, go: () => navigate(`/folders/${f._id}`), payload: f })),
    ...quick.songs.map((s) => ({ kind: 'song' as const, key: s._id, go: () => navigate(`/songs/${s._id}`), payload: s })),
    ...quick.artists.map((a) => ({ kind: 'artist' as const, key: a._id, go: () => navigate(`/artists/${a._id}`), payload: a })),
  ], [destinations, quick, navigate]);

  useEffect(() => setCursor(0), [rows.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, rows.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (rows[cursor]) { rows[cursor].go(); onClose(); }
        else if (q.trim()) { navigate(`/search?q=${encodeURIComponent(q)}`); onClose(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, cursor, onClose, navigate, q]);

  let index = -1;
  const nextIndex = () => { index += 1; return index; };

  const section = (label: string) => (
    <div className="palette-section eyebrow">{label}</div>
  );

  return createPortal(
    <div className="scrim" style={{ paddingTop: '10vh' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal aria-label="Command palette">
        <div className="palette-input">
          <Search size={19} color="var(--ink-3)" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search files, songs, artists — or jump to a screen"
            aria-label="Search or jump to"
          />
          <span className="kbd">esc</span>
        </div>

        <div className="palette-list">
          {destinations.length > 0 && section('Go to')}
          {destinations.map((d) => {
            const i = nextIndex();
            const Icon = d.icon;
            return (
              <button key={d.to} className={`palette-item ${i === cursor ? 'cursor' : ''}`} onMouseEnter={() => setCursor(i)} onClick={() => { navigate(d.to); onClose(); }}>
                <Icon size={16} color="var(--ink-3)" />
                <span className="grow">
                  <span style={{ fontWeight: 600 }}>{d.label}</span>
                  <span className="t-small" style={{ display: 'block', fontWeight: 400 }}>{d.hint}</span>
                </span>
                {i === cursor && <CornerDownLeft size={14} color="var(--ink-3)" />}
              </button>
            );
          })}

          {quick.tags.length > 0 && section('Tags')}
          {quick.tags.map((t) => {
            const i = nextIndex();
            return (
              <button key={t.name} className={`palette-item ${i === cursor ? 'cursor' : ''}`} onMouseEnter={() => setCursor(i)} onClick={() => { navigate(`/search?tags=${encodeURIComponent(t.name)}`); onClose(); }}>
                <Tag size={16} color="var(--ink-3)" />
                <span className="grow">
                  <span style={{ fontWeight: 600 }}>{t.name}</span>
                  <span className="t-small" style={{ display: 'block', fontWeight: 400 }}>Show every file tagged this</span>
                </span>
                <span className="t-small" style={{ fontFamily: 'var(--mono)' }}>{t.count}</span>
              </button>
            );
          })}

          {quick.assets.length > 0 && section('Files')}
          {quick.assets.map((a) => {
            const i = nextIndex();
            return (
              <button key={a.assetId} className={`palette-item ${i === cursor ? 'cursor' : ''}`} onMouseEnter={() => setCursor(i)} onClick={() => { navigate(`/search?asset=${a.assetId}`); onClose(); }}>
                <FileAudio size={16} color="var(--ink-3)" />
                <span className="grow truncate">
                  <span style={{ fontWeight: 600 }}>{a.displayName}</span>
                  <span className="t-small" style={{ display: 'block', fontWeight: 400 }}>{a.type} · {a.songTitle}</span>
                </span>
                <AvailabilityBadge status={a.status} />
              </button>
            );
          })}

          {quick.folders.length > 0 && section('Folders')}
          {quick.folders.map((f) => {
            const i = nextIndex();
            return (
              <button key={f._id} className={`palette-item ${i === cursor ? 'cursor' : ''}`} onMouseEnter={() => setCursor(i)} onClick={() => { navigate(`/folders/${f._id}`); onClose(); }}>
                <Folder size={16} color="var(--ink-3)" />
                <span className="grow">
                  <span style={{ fontWeight: 600 }}>{f.name}</span>
                  <span className="t-small" style={{ display: 'block', fontWeight: 400 }}>
                    {f.assetCount} {f.assetCount === 1 ? 'file' : 'files'}{f.tags.length ? ` · ${f.tags.join(', ')}` : ''}
                  </span>
                </span>
              </button>
            );
          })}

          {quick.songs.length > 0 && section('Songs')}
          {quick.songs.map((s) => {
            const i = nextIndex();
            return (
              <button key={s._id} className={`palette-item ${i === cursor ? 'cursor' : ''}`} onMouseEnter={() => setCursor(i)} onClick={() => { navigate(`/songs/${s._id}`); onClose(); }}>
                <Music4 size={16} color="var(--ink-3)" />
                <span className="grow">
                  <span style={{ fontWeight: 600 }}>{s.title}</span>
                  <span className="t-small" style={{ display: 'block', fontWeight: 400 }}>{s.artistName} · {s.assetCount} assets</span>
                </span>
              </button>
            );
          })}

          {quick.artists.length > 0 && section('Artists')}
          {quick.artists.map((a) => {
            const i = nextIndex();
            return (
              <button key={a._id} className={`palette-item ${i === cursor ? 'cursor' : ''}`} onMouseEnter={() => setCursor(i)} onClick={() => { navigate(`/artists/${a._id}`); onClose(); }}>
                <Users size={16} color="var(--ink-3)" />
                <span className="grow">
                  <span style={{ fontWeight: 600 }}>{a.name}</span>
                  <span className="t-small" style={{ display: 'block', fontWeight: 400 }}>{a.genre}</span>
                </span>
              </button>
            );
          })}

          {rows.length === 0 && (
            <div style={{ padding: '26px 16px', textAlign: 'center' }} className="t-small">
              Nothing matched “{q}”. Press <span className="kbd">enter</span> to search the full library.
            </div>
          )}
        </div>

        <div className="palette-foot t-small">
          <span><span className="kbd">↑</span> <span className="kbd">↓</span> move</span>
          <span><span className="kbd">enter</span> open</span>
          <span><span className="kbd">esc</span> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
