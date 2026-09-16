import { useEffect, useMemo, useState } from 'react';
import type { SetURLSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X, SlidersHorizontal, ShieldCheck, Loader2, FileQuestion, ChevronDown, ArrowRight,
  Music2, Film, Image as ImageIcon, FileText, Files, LayoutList, Rows3,
} from 'lucide-react';
import { api, qs } from '../../lib/api';
import { AssetList } from '../assets/AssetCard';
import {
  AvailabilityBadge, CardSkeletons, EmptyState, HelpTip, Modal, useToast,
} from '../../components/ui';
import { Select, pairs } from '../../components/Select';
import { pluralise } from '../../lib/format';
import type {
  Asset, Availability, FacetValue, GroupedSearchResponse, SearchGroup, SearchResponse,
} from '../../lib/types';

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

const FILTER_TABS: { id: string; label: string; facets: string[] }[] = [
  { id: 'assets', label: 'Assets', facets: ['family', 'type', 'version'] },
  { id: 'tags', label: 'Tags', facets: ['tags'] },
  { id: 'availability', label: 'Availability', facets: ['availability'] },
  { id: 'folders', label: 'Folders', facets: ['folder'] },
  { id: 'people', label: 'Artists', facets: ['artist'] },
  { id: 'release', label: 'Release', facets: ['language', 'mood', 'year'] },
];

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

const PARAM: Record<string, string> = { artist: 'artistId', folder: 'folderId' };
const paramFor = (key: string) => PARAM[key] ?? key;

const COLLAPSED = 8;
const FILTERABLE_AT = 12;

/** How many files each category shows before it offers to open in full. */
const PER_SECTION = 12;

const SECTION_ICON: Record<string, typeof Music2> = {
  Audio: Music2, Video: Film, Image: ImageIcon, Document: FileText, Other: Files,
};


export interface AssetSearch {
  data: SearchResponse | undefined;
  /** Only fetched while `grouped` is on. */
  groups: GroupedSearchResponse | undefined;
  groupsLoading: boolean;
  /** Whether grouping by category is possible here at all. */
  canGroup: boolean;
  /** Whether it is on right now. */
  grouped: boolean;
  setGrouped: (on: boolean) => void;
  /** Facet counts for whichever view is on screen. */
  facets: Record<string, FacetValue[]>;
  /** The files on screen right now, flat, whichever view produced them. */
  visible: Asset[];
  isLoading: boolean;
  isFetching: boolean;
  selected: Record<string, string[]>;
  activeCount: number;
  isSearching: boolean;
  q: string;
  sort: string;
  page: number;
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

  const activeCount = FACETS
    .filter(({ key }) => !pinnedKeys.includes(paramFor(key)))
    .reduce((n, { key }) => n + selected[key].length, 0);

  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? (q ? 'relevance' : 'newest');

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
    limit: pageSize === 0 ? 5000 : pageSize,
    ...pinned,
  }), [params, selected, q, sort, page, pageSize, JSON.stringify(pinned)]);

  // Grouping only earns its place when there is a term to group and no family
  // has already been picked — a single-family search would be one section.
  const canGroup = Boolean(q.trim()) && selected.family.length === 0 && !('family' in pinned);
  const grouped = canGroup && params.get('view') !== 'list';

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['search', query],
    queryFn: () => api<SearchResponse>(`/search${qs(query as Record<string, unknown>)}`),
    placeholderData: (prev) => prev,
    // The flat list is what the grouped view's "see all" falls back to, so it
    // is still worth having warm — but not worth fetching twice over.
    enabled: !grouped,
  });

  const groupQuery = useMemo(() => {
    const { page: _page, limit: _limit, ...rest } = query;
    return { ...rest, perSection: PER_SECTION };
  }, [query]);

  const { data: groups, isLoading: groupsLoading } = useQuery({
    queryKey: ['search-grouped', groupQuery],
    queryFn: () => api<GroupedSearchResponse>(`/search/grouped${qs(groupQuery as Record<string, unknown>)}`),
    placeholderData: (prev) => prev,
    enabled: grouped,
  });

  const setGrouped = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.delete('view');
    else next.set('view', 'list');
    next.delete('page');
    setParams(next);
  };

  // Names come back in whichever shape is on screen, so both are read.
  const onScreen = useMemo(
    () => (grouped ? (groups?.groups ?? []).flatMap((g) => g.data) : data?.data ?? []),
    [grouped, groups, data],
  );

  const artistIdByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of onScreen) if (a.artistName && a.artistId) map.set(a.artistName, a.artistId);
    return map;
  }, [onScreen]);

  const folderIdByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of onScreen) if (a.folderName && a.folderId) map.set(a.folderName, a.folderId);
    return map;
  }, [onScreen]);

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

  const setPageSize = (size: number) => {
    const next = new URLSearchParams(params);
    next.set('size', String(size));
    next.delete('page');
    setParams(next);
  };

  const nextPage = () => setPage(page + 1);

  return {
    data,
    groups,
    groupsLoading,
    canGroup,
    grouped,
    setGrouped,
    facets: (grouped ? groups?.facets : data?.facets) ?? {},
    visible: onScreen,
    isLoading: grouped ? groupsLoading : isLoading,
    isFetching,
    selected,
    activeCount,
    isSearching: Boolean(q.trim()) || activeCount > 0 || params.has('sort') || params.has('page'),
    q,
    sort,
    page,
    pageSize,
    total: (grouped ? groups?.total : data?.total) ?? 0,
    setPage,
    setPageSize,
    toggle,
    clearAll,
    setSort,
    nextPage,
    resolve,
  };
}


