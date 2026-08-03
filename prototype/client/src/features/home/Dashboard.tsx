// Search-first home. The prominent search bar comes first, the honest storage picture
// second, and what changed recently third — in that order, because that is the order a
// person actually needs them.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Search, ArrowRight, ShieldCheck, UploadCloud, Users, Disc3, Share2, Clock,
  AlertTriangle, Sparkles,
} from 'lucide-react';
import { api } from '../../lib/api';
import { AvailabilityBadge, CardSkeletons, HelpTip } from '../../components/ui';
import { AssetCard } from '../assets/AssetCard';
import { AssetDrawer } from '../assets/AssetDrawer';
import { bytes, pluralise, relative } from '../../lib/format';
import { ACTION_COPY, STATUS_COPY } from '../../lib/assetTypes';
import type { Dashboard as DashboardData, Availability } from '../../lib/types';
import { useSession, useSeen } from '../../app/session';

const QUICK_FILTERS = [
  { label: 'Master audio', to: '/search?type=Master+Audio' },
  { label: 'Reels', to: '/search?type=Reel+-+BTS%2FMV' },
  { label: 'Cover art', to: '/search?family=Image' },
  { label: 'Added this month', to: '/search?sort=newest' },
  { label: 'Needs checking', to: '/search?availability=UNVERIFIED' },
];

