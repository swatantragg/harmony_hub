// The search apparatus, extracted so it has one implementation and two homes.
//
// It used to live inside a screen of its own. It does not any more: Home owns the only
// search bar in the product, and an artist's page runs the same search narrowed to that
// artist. Both need identical toolbars, identical facets and identical result rendering,
// and the fastest way to guarantee that is for there to be one of each.
//
// The URL stays the source of truth for a query wherever it runs, so every search — on
// Home or on an artist — is still a link somebody can send.
import { useEffect, useMemo, useState } from 'react';
import type { SetURLSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X, SlidersHorizontal, ShieldCheck, Loader2, FileQuestion, ChevronDown,
} from 'lucide-react';
import { api, qs } from '../../lib/api';
import { AssetList } from '../assets/AssetCard';
import {
  AvailabilityBadge, CardSkeletons, EmptyState, HelpTip, Modal, useToast,
} from '../../components/ui';
import { Select, pairs } from '../../components/Select';
import { pluralise } from '../../lib/format';
import type { Asset, Availability, FacetValue, SearchResponse } from '../../lib/types';

export const FACETS: { key: string; label: string; hint?: string }[] = [
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

// Every order in both directions. A one-way sort makes "which is the oldest?" a paging
// exercise when it is the same question asked backwards.
const SORTS = [
  ['relevance', 'Best match'],
  ['newest', 'Date added — newest first'],
  ['oldest', 'Date added — oldest first'],
  ['updated', 'Last updated — newest first'],
  ['updatedOldest', 'Last updated — oldest first'],
  ['name', 'Name — A to Z'],
  ['nameDesc', 'Name — Z to A'],
  ['largest', 'Size — largest first'],
  ['smallest', 'Size — smallest first'],
] as const;

// The URL parameter a facet is stored under, where it differs from the facet's own key.
const PARAM: Record<string, string> = { artist: 'artistId', folder: 'folderId' };
const paramFor = (key: string) => PARAM[key] ?? key;

// How many values a facet shows before it collapses. Everything past this stays one
// click away — never hidden, because a tag you cannot reach is a tag you cannot use.
const COLLAPSED = 8;
// Past this many values, scanning stops working and a filter box earns its place.
const FILTERABLE_AT = 12;

/* ── The hook ──────────────────────────────────────────────────────────────── */

export interface AssetSearch {
  data: SearchResponse | undefined;
  isLoading: boolean;
  isFetching: boolean;
  /** Facet key → selected values, already resolved to whatever the API expects. */
  selected: Record<string, string[]>;
  activeCount: number;
  /** True once the reader has actually asked for something. */
  isSearching: boolean;
  q: string;
  sort: string;
  page: number;
  /** Rows per page; 0 is the "All rows" option. */
  pageSize: number;
  total: number;
  toggle: (key: string, value: string) => void;
  clearAll: () => void;
  setSort: (value: string) => void;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  nextPage: () => void;
  resolve: (key: string, name: string) => string;
}

export function useAssetSearch(
  params: URLSearchParams,
  setParams: SetURLSearchParams,
  // Filters the page itself owns. An artist's page pins `artistId`, so every search there
  // is inside that artist and no amount of clearing filters escapes it.
  {
    pinned = {}, defaultPageSize = 48,
  }: { pinned?: Record<string, string>; defaultPageSize?: number } = {},
): AssetSearch {
  const pinnedKeys = Object.keys(pinned);

  const selected = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const { key } of FACETS) {
      const raw = params.get(paramFor(key));
      out[key] = raw ? raw.split(',') : [];
    }
    return out;
  }, [params]);

  // A pinned filter is not the reader's, so it never counts towards "3 filters on" and
  // "Clear all" never removes it.
  const activeCount = FACETS
    .filter(({ key }) => !pinnedKeys.includes(paramFor(key)))
    .reduce((n, { key }) => n + selected[key].length, 0);

  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? (q ? 'relevance' : 'newest');

  // Page and rows-per-page live in the URL like everything else here, so a link carries
  // the exact view somebody was looking at rather than resetting to page one.
  const page = Math.max(1, Number(params.get('page')) || 1);
  const rawSize = params.get('size');
  const pageSize = rawSize == null ? defaultPageSize : Math.max(0, Number(rawSize) || 0);

  const query = useMemo(() => ({
    q,
    availability: selected.availability, family: selected.family, type: selected.type,
    artistId: selected.artist, language: selected.language, mood: selected.mood,
    tags: selected.tags, version: selected.version, year: selected.year,
    folderId: selected.folder,
    sort,
    page,
    // "All rows" is expressed to the API as a limit past any realistic library size rather
    // than as a special case the server has to know about.
    limit: pageSize === 0 ? 5000 : pageSize,
    ...pinned,
  }), [params, selected, q, sort, page, pageSize, JSON.stringify(pinned)]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['search', query],
    queryFn: () => api<SearchResponse>(`/search${qs(query as Record<string, unknown>)}`),
    placeholderData: (prev) => prev,
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

  const resolve = (key: string, name: string) =>
    key === 'artist' ? artistIdByName.get(name) ?? name
      : key === 'folder' ? folderIdByName.get(name) ?? name
        : name;

  const toggle = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    const current = selected[key];
    const updated = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    if (updated.length) next.set(paramFor(key), updated.join(','));
    else next.delete(paramFor(key));
    next.delete('page');
    setParams(next);
  };

  // Keeps the free-text query, the page size and anything the page pinned; drops every
  // filter the reader added. Dropping their query would be the one thing they never meant
  // by "clear", and resetting how many rows they like to see is simply rude.
  const clearAll = () => {
    const next = new URLSearchParams();
    if (q) next.set('q', q);
    if (rawSize != null) next.set('size', rawSize);
    for (const [key, value] of Object.entries(pinned)) next.set(key, value);
    setParams(next);
  };

  const setSort = (value: string) => {
    const next = new URLSearchParams(params);
    next.set('sort', value);
    next.delete('page');
    setParams(next);
  };

  const setPage = (n: number) => {
    const next = new URLSearchParams(params);
    if (n <= 1) next.delete('page');
    else next.set('page', String(n));
    setParams(next);
  };

  // Changing the page size makes the current page number meaningless — page 7 of 50-row
  // pages is not page 7 of 250-row pages — so it always returns to the first.
  const setPageSize = (size: number) => {
    const next = new URLSearchParams(params);
    next.set('size', String(size));
    next.delete('page');
    setParams(next);
  };

  const nextPage = () => setPage(page + 1);

  return {
    data,
    isLoading,
    isFetching,
    selected,
    activeCount,
    isSearching: Boolean(q.trim()) || activeCount > 0 || params.has('sort') || params.has('page'),
    q,
    sort,
    page,
    pageSize,
    total: data?.total ?? 0,
    setPage,
    setPageSize,
    toggle,
    clearAll,
    setSort,
    nextPage,
    resolve,
  };
}

