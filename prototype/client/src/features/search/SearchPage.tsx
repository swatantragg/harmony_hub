// Universal search — the screen most people will live in. Results take the full width;
// filters live in a tabbed dialog so a dense facet list never competes with the grid for
// space. Availability is a first-class filter, and "verify these N" runs a live probe
// over the current page.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search, LayoutGrid, List, X, SlidersHorizontal, ShieldCheck, Loader2, FileQuestion, ChevronDown,
} from 'lucide-react';
import { api, qs } from '../../lib/api';
import { AssetCard, AssetRow } from '../assets/AssetCard';
import { AssetDrawer } from '../assets/AssetDrawer';
import {
  AvailabilityBadge, CardSkeletons, EmptyState, HelpTip, Modal, useDebounced, useToast,
} from '../../components/ui';
import { pluralise } from '../../lib/format';
import type { Availability, FacetValue, SearchResponse } from '../../lib/types';

const FACETS: { key: string; label: string; hint?: string }[] = [
  { key: 'availability', label: 'Availability', hint: 'Whether the file is genuinely in storage right now' },
  { key: 'tags', label: 'Tags', hint: 'Typing a tag in the box above searches it too — this narrows to an exact tag' },
  { key: 'folder', label: 'Folder', hint: 'Folders group files in the catalogue; storage keeps each file separately' },
  { key: 'family', label: 'Family' },
  { key: 'type', label: 'Asset type' },
  { key: 'artist', label: 'Artist' },
  { key: 'language', label: 'Language' },
  { key: 'mood', label: 'Mood' },
  { key: 'version', label: 'Version' },
  { key: 'year', label: 'Release year' },
];

// Ten facets is too many tabs. They group into six questions people actually ask, and
// each tab carries a count so a filter set two tabs away is never invisible.
const FILTER_TABS: { id: string; label: string; facets: string[] }[] = [
  { id: 'assets', label: 'Assets', facets: ['family', 'type', 'version'] },
  { id: 'tags', label: 'Tags', facets: ['tags'] },
  { id: 'availability', label: 'Availability', facets: ['availability'] },
  { id: 'folders', label: 'Folders', facets: ['folder'] },
  { id: 'people', label: 'Artists', facets: ['artist'] },
  { id: 'release', label: 'Release', facets: ['language', 'mood', 'year'] },
];

const SORTS = [
  ['relevance', 'Best match'], ['newest', 'Newest first'], ['oldest', 'Oldest first'],
  ['name', 'Name A–Z'], ['largest', 'Largest first'],
] as const;

// How many values a facet shows before it collapses. Everything past this stays one
// click away — never hidden, because a tag you cannot reach is a tag you cannot use.
const COLLAPSED = 8;
// Past this many values, scanning stops working and a filter box earns its place.
const FILTERABLE_AT = 12;

