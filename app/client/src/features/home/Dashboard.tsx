// Home. The only search bar in the product lives here, and so do the controls that used
// to sit on a search screen of its own — running a live check, ordering, grid or list,
// and the facets. Type something and the results replace everything below the bar; clear
// it and the library summary comes back.
//
// What is deliberately *not* here any more: the storage-health breakdown, which belongs on
// the page that can act on it, and the list of files needing a decision, which is a
// sentence and a button rather than a wall of cards somebody has to scroll past to reach
// the work they actually came for.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Search, ArrowRight, UploadCloud, Users as UsersIcon, Disc3, Share2, Clock,
  AlertTriangle, Sparkles, X,
} from 'lucide-react';
import { api } from '../../lib/api';
import { Skeleton, useDebounced } from '../../components/ui';
import { AssetList } from '../assets/AssetCard';
import { AssetDrawer } from '../assets/AssetDrawer';
import { bytes, pluralise, relative } from '../../lib/format';
import { ACTION_COPY } from '../../lib/assetTypes';
import type { Dashboard as DashboardData } from '../../lib/types';
import { useSession, useSeen } from '../../app/session';
import {
  FiltersDialog, SearchResults, SearchToolbar, useAssetSearch,
} from '../search/searchControls';

const QUICK_FILTERS = [
  { label: 'Master audio', to: '/?type=Master+Audio' },
  { label: 'Reels', to: '/?type=Reel+-+BTS%2FMV' },
  { label: 'Cover art', to: '/?family=Image' },
  { label: 'Added this month', to: '/?sort=newest' },
  { label: 'Needs checking', to: '/?availability=UNVERIFIED' },
];

// How many artists the roster shows before "View all" takes over.
const ARTISTS_ON_HOME = 5;