export function SearchToolbar({
  search, onOpenFilters, showCount = true, countNoun = 'file',
}: {
  search: AssetSearch;
  onOpenFilters: () => void;
  showCount?: boolean;
  countNoun?: string;
}) {
  const {
    isLoading, isFetching, activeCount, clearAll, sort, setSort,
    visible, total, canGroup, grouped, setGrouped,
  } = search;
  const qc = useQueryClient();
  const toast = useToast();

  const verifyPage = useMutation({
    mutationFn: () =>
      api<{ summary: Record<string, number> }>('/assets/verify-batch', {
        method: 'POST',
        body: { assetIds: visible.map((a) => a.assetId) },
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
        {canGroup && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setGrouped(!grouped)}
            title={grouped
              ? 'Show one ranked list instead of a section per category'
              : 'Group the results into songs, videos, images and documents'}
            aria-pressed={grouped}
          >
            {grouped ? <LayoutList size={13} /> : <Rows3 size={13} />}
            {grouped ? 'One list' : 'By category'}
          </button>
        )}

        <button
          className="btn btn-secondary btn-sm"
          disabled={verifyPage.isPending || visible.length === 0}
          onClick={() => verifyPage.mutate()}
          title="Runs a live check against storage for every file on this page"
        >
          {verifyPage.isPending ? <Loader2 size={13} /> : <ShieldCheck size={13} />}
          Verify these {visible.length}
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


/**
 * One category of a grouped search.
 *
 * The count in the header is the real total, not what is shown: the point of
 * the section is to answer "how much audio is there for this name" before you
 * decide to look at it. Opening the section in full is the family filter,
 * which is also what a page refresh will restore.
 */
function SearchSection({
  group, openAsset, onOpen, onOpenFull,
}: {
  group: SearchGroup;
  openAsset: string | null;
  onOpen: (asset: Asset) => void;
  onOpenFull: (group: SearchGroup) => void;
}) {
  const Icon = SECTION_ICON[group.key] ?? Files;
  const hidden = group.total - group.data.length;

  return (
    <section className="search-section">
      <div className="spread" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <h2 className="t-h2 row-tight">
          <span
            data-family={group.key}
            className="search-section-icon"
            aria-hidden
          >
            <Icon size={14} />
          </span>
          {group.label}
          <span className="badge-count" style={{ marginLeft: 2 }}>{group.total}</span>
        </h2>
        {hidden > 0 && group.filterable && (
          <button className="btn btn-ghost btn-sm" onClick={() => onOpenFull(group)}>
            See all {group.total} <ArrowRight size={13} />
          </button>
        )}
      </div>

      <AssetList assets={group.data} selectedId={openAsset} onOpen={onOpen} />

      {hidden > 0 && (
        <div className="t-small" style={{ marginTop: 8 }}>
          {group.filterable
            ? <>{hidden} more in this category.</>
            : <>{hidden} more here — narrow the search to see them.</>}
        </div>
      )}
    </section>
  );
}

export function SearchResults({
  search, openAsset, onOpen, emptyBody, paginated = false,
}: {
  search: AssetSearch;
  openAsset: string | null;
  onOpen: (asset: Asset) => void;
  emptyBody?: string;
  paginated?: boolean;
}) {
  const {
    data, isLoading, activeCount, clearAll, nextPage, grouped, groups, toggle,
  } = search;

  if (isLoading) return <CardSkeletons n={12} />;

  if (grouped) {
    const sections = groups?.groups ?? [];
    if (sections.length === 0) {
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
      <div className="stack-5">
        {sections.map((group) => (
          <SearchSection
            key={group.key}
            group={group}
            openAsset={openAsset}
            onOpen={onOpen}
            onOpenFull={(g) => toggle('family', g.key)}
          />
        ))}
      </div>
    );
  }

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
  resetKey: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => { setFilter(''); }, [resetKey]);

  const isOn = (f: FacetValue) => selected.includes(resolve(String(f.value)));

  const matching = filter.trim()
    ? values.filter((f) => String(f.value).toLowerCase().includes(filter.trim().toLowerCase()))
    : values;

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
  hide?: string[];
  resetKey: string;
}) {
  const { facets, total, selected, activeCount, toggle, clearAll, resolve } = search;
  const tabs = FILTER_TABS
    .map((tab) => ({ ...tab, facets: tab.facets.filter((f) => !hide.includes(f)) }))
    .filter((tab) => tab.facets.length > 0);
  const [tab, setTab] = useState(tabs[0]?.id ?? '');

  const active = tabs.find((t) => t.id === tab) ?? tabs[0];

  return (
    <Modal
      title="Filters"
      subtitle={activeCount > 0 ? `${pluralise(activeCount, 'filter')} on · ${total} files match` : `${total} files`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" disabled={activeCount === 0} onClick={clearAll}>
            <X size={14} /> Clear all
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Show {total} {total === 1 ? 'file' : 'files'}
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
              values={facets[key] ?? []}
              selected={selected[key] ?? []}
              resolve={(name) => resolve(key, name)}
              onToggle={(value) => toggle(key, value)}
              resetKey={resetKey}
            />
          );
        })}
        {(active?.facets ?? []).every((key) => (facets[key] ?? []).length === 0) && (
          <div className="t-small">Nothing here to filter on for the current results.</div>
        )}
      </div>
    </Modal>
  );
}
