import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Users, ArrowLeft, Music4, Instagram, Youtube, MapPin, Search, X, Folder as FolderIcon,
  ExternalLink, FileQuestion,
} from 'lucide-react';
import { api } from '../../lib/api';
import { CardSkeletons, EmptyState, RowSkeletons, Skeleton, useDebounced } from '../../components/ui';
import { Select, pairs } from '../../components/Select';
import { Pagination } from '../../components/Pagination';
import { AssetDrawer } from '../assets/AssetDrawer';
import { bytes, date, pluralise } from '../../lib/format';
import type { Artist, ArtistFolder } from '../../lib/types';
import {
  FiltersDialog, SearchResults, SearchToolbar, useAssetSearch,
} from '../search/searchControls';

const ARTIST_SORTS = [
  ['name', 'Name — A to Z'],
  ['nameDesc', 'Name — Z to A'],
  ['files', 'Most files first'],
  ['filesAsc', 'Fewest files first'],
  ['songs', 'Most songs first'],
  ['largest', 'Largest first'],
] as const;
type ArtistSort = typeof ARTIST_SORTS[number][0];

export function ArtistList() {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<ArtistSort>('name');
  const debounced = useDebounced(q);
  const { data, isLoading } = useQuery({
    queryKey: ['artists', debounced],
    queryFn: () => api<{ data: Artist[] }>(`/artists${debounced ? `?q=${encodeURIComponent(debounced)}` : ''}`),
  });

  const artists = useMemo(() => {
    const by: Record<ArtistSort, (a: Artist, b: Artist) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      nameDesc: (a, b) => b.name.localeCompare(a.name),
      files: (a, b) => b.assetCount - a.assetCount || a.name.localeCompare(b.name),
      filesAsc: (a, b) => a.assetCount - b.assetCount || a.name.localeCompare(b.name),
      songs: (a, b) => b.songCount - a.songCount || a.name.localeCompare(b.name),
      largest: (a, b) => b.totalBytes - a.totalBytes,
    };
    return [...(data?.data ?? [])].sort(by[sort] ?? by.name);
  }, [data, sort]);

  return (
    <div className="page stack-4">
      <div className="page-head">
        <h1 className="t-h1">Artists</h1>
        <div className="toolbar" style={{ marginTop: 16 }}>
          <div className="searchbar" style={{ maxWidth: 380, flex: '1 1 260px' }}>
            <Users size={17} color="var(--ink-3)" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or genre" aria-label="Filter artists" />
          </div>
          <Select
            style={{ width: 'auto' }}
            value={sort}
            onChange={(v) => setSort(v as ArtistSort)}
            options={pairs(ARTIST_SORTS)}
            ariaLabel="Sort artists"
          />
          {!isLoading && <span className="t-small">{pluralise(artists.length, 'artist')}</span>}
        </div>
      </div>

      {isLoading ? (
        <RowSkeletons n={5} />
      ) : (
        <div className="panel rows">
          {artists.map((a) => (
            <Link key={a._id} to={`/artists/${a._id}`} className="row-item">
              <span className="row-icon">{a.name.slice(0, 2).toUpperCase()}</span>
              <span className="row-main">
                <span className="row-title">{a.name}</span>
                <span className="row-sub">{a.genre} · {a.label}</span>
              </span>
              <span className="row-meta">
                <span>{pluralise(a.songCount, 'song')} · {pluralise(a.assetCount, 'file')}</span>
                <b>{bytes(a.totalBytes)}</b>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Artist detail ─────────────────────────────────────────────────────────── */

// What a tab does to the search underneath it. `pin` is merged into the query and cannot
// be cleared by the reader — switching tabs is how you change it — and `hides` keeps the
// facet the tab has already decided out of the filter dialog.
interface AssetTab {
  id: string;
  label: string;
  count: number;
  kind: 'assets' | 'songs' | 'folders';
  pin?: Record<string, string>;
  hides?: string[];
}

// The BTS material is spread across three asset types, and "show me the behind-the-scenes"
// is a question people ask as one thing rather than three.
const BTS_TYPES = ['Reel - BTS/MV', 'BTS - Unedited Footage', 'BTS of Song'];

const FAMILY_TABS = [
  ['Audio', 'Audio'], ['Video', 'Videos'], ['Image', 'Images'], ['Document', 'Documents'],
] as const;

// Folders are not assets, so they do not go through the asset search — they get their own
// orders, including the one only a folder has: how much of this artist's work is in it.
const FOLDER_SORTS = [
  ['files', 'Most files first'],
  ['filesAsc', 'Fewest files first'],
  ['name', 'Name — A to Z'],
  ['nameDesc', 'Name — Z to A'],
] as const;
type FolderSort = typeof FOLDER_SORTS[number][0];

export function ArtistDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [folderSort, setFolderSort] = useState<FolderSort>('files');
  const [text, setText] = useState(params.get('q') ?? '');
  const debounced = useDebounced(text, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['artist', id],
    queryFn: () => api<Artist>(`/artists/${id}`),
  });

  // Only the tabs this artist can actually fill. A tab leading to an empty list is a
  // promise the page cannot keep, so each one is built from a count that is already known.
  const tabs = useMemo<AssetTab[]>(() => {
    if (!data) return [];
    const byFamily = data.byFamily ?? {};
    const byType = data.byType ?? {};
    const btsCount = BTS_TYPES.reduce((n, t) => n + (byType[t] ?? 0), 0);

    const out: AssetTab[] = [
      { id: 'all', label: 'All files', count: data.assetCount, kind: 'assets', hides: ['artist'] },
    ];
    if ((data.songs?.length ?? 0) > 0) {
      out.push({ id: 'songs', label: 'Releases', count: data.songs!.length, kind: 'songs' });
    }
    if ((data.folders?.length ?? 0) > 0) {
      out.push({ id: 'folders', label: 'Folders', count: data.folders!.length, kind: 'folders' });
    }
    for (const [family, label] of FAMILY_TABS) {
      if ((byFamily[family] ?? 0) > 0) {
        out.push({
          id: family.toLowerCase(),
          label,
          count: byFamily[family],
          kind: 'assets',
          pin: { family },
          hides: ['family', 'artist'],
        });
      }
    }
    if (btsCount > 0) {
      out.push({
        id: 'bts',
        label: 'BTS',
        count: btsCount,
        kind: 'assets',
        pin: { type: BTS_TYPES.join(',') },
        hides: ['type', 'artist'],
      });
    }
    return out;
  }, [data]);

  const tabId = params.get('tab') ?? 'all';
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0];

  const search = useAssetSearch(params, setParams, {
    pinned: { artistId: id ?? '', ...(tab?.pin ?? {}) },
    defaultPageSize: 50,
  });

  const sortedFolders = useMemo(() => {
    const rows = [...(data?.folders ?? [])];
    const by = {
      files: (a: ArtistFolder, b: ArtistFolder) => b.assetCount - a.assetCount || a.name.localeCompare(b.name),
      filesAsc: (a: ArtistFolder, b: ArtistFolder) => a.assetCount - b.assetCount || a.name.localeCompare(b.name),
      name: (a: ArtistFolder, b: ArtistFolder) => a.name.localeCompare(b.name),
      nameDesc: (a: ArtistFolder, b: ArtistFolder) => b.name.localeCompare(a.name),
    };
    return rows.sort(by[folderSort] ?? by.files);
  }, [data?.folders, folderSort]);

  // The URL carries the query here too, so a search inside an artist is a link like any
  // other search in the product.
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (debounced.trim()) next.set('q', debounced.trim());
    else next.delete('q');
    next.delete('page');
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [debounced]);

  const selectTab = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === 'all') p.delete('tab');
    else p.set('tab', next);
    p.delete('page');
    setParams(p);
  };

  if (isLoading || !data) {
    return <div className="page stack-3"><Skeleton h={34} w="40%" /><Skeleton h={110} /><CardSkeletons n={4} /></div>;
  }

  return (
    <div className="page stack-4">
      <div>
        <Link className="btn btn-ghost btn-sm" to="/artists" style={{ marginBottom: 12, paddingLeft: 0 }}>
          <ArrowLeft size={14} /> All artists
        </Link>

        <div className="panel">
          <div className="panel-body" style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
            <div
              style={{
                width: 92, height: 92, borderRadius: 22, flex: 'none',
                background: 'linear-gradient(135deg, var(--indigo-soft), var(--indigo-wash))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--display)', fontWeight: 600, fontSize: 32, color: 'var(--indigo-deep)',
              }}
            >
              {data.name.slice(0, 2).toUpperCase()}
            </div>

            <div className="grow" style={{ minWidth: 240 }}>
              <h1 className="t-h1">{data.name}</h1>
              <div className="wrap-gap" style={{ marginTop: 9 }}>
                <span className="pill"><b>Genre</b> · {data.genre}</span>
                <span className="pill"><b>Label</b> · {data.label}</span>
                {data.city && <span className="pill"><MapPin size={11} /> {data.city}</span>}
              </div>
              <p className="t-body" style={{ marginTop: 12, maxWidth: '62ch' }}>{data.bio}</p>
              <div className="wrap-gap" style={{ marginTop: 10 }}>
                {data.socials.map((s) => (
                  <span key={s.platform} className="t-small row-tight">
                    {s.platform === 'Instagram' ? <Instagram size={13} /> : <Youtube size={13} />} {s.handle}
                  </span>
                ))}
              </div>
            </div>

            {/* Three counts across, and they stay three across — a phone that cannot give
                them 92px each shrinks the columns rather than forcing the page wide. */}
            <div className="tiles as-list" style={{ minWidth: 'min(250px, 100%)', alignSelf: 'flex-start' }}>
              <div className="stat plain">
                <div className="stat-k">Releases</div>
                <div className="stat-v">{data.songCount}</div>
              </div>
              <div className="stat plain">
                <div className="stat-k">Files</div>
                <div className="stat-v">{data.assetCount}</div>
                <div className="stat-n">{bytes(data.totalBytes)}</div>
              </div>
              <div className="stat plain">
                <div className="stat-k">Folders</div>
                <div className="stat-v">{data.folders?.length ?? 0}</div>
                <div className="stat-n">in Google Drive</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Sub-tabs: pick what kind of thing to look at ─────────────────── */}
      <div className="tabs" style={{ overflowX: 'auto' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab?.id === t.id ? 'on' : ''}`}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
            <span className="badge-count" style={{ marginLeft: 7 }}>{t.count}</span>
          </button>
        ))}
      </div>

      {/* ── Search within this artist ────────────────────────────────────── */}
      {/* Whatever tab is showing, the query and the filters run inside this artist and
          cannot escape it: `artistId` is pinned into the search rather than selected, so
          "clear filters" narrows back to the artist and never to the whole library. */}
      {tab?.kind === 'assets' && (
        <div className="stack-3">
          <div className="searchbar" style={{ maxWidth: 520 }}>
            <Search size={17} color="var(--ink-3)" />
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Search ${data.name}’s files, tags and folders…`}
              aria-label={`Search within ${data.name}`}
            />
            {text && (
              <button className="btn btn-ghost btn-icon" onClick={() => setText('')} aria-label="Clear"><X size={15} /></button>
            )}
          </div>

          <SearchToolbar
            search={search}
            onOpenFilters={() => setFiltersOpen(true)}
          />

          {/* Clicking a row opens the same drawer the grid always opened — preview,
              details, and editing for anyone who may. Only the arrangement changed. */}
          <SearchResults
            search={search}
            openAsset={openAsset}
            onOpen={(a) => setOpenAsset(a.assetId)}
            emptyBody={`Nothing of ${data.name}’s matches. Try a different tab, or clear the search box.`}
            paginated
          />

          <Pagination
            page={search.page}
            pageSize={search.pageSize}
            total={search.total}
            onPage={search.setPage}
            onPageSize={search.setPageSize}
            noun="file"
          />
        </div>
      )}

      {/* ── Releases ─────────────────────────────────────────────────────── */}
      {tab?.kind === 'songs' && (
        <section>
          {data.songs?.length === 0 ? (
            <EmptyState icon={<Music4 size={24} />} title="No releases yet" body="Songs added for this artist will appear here." />
          ) : (
            <div className="panel" style={{ overflow: 'hidden' }}>
              <div className="table-scroll">
                <table className="tbl">
                  <thead><tr><th>Song</th><th>Language</th><th>Mood</th><th>Released</th><th>Files</th></tr></thead>
                  <tbody>
                    {data.songs?.map((s) => (
                      <tr key={s._id} onClick={() => { window.location.hash = `#/songs/${s._id}`; }}>
                        <td style={{ fontWeight: 600 }}>{s.title}</td>
                        <td className="t-small">{s.language}</td>
                        <td className="t-small">{s.mood}</td>
                        <td className="t-small">{date(s.releaseDate)}</td>
                        <td className="t-small" style={{ fontFamily: 'var(--mono)' }}>{s.assetCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Folders ──────────────────────────────────────────────────────── */}
      {/* Where this artist's work is actually stored. Each of these is a real Google Drive
          folder, and the count is their files in it — not the folder's whole contents,
          which would be a different and here misleading number. */}
      {tab?.kind === 'folders' && (
        <section>
          {(data.folders?.length ?? 0) > 0 && (
            <div className="toolbar" style={{ marginBottom: 14 }}>
              <Select
                style={{ width: 'auto' }}
                value={folderSort}
                onChange={(v) => setFolderSort(v as FolderSort)}
                options={pairs(FOLDER_SORTS)}
                ariaLabel="Sort folders"
              />
              <span className="t-small">{pluralise(data.folders!.length, 'folder')}</span>
            </div>
          )}
          {(data.folders?.length ?? 0) === 0 ? (
            <EmptyState
              icon={<FileQuestion size={24} />}
              title="Not filed in any folder"
              body="Every file of theirs sits at the library root rather than inside a folder."
            />
          ) : (
            <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
              {sortedFolders.map((f) => (
                <div key={f._id} className="panel">
                  <div className="panel-body stack-2">
                    <div className="row-tight">
                      <FolderIcon size={17} color="var(--indigo)" />
                      <Link to={`/folders/${f._id}`} style={{ fontWeight: 700, fontSize: 16 }}>{f.name}</Link>
                    </div>
                    {f.parentName && <div className="t-small">inside {f.parentName}</div>}
                    {f.description && <p className="t-small" style={{ whiteSpace: 'normal' }}>{f.description}</p>}
                    <div className="wrap-gap">
                      {f.tags.map((t) => <span key={t} className="chip">{t}</span>)}
                    </div>
                    <div className="spread" style={{ marginTop: 4 }}>
                      <span className="t-small">
                        <b>{pluralise(f.assetCount, 'file')}</b> by {data.name}
                      </span>
                      {f.driveWebViewLink && (
                        <a className="btn btn-ghost btn-sm" href={f.driveWebViewLink} target="_blank" rel="noreferrer">
                          <ExternalLink size={12} /> Drive
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {(data.looseCount ?? 0) > 0 && (
            <div className="hint" style={{ marginTop: 14 }}>
              {pluralise(data.looseCount!, 'file')} of theirs {data.looseCount === 1 ? 'is' : 'are'} not in
              any folder — they sit at the library root. The <b>Everything</b> tab includes them.
            </div>
          )}
        </section>
      )}

      {filtersOpen && (
        <FiltersDialog
          search={search}
          onClose={() => setFiltersOpen(false)}
          hide={tab?.hides ?? ['artist']}
          resetKey={params.toString()}
        />
      )}
      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
    </div>
  );
}