export function Dashboard() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openAsset, setOpenAsset] = useState<string | null>(params.get('asset'));
  const { user } = useSession();
  const [dismissed, dismiss] = useSeen('home-intro');
  const debounced = useDebounced(text, 300);

  const search = useAssetSearch(params, setParams);

  // The URL is the source of truth for a query — every search is shareable as a link.
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (debounced.trim()) next.set('q', debounced.trim());
    else next.delete('q');
    next.delete('page');
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [debounced]);

  // Someone arriving back on Home from a link — a browser Back, a quick filter — must see
  // the box agree with what is actually being searched.
  useEffect(() => {
    const fromUrl = params.get('q') ?? '';
    if (fromUrl !== debounced.trim()) setText(fromUrl);
  }, [params.get('q')]);

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<DashboardData>('/dashboard'),
  });

  const clearSearch = () => {
    setText('');
    setParams(new URLSearchParams(), { replace: true });
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const needsReview = data?.counts.needsReview ?? 0;

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

        <form onSubmit={(e) => e.preventDefault()} data-tour="search" style={{ maxWidth: 680 }}>
          <div className="searchbar lg">
            <Search size={20} color="var(--ink-3)" />
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Try “dil se reels”, a filename, an artist, or an ISRC"
              aria-label="Search the library"
            />
            {(text || search.isSearching) && (
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={clearSearch}
                aria-label="Clear the search"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </form>

        {/* The controls belong to the bar, not to a page of their own, so they sit in the
            bar's own column and line up with its left edge. Once a search is running the
            row widens to the results grid, which puts the result count hard left and the
            controls hard right — the arrangement a results screen wants. */}
        <div style={{ marginTop: 12, maxWidth: search.isSearching ? undefined : 680 }}>
          <SearchToolbar
            search={search}
            onOpenFilters={() => setFiltersOpen(true)}
            showCount={search.isSearching}
          />
        </div>

        {!search.isSearching && (
          <div className="wrap-gap" style={{ marginTop: 14 }}>
            {QUICK_FILTERS.map((f) => (
              <Link key={f.label} className="chip" to={f.to}>{f.label}</Link>
            ))}
          </div>
        )}

        {!dismissed && !search.isSearching && (
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

      {/* ── Results, once anything is being searched ────────────────────── */}
      {search.isSearching ? (
        <section>
          <SearchResults
            search={search}
            openAsset={openAsset}
            onOpen={(a) => setOpenAsset(a.assetId)}
          />
        </section>
      ) : (
        <>
          {/* ── Library at a glance ──────────────────────────────────────── */}
          <section className="tiles">
            <button className="stat" onClick={() => navigate('/?sort=newest')}>
              <div className="stat-k">Files</div>
              <div className="stat-v">{data?.counts.assets ?? '—'}</div>
              <div className="stat-n">{bytes(data?.health.totalBytes ?? 0)} in Google Drive</div>
            </button>
            <button className="stat" onClick={() => navigate('/artists')}>
              <div className="stat-k">Artists</div>
              <div className="stat-v">{data?.counts.artists ?? '—'}</div>
              <div className="stat-n"><UsersIcon size={11} style={{ verticalAlign: -1 }} /> across the roster</div>
            </button>
            <button className="stat" onClick={() => navigate('/songs')}>
              <div className="stat-k">Songs</div>
              <div className="stat-v">{data?.counts.songs ?? '—'}</div>
              <div className="stat-n"><Disc3 size={11} style={{ verticalAlign: -1 }} /> releases catalogued</div>
            </button>
            {data && data.counts.activeShares > 0 && (
              <button className="stat" onClick={() => navigate('/shares')}>
                <div className="stat-k">Live share links</div>
                <div className="stat-v indigo">{data.counts.activeShares}</div>
                <div className="stat-n"><Share2 size={11} style={{ verticalAlign: -1 }} /> out with partners</div>
              </button>
            )}
          </section>

          {/* ── Needs a decision ─────────────────────────────────────────── */}
          {/* One line and one button. The files themselves, and everything that can be
              done about them, are on Storage health — which is where the reader ends up
              rather than being shown a problem here that cannot be solved here. */}
          {needsReview > 0 && data?.canSeeStorage && (
            <section>
              <div className="note danger">
                <AlertTriangle size={15} />
                <div className="grow">
                  <b>{needsReview} {needsReview === 1 ? 'file needs' : 'files need'} review</b>
                </div>
                <Link className="btn btn-secondary btn-sm" to="/admin/storage?focus=review">Review</Link>
              </div>
            </section>
          )}

          {/* ── Recently added ───────────────────────────────────────────── */}
          <section>
            <div className="spread" style={{ marginBottom: 14 }}>
              <h2 className="t-h2 row-tight"><Clock size={16} color="var(--ink-3)" /> Added recently</h2>
              <Link className="btn btn-ghost btn-sm" to="/?sort=newest">See all <ArrowRight size={13} /></Link>
            </div>
            {isLoading ? <Skeleton h={260} /> : (
              <AssetList
                assets={data?.recent ?? []}
                selectedId={openAsset}
                onOpen={(a) => setOpenAsset(a.assetId)}
              />
            )}
          </section>

          {/* ── Artists + activity, side by side ─────────────────────────── */}
          <section className="home-split">
            <div className="panel">
              <div className="panel-head">
                <span className="t-h3">Artists</span>
                <Link className="btn btn-ghost btn-sm" to="/artists">View all <ArrowRight size={13} /></Link>
              </div>
              <div>
                {/* A name and a number. Anything else here — a genre, a size, a rank — is
                    detail the artist's own page carries better. */}
                {data?.artists.slice(0, ARTISTS_ON_HOME).map((a) => (
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
                        justifyContent: 'center', fontWeight: 700, fontSize: 14.5,
                      }}
                    >
                      {a.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="grow truncate" style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 15.5 }}>
                      {a.name}
                    </span>
                    <span className="t-small" style={{ fontFamily: 'var(--mono)', fontSize: 14, flex: 'none' }}>
                      {pluralise(a.assetCount, 'file')}
                    </span>
                  </Link>
                ))}
              </div>
            </div>

            <div className="panel">
              <div className="panel-head"><span className="t-h3">Latest activity</span></div>
              <div className="panel-body stack-3">
                {data?.activity.map((e) => (
                  <div key={e._id} style={{ fontSize: 15 }}>
                    <b>{e.userName}</b> <span className="muted">{ACTION_COPY[e.action] ?? e.action.toLowerCase()}</span>
                    <div className="t-small truncate" title={e.label}>{e.label}</div>
                    <div className="t-small" style={{ fontSize: 13.5 }}>{relative(e.timestamp)}</div>
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
        </>
      )}

      {filtersOpen && (
        <FiltersDialog search={search} onClose={() => setFiltersOpen(false)} resetKey={params.toString()} />
      )}
      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
    </div>
  );
}