/* ── Toolbar ───────────────────────────────────────────────────────────────── */

// The controls that used to sit above a search page of their own: run a live check over
// what is on screen, choose an order, choose grid or list, open the facets.
export function SearchToolbar({
  search, onOpenFilters, showCount = true, countNoun = 'file',
}: {
  search: AssetSearch;
  onOpenFilters: () => void;
  showCount?: boolean;
  countNoun?: string;
}) {
  const { data, isLoading, isFetching, activeCount, clearAll, sort, setSort } = search;
  const qc = useQueryClient();
  const toast = useToast();

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
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not check these files', body: e.message }),
  });

  const total = data?.total ?? 0;

  // Whether the left-hand side has anything to say. When it does not, it is not rendered
  // at all rather than rendered empty: an empty flex child still takes part in
  // space-between, which silently shoves the whole control cluster to the far right of the
  // row and away from the search bar it belongs to.
  const hasStatus = showCount || activeCount > 0 || (isFetching && !isLoading);

  return (
    <div className="spread search-toolbar" style={{ flexWrap: 'wrap', gap: 10 }}>
      {hasStatus && (
        <div className="row-tight" style={{ flexWrap: 'wrap' }}>
          {showCount && (
            <span className="t-h3">
              {isLoading ? 'Searching…' : `${total} ${total === 1 ? countNoun : `${countNoun}s`}`}
            </span>
          )}
          {activeCount > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={clearAll}>
              <X size={13} /> Clear {activeCount} filter{activeCount > 1 ? 's' : ''}
            </button>
          )}
          {isFetching && !isLoading && <Loader2 size={14} color="var(--ink-3)" />}
        </div>
      )}

      <div className="toolbar">
        <button
          className="btn btn-secondary btn-sm"
          disabled={verifyPage.isPending || !data?.data.length}
          onClick={() => verifyPage.mutate()}
          title="Runs a live check against storage for every file on this page"
        >
          {verifyPage.isPending ? <Loader2 size={13} /> : <ShieldCheck size={13} />}
          Verify these {data?.data.length ?? 0}
        </button>

        <Select
          style={{ width: 'auto' }}
          value={sort}
          onChange={setSort}
          options={pairs(SORTS)}
          ariaLabel="Sort results"
        />

        <button
          className={activeCount > 0 ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
          onClick={onOpenFilters}
        >
          <SlidersHorizontal size={13} /> Filters{activeCount > 0 ? ` · ${activeCount}` : ''}
        </button>
      </div>
    </div>
  );
}