function FacetGroup({
  facetKey, label, hint, values, selected, resolve, onToggle, resetKey,
}: {
  facetKey: string;
  label: string;
  hint?: string;
  values: FacetValue[];
  selected: string[];
  resolve: (name: string) => string;
  onToggle: (value: string) => void;
  // Changes whenever the query itself changes, so a half-typed filter from a previous
  // search does not silently narrow this list.
  resetKey: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => { setFilter(''); }, [resetKey]);

  const isOn = (f: FacetValue) => selected.includes(resolve(String(f.value)));

  const matching = filter.trim()
    ? values.filter((f) => String(f.value).toLowerCase().includes(filter.trim().toLowerCase()))
    : values;

  // Whatever else happens — collapsed, or narrowed by the box above — an active filter
  // always renders. A selection you cannot see is one you cannot switch off.
  const show = new Set<string>();
  for (const f of (expanded || filter.trim() ? matching : matching.slice(0, COLLAPSED))) {
    show.add(String(f.value));
  }
  for (const f of values) if (isOn(f)) show.add(String(f.value));
  const visible = values.filter((f) => show.has(String(f.value)));

  if (values.length === 0) return null;

  const hiddenCount = matching.filter((f) => !show.has(String(f.value))).length;

  return (
    <div>
      <div className="row-tight" style={{ marginBottom: 8 }}>
        <span className="eyebrow">{label}</span>
        {hint && <HelpTip text={hint} />}
      </div>

      {(expanded || filter.trim()) && values.length > FILTERABLE_AT && (
        <input
          className="input"
          style={{ marginBottom: 8, fontSize: 12.5, padding: '6px 9px' }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${label.toLowerCase()}…`}
          aria-label={`Filter ${label} values`}
        />
      )}

      {/* Values run across, not down: a wrapping row fits three times as many in the same
          height, and the eye scans a line of labels faster than a column of rows. */}
      <div className="facet-chips">
        {visible.map((f) => {
          const name = String(f.value);
          const value = resolve(name);
          const on = selected.includes(value);
          return (
            <button
              key={name}
              className={`facet-chip ${on ? 'on' : ''}`}
              onClick={() => onToggle(value)}
              aria-pressed={on}
              title={name}
            >
              {facetKey === 'availability' ? (
                <AvailabilityBadge status={name as Availability} />
              ) : (
                <span className="facet-chip-name">{name}</span>
              )}
              <span className="facet-chip-count">{f.count}</span>
            </button>
          );
        })}

        {filter.trim() && matching.length === 0 && (
          <div className="t-small">
            Nothing matches “{filter.trim()}”.{visible.length > 0 && ' Selected values stay listed.'}
          </div>
        )}
      </div>

      {(hiddenCount > 0 || expanded) && (
        <button
          className="btn btn-ghost btn-sm"
          style={{ padding: '4px 8px', marginTop: 4 }}
          onClick={() => { setExpanded((v) => !v); setFilter(''); }}
        >
          {expanded
            ? 'Show fewer'
            : <>Show all {values.length} <ChevronDown size={12} /></>}
        </button>
      )}
    </div>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [openAsset, setOpenAsset] = useState<string | null>(params.get('asset'));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterTab, setFilterTab] = useState(FILTER_TABS[0].id);
  const debounced = useDebounced(text, 300);
  const qc = useQueryClient();
  const toast = useToast();

  // The URL is the source of truth for a query — every search is shareable as a link.
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (debounced.trim()) next.set('q', debounced.trim());
    else next.delete('q');
    next.delete('page');
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [debounced]);

  const selected = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const { key } of FACETS) {
      const raw = params.get(key === 'artist' ? 'artistId' : key === 'folder' ? 'folderId' : key);
      out[key] = raw ? raw.split(',') : [];
    }
    return out;
  }, [params]);

  const activeCount = Object.values(selected).flat().length;

  const query = useMemo(() => ({
    q: params.get('q') ?? '',
    availability: selected.availability, family: selected.family, type: selected.type,
    artistId: selected.artist, language: selected.language, mood: selected.mood,
    tags: selected.tags, version: selected.version, year: selected.year,
    folderId: selected.folder,
    sort: params.get('sort') ?? undefined,
    page: params.get('page') ?? '1',
    limit: 48,
  }), [params, selected]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['search', query],
    queryFn: () => api<SearchResponse>(`/search${qs(query as Record<string, unknown>)}`),
    placeholderData: (prev) => prev,
  });

  const toggle = (key: string, value: string) => {
    const param = key === 'artist' ? 'artistId' : key === 'folder' ? 'folderId' : key;
    const next = new URLSearchParams(params);
    const current = selected[key];
    const updated = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    if (updated.length) next.set(param, updated.join(','));
    else next.delete(param);
    next.delete('page');
    setParams(next);
  };

  const clearAll = () => {
    const next = new URLSearchParams();
    if (params.get('q')) next.set('q', params.get('q')!);
    setParams(next);
  };

  // Live verification over the visible page (§10.5.2, &verify=live).
  const verifyPage = useMutation({
    mutationFn: () =>
      api<{ summary: Record<string, number> }>('/assets/verify-batch', {
        method: 'POST',
        body: { assetIds: (data?.data ?? []).map((a) => a.assetId) },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      const bad = (r.summary.missing ?? 0) + (r.summary.mismatch ?? 0);
      toast({
        kind: bad ? 'warn' : 'ok',
        title: bad ? `${pluralise(bad, 'file needs', 'files need')} attention` : 'All checked — everything is where it should be',
        body: `${r.summary.available ?? 0} available · ${r.summary.archived ?? 0} archived · ${r.summary.missing ?? 0} missing · ${r.summary.mismatch ?? 0} mismatched`,
      });
    },
  });

  // Artist and folder facets arrive as names; the ids live on the same rows of results.
  const artistIdByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of data?.data ?? []) if (a.artistName && a.artistId) map.set(a.artistName, a.artistId);
    return map;
  }, [data]);

  const folderIdByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of data?.data ?? []) if (a.folderName && a.folderId) map.set(a.folderName, a.folderId);
    return map;
  }, [data]);

  return (
    <div className="page">
      <div className="page-head">
        <div className="searchbar" style={{ maxWidth: 620 }} data-tour="search">
          <Search size={18} color="var(--ink-3)" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search files, tags, folders, songs, artists…"
            aria-label="Search"
            autoFocus
          />
          {text && (
            <button className="btn btn-ghost btn-icon" onClick={() => setText('')} aria-label="Clear"><X size={15} /></button>
          )}
        </div>

        <div className="spread" style={{ marginTop: 16, flexWrap: 'wrap', gap: 10 }}>
          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            <span className="t-h2">
              {isLoading ? 'Searching…' : `${data?.total ?? 0} ${(data?.total ?? 0) === 1 ? 'file' : 'files'}`}
            </span>
            {activeCount > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={clearAll}>
                <X size={13} /> Clear {activeCount} filter{activeCount > 1 ? 's' : ''}
              </button>
            )}
            {isFetching && !isLoading && <Loader2 size={14} color="var(--ink-3)" />}
          </div>

          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            <button
              className="btn btn-secondary btn-sm"
              disabled={verifyPage.isPending || !data?.data.length}
              onClick={() => verifyPage.mutate()}
              title="Runs a live check against storage for every file on this page"
            >
              {verifyPage.isPending ? <Loader2 size={13} /> : <ShieldCheck size={13} />}
              Verify these {data?.data.length ?? 0}
            </button>

            <select
              className="select"
              style={{ width: 'auto', paddingRight: 30 }}
              value={params.get('sort') ?? (params.get('q') ? 'relevance' : 'newest')}
              onChange={(e) => {
                const next = new URLSearchParams(params);
                next.set('sort', e.target.value);
                setParams(next);
              }}
              aria-label="Sort results"
            >
              {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>

            <div className="seg">
              <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} aria-label="Grid view"><LayoutGrid size={13} /></button>
              <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} aria-label="List view"><List size={13} /></button>
            </div>

            <button
              className={activeCount > 0 ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              onClick={() => setFiltersOpen(true)}
            >
              <SlidersHorizontal size={13} /> Filters{activeCount > 0 ? ` · ${activeCount}` : ''}
            </button>
          </div>
        </div>
      </div>

      <div className="search-layout">
        <div>
          {isLoading ? (
            <CardSkeletons n={12} />
          ) : (data?.data.length ?? 0) === 0 ? (
            <EmptyState
              icon={<FileQuestion size={26} />}
              title="Nothing matched"
              body={
                activeCount > 0
                  ? 'Try removing a filter — the counts beside each option show how many files would remain.'
                  : 'Search by filename, song, artist, tag or ISRC. Partial words work too.'
              }
              action={activeCount > 0 ? <button className="btn btn-primary" onClick={clearAll}>Clear filters</button> : undefined}
            />
          ) : view === 'grid' ? (
            <div className="cards">
              {data!.data.map((a) => (
                <AssetCard key={a.assetId} asset={a} selected={openAsset === a.assetId} onOpen={(x) => setOpenAsset(x.assetId)} />
              ))}
            </div>
          ) : (
            <div className="panel" style={{ overflow: 'hidden' }}>
              <table className="tbl">
                <thead>
                  <tr><th>File</th><th>Type</th><th>Version</th><th>Size</th><th>Availability</th></tr>
                </thead>
                <tbody>
                  {data!.data.map((a) => (
                    <AssetRow key={a.assetId} asset={a} selected={openAsset === a.assetId} onOpen={(x) => setOpenAsset(x.assetId)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data && data.hasMore && (
            <div style={{ textAlign: 'center', marginTop: 22 }}>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set('page', String(data.page + 1));
                  setParams(next);
                }}
              >
                Show more — {data.total - data.page * data.limit} remaining
              </button>
            </div>
          )}
        </div>
      </div>

      {filtersOpen && (
        <Modal
          title="Filters"
          subtitle={activeCount > 0 ? `${pluralise(activeCount, 'filter')} on · ${data?.total ?? 0} files match` : `${data?.total ?? 0} files`}
          onClose={() => setFiltersOpen(false)}
          footer={
            <>
              <button className="btn btn-ghost" disabled={activeCount === 0} onClick={clearAll}>
                <X size={14} /> Clear all
              </button>
              <button className="btn btn-primary" onClick={() => setFiltersOpen(false)}>
                Show {data?.total ?? 0} {(data?.total ?? 0) === 1 ? 'file' : 'files'}
              </button>
            </>
          }
        >
          <div className="tabs" style={{ marginBottom: 20 }}>
            {FILTER_TABS.map((tab) => {
              const count = tab.facets.reduce((n, key) => n + (selected[key]?.length ?? 0), 0);
              return (
                <button
                  key={tab.id}
                  className={`tab ${filterTab === tab.id ? 'on' : ''}`}
                  onClick={() => setFilterTab(tab.id)}
                >
                  {tab.label}
                  {count > 0 && <span className="badge-count" style={{ marginLeft: 7 }}>{count}</span>}
                </button>
              );
            })}
          </div>

          <div className="facet-grid">
            {(FILTER_TABS.find((t) => t.id === filterTab)?.facets ?? []).map((key) => {
              const facet = FACETS.find((f) => f.key === key)!;
              return (
                <FacetGroup
                  key={key}
                  facetKey={key}
                  label={facet.label}
                  hint={facet.hint}
                  values={data?.facets[key] ?? []}
                  selected={selected[key] ?? []}
                  resolve={(name) =>
                    key === 'artist'
                      ? artistIdByName.get(name) ?? name
                      : key === 'folder'
                        ? folderIdByName.get(name) ?? name
                        : name
                  }
                  onToggle={(value) => toggle(key, value)}
                  resetKey={params.toString()}
                />
              );
            })}
            {(FILTER_TABS.find((t) => t.id === filterTab)?.facets ?? [])
              .every((key) => (data?.facets[key] ?? []).length === 0) && (
              <div className="t-small">Nothing here to filter on for the current results.</div>
            )}
          </div>
        </Modal>
      )}

      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
    </div>
  );
}