export function Dashboard() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const { user } = useSession();
  const [dismissed, dismiss] = useSeen('home-intro');

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<DashboardData>('/dashboard'),
  });

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(`/search${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="page stack-5">
      {/* ── Hero search ─────────────────────────────────────────────────── */}
      <section>
        <div className="eyebrow" style={{ marginBottom: 10 }}>
          {greeting}, {data?.greetingName ?? user?.name.split(' ')[0]} · signed in as {user?.role}
        </div>
        <h1 className="t-display" style={{ fontSize: 'clamp(30px, 4vw, 46px)', marginBottom: 16 }}>
          What are you looking for?
        </h1>

        <form onSubmit={go} data-tour="search" style={{ maxWidth: 680 }}>
          <div className="searchbar lg">
            <Search size={20} color="var(--ink-3)" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Try “dil se reels”, a filename, an artist, or an ISRC"
              aria-label="Search the library"
            />
            {/* The label goes on a phone; the icon and the target stay, which leaves the
                placeholder enough room not to be cut mid-word. */}
            <button className="btn btn-primary btn-sm" type="submit" aria-label="Search">
              <Search size={15} />
              <span className="hide-on-phone">Search</span>
            </button>
          </div>
        </form>

        <div className="wrap-gap" style={{ marginTop: 14 }}>
          {QUICK_FILTERS.map((f) => (
            <Link key={f.label} className="chip" to={f.to}>{f.label}</Link>
          ))}
        </div>

        {!dismissed && (
          <div className="note indigo" style={{ marginTop: 18, maxWidth: 760 }}>
            <Sparkles size={15} />
            <div className="grow">
              <b>New here?</b> Search returns individual files, not folders. Every file carries a
              badge saying whether it is genuinely in storage right now — that badge is the heart of
              GCloud. Open <Link to="/help">How GCloud works</Link> for a five-minute walkthrough.
            </div>
            <button className="btn btn-ghost btn-sm" onClick={dismiss}>Got it</button>
          </div>
        )}
      </section>

      {/* ── Counts + storage health ─────────────────────────────────────── */}
      <section className="stack-3">
        <div className="tiles">
          <button className="stat" onClick={() => navigate('/search')}>
            <div className="stat-k">Files</div>
            <div className="stat-v">{data?.counts.assets ?? '—'}</div>
            <div className="stat-n">{bytes(data?.health.totalBytes ?? 0)} in storage</div>
          </button>
          <button className="stat" onClick={() => navigate('/artists')}>
            <div className="stat-k">Artists</div>
            <div className="stat-v">{data?.counts.artists ?? '—'}</div>
            <div className="stat-n"><Users size={11} style={{ verticalAlign: -1 }} /> across the roster</div>
          </button>
          <button className="stat" onClick={() => navigate('/songs')}>
            <div className="stat-k">Songs</div>
            <div className="stat-v">{data?.counts.songs ?? '—'}</div>
            <div className="stat-n"><Disc3 size={11} style={{ verticalAlign: -1 }} /> releases catalogued</div>
          </button>
          <button
            className="stat"
            data-tour="health"
            onClick={() => navigate(data?.canSeeStorage ? '/admin/storage' : '/search?availability=AVAILABLE')}
          >
            <div className="stat-k row-tight">
              Verified in storage
              <HelpTip text="The share of files confirmed present in storage with matching size and checksum. Anything below 100% has an explanation on the storage health page." />
            </div>
            <div className={`stat-v ${(data?.health.healthPct ?? 100) >= 98 ? 'ok' : 'warn'}`}>
              {data ? `${data.health.healthPct}%` : '—'}
            </div>
            <div className="stat-n">
              {data ? `${pluralise(data.counts.staleVerification, 'file')} not checked recently` : ' '}
            </div>
          </button>
          {data && data.counts.activeShares > 0 && (
            <button className="stat" onClick={() => navigate('/shares')}>
              <div className="stat-k">Live share links</div>
              <div className="stat-v indigo">{data.counts.activeShares}</div>
              <div className="stat-n"><Share2 size={11} style={{ verticalAlign: -1 }} /> out with partners</div>
            </button>
          )}
        </div>

        {/* Status ribbon — the six states, always visible, always clickable. */}
        {data && (
          <div className="panel">
            <div className="panel-body">
              <div className="spread" style={{ marginBottom: 12 }}>
                <span className="t-h3 row-tight">
                  <ShieldCheck size={15} color="var(--indigo)" /> Where every file stands
                </span>
                {data.canSeeStorage && (
                  <Link className="btn btn-ghost btn-sm" to="/admin/storage">Storage health <ArrowRight size={13} /></Link>
                )}
              </div>

              <div className="meter" style={{ marginBottom: 14 }}>
                {(Object.entries(data.health.byStatus) as [Availability, number][])
                  .filter(([, n]) => n > 0)
                  .map(([status, n]) => (
                    <i
                      key={status}
                      data-status={status}
                      title={`${STATUS_COPY[status].label}: ${n}`}
                      style={{ width: `${(n / data.health.totalAssets) * 100}%`, background: 'var(--st)' }}
                    />
                  ))}
              </div>

              <div className="wrap-gap">
                {(Object.entries(data.health.byStatus) as [Availability, number][]).map(([status, n]) => (
                  <Link
                    key={status}
                    to={`/search?availability=${status}`}
                    className="row-tight"
                    style={{ textDecoration: 'none', opacity: n === 0 ? 0.4 : 1 }}
                  >
                    <AvailabilityBadge status={status} />
                    <span className="t-small" style={{ fontFamily: 'var(--mono)' }}>{n}</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Needs attention ─────────────────────────────────────────────── */}
      {data && data.attention.length > 0 && (
        <section>
          <div className="note danger" style={{ marginBottom: 14 }}>
            <AlertTriangle size={15} />
            <div className="grow">
              <b>{pluralise(data.attention.length, 'file needs', 'files need')} a decision.</b>{' '}
              These are catalogued but their stored object is missing or does not match. Nothing else
              in the library is affected.
            </div>
            {data.canSeeStorage && <Link className="btn btn-secondary btn-sm" to="/admin/storage">Review</Link>}
          </div>
          <div className="cards">
            {data.attention.map((a) => <AssetCard key={a.assetId} asset={a} onOpen={(x) => setOpenAsset(x.assetId)} />)}
          </div>
        </section>
      )}

      {/* ── Recent uploads ──────────────────────────────────────────────── */}
      <section>
        <div className="spread" style={{ marginBottom: 14 }}>
          <h2 className="t-h2 row-tight"><Clock size={16} color="var(--ink-3)" /> Added recently</h2>
          <Link className="btn btn-ghost btn-sm" to="/search?sort=newest">See all <ArrowRight size={13} /></Link>
        </div>
        {isLoading ? <CardSkeletons n={4} /> : (
          <div className="cards">
            {data?.recent.map((a) => <AssetCard key={a.assetId} asset={a} onOpen={(x) => setOpenAsset(x.assetId)} />)}
          </div>
        )}
      </section>

      {/* ── Artists + activity, side by side ────────────────────────────── */}
      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.35fr) minmax(0,1fr)', gap: 18 }}>
        <div className="panel">
          <div className="panel-head">
            <span className="t-h3">Busiest artists</span>
            <Link className="btn btn-ghost btn-sm" to="/artists">All artists</Link>
          </div>
          <div>
            {data?.topArtists.slice(0, 5).map((a) => (
              <Link
                key={a._id}
                to={`/artists/${a._id}`}
                className="nav-item"
                style={{ borderRadius: 0, padding: '12px 18px', borderBottom: '1px solid var(--line)' }}
              >
                <span
                  style={{
                    width: 34, height: 34, borderRadius: 10, flex: 'none',
                    background: 'linear-gradient(135deg, var(--indigo-soft), var(--indigo-wash))',
                    color: 'var(--indigo-deep)', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', fontWeight: 700, fontSize: 12,
                  }}
                >
                  {a.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="grow">
                  <span style={{ display: 'block', fontWeight: 600, color: 'var(--ink)', fontSize: 13.5 }}>{a.name}</span>
                  <span className="t-small" style={{ fontWeight: 400 }}>{a.genre}</span>
                </span>
                <span className="t-small" style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                  {a.assetCount} files<br />{bytes(a.totalBytes)}
                </span>
              </Link>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><span className="t-h3">Latest activity</span></div>
          <div className="panel-body stack-3">
            {data?.activity.map((e) => (
              <div key={e._id} style={{ fontSize: 13 }}>
                <b>{e.userName}</b> <span className="muted">{ACTION_COPY[e.action] ?? e.action.toLowerCase()}</span>
                <div className="t-small truncate" title={e.label}>{e.label}</div>
                <div className="t-small" style={{ fontSize: 11 }}>{relative(e.timestamp)}</div>
              </div>
            ))}
            {data?.canUpload && (
              <Link className="btn btn-secondary btn-sm btn-block" to="/upload">
                <UploadCloud size={14} /> Add a file
              </Link>
            )}
          </div>
        </div>
      </section>

      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
    </div>
  );
}