/* ── Results ───────────────────────────────────────────────────────────────── */

export function SearchResults({
  search, openAsset, onOpen, emptyBody, paginated = false,
}: {
  search: AssetSearch;
  openAsset: string | null;
  onOpen: (asset: Asset) => void;
  emptyBody?: string;
  /** A screen with numbered pages owns its own navigation; "Show more" would duplicate it. */
  paginated?: boolean;
}) {
  const { data, isLoading, activeCount, clearAll, nextPage } = search;

  if (isLoading) return <CardSkeletons n={12} />;

  if ((data?.data.length ?? 0) === 0) {
    return (
      <EmptyState
        icon={<FileQuestion size={26} />}
        title="Nothing matched"
        body={
          activeCount > 0
            ? 'Try removing a filter — the counts beside each option show how many files would remain.'
            : emptyBody ?? 'Search by filename, song, artist, tag or ISRC. Partial words work too.'
        }
        action={activeCount > 0 ? <button className="btn btn-primary" onClick={clearAll}>Clear filters</button> : undefined}
      />
    );
  }

  return (
    <>
      <AssetList assets={data!.data} selectedId={openAsset} onOpen={onOpen} />

      {!paginated && data && data.hasMore && (
        <div style={{ textAlign: 'center', marginTop: 22 }}>
          <button className="btn btn-secondary" onClick={nextPage}>
            Show more — {data.total - data.page * data.limit} remaining
          </button>
        </div>
      )}
    </>
  );
}

/* ── Facets ────────────────────────────────────────────────────────────────── */

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
          style={{ marginBottom: 8, fontSize: 14.5, padding: '6px 9px' }}
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

export function FiltersDialog({
  search, onClose, hide = [], resetKey,
}: {
  search: AssetSearch;
  onClose: () => void;
  /** Facet keys the page has already decided — the artist facet on an artist's page. */
  hide?: string[];
  resetKey: string;
}) {
  const { data, selected, activeCount, toggle, clearAll, resolve } = search;
  const tabs = FILTER_TABS
    .map((tab) => ({ ...tab, facets: tab.facets.filter((f) => !hide.includes(f)) }))
    .filter((tab) => tab.facets.length > 0);
  const [tab, setTab] = useState(tabs[0]?.id ?? '');

  const active = tabs.find((t) => t.id === tab) ?? tabs[0];

  return (
    <Modal
      title="Filters"
      subtitle={activeCount > 0 ? `${pluralise(activeCount, 'filter')} on · ${data?.total ?? 0} files match` : `${data?.total ?? 0} files`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" disabled={activeCount === 0} onClick={clearAll}>
            <X size={14} /> Clear all
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Show {data?.total ?? 0} {(data?.total ?? 0) === 1 ? 'file' : 'files'}
          </button>
        </>
      }
    >
      <div className="tabs" style={{ marginBottom: 20 }}>
        {tabs.map((t) => {
          const count = t.facets.reduce((n, key) => n + (selected[key]?.length ?? 0), 0);
          return (
            <button key={t.id} className={`tab ${active?.id === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
              {count > 0 && <span className="badge-count" style={{ marginLeft: 7 }}>{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="facet-grid">
        {(active?.facets ?? []).map((key) => {
          const facet = FACETS.find((f) => f.key === key)!;
          return (
            <FacetGroup
              key={key}
              facetKey={key}
              label={facet.label}
              hint={facet.hint}
              values={data?.facets[key] ?? []}
              selected={selected[key] ?? []}
              resolve={(name) => resolve(key, name)}
              onToggle={(value) => toggle(key, value)}
              resetKey={resetKey}
            />
          );
        })}
        {(active?.facets ?? []).every((key) => (data?.facets[key] ?? []).length === 0) && (
          <div className="t-small">Nothing here to filter on for the current results.</div>
        )}
      </div>
    </Modal>
  );
}
