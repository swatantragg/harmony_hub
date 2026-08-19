// The Master Log — the library's register of record.
//
// It is not the activity log, and the distinction is the whole reason this screen exists.
// The activity log is a stream of events: what happened, who did it, in what order. This is
// a register: one row per catalogued file, every field the catalogue holds about it, as it
// stands right now. "Who deleted the master on Tuesday" is a question for the other screen.
// "What do we hold, in what state, and can we prove it" is this one.
//
// Three decisions shape it:
//
//   · The columns are chosen, not fixed. A delivery to a distributor wants ISRC, title,
//     artist and checksum. A storage audit wants Drive ids, sizes and verification dates. A
//     rights conversation wants uploader, folder and share history. Sixty-nine columns are
//     available, seventeen are on by default, and five named presets cover the questions
//     people actually arrive with.
//   · What leaves in the file is what is on the screen. The same filters, the same order,
//     the same columns — and the workbook's last sheet writes down every one of them, so a
//     spreadsheet forwarded to somebody outside the company still says what it left out.
//   · The whole thing is linkable. Every filter lives in the URL, so "the register of
//     everything missing, oldest first" is a link somebody can be sent.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Table2, Search, X, Columns3, Sheet, FileText, Loader2, RotateCcw, ExternalLink,
  SlidersHorizontal, Check, ArrowUp, ArrowDown, ChevronsUpDown, Rows3,
} from 'lucide-react';
import { api, downloadFile, qs } from '../../lib/api';
import {
  AvailabilityBadge, EmptyState, Modal, Skeleton, TagChip, useDebounced, useToast,
} from '../../components/ui';
import { Pagination, ALL_ROWS } from '../../components/Pagination';
import { AssetDrawer } from '../assets/AssetDrawer';
import { date, midTruncate } from '../../lib/format';
import type {
  Availability, FacetValue, MasterLogColumn, MasterLogResponse, MasterLogRow,
} from '../../lib/types';

/* ── What the URL carries ──────────────────────────────────────────────────
   Every filter, so a narrowed register is a link. The column choice is deliberately not
   here: sixty keys in a query string makes an unpasteable URL, and it is a preference
   about how somebody reads rather than about which rows they mean. */
const FILTERS = [
  'q', 'status', 'family', 'type', 'artist', 'folder', 'uploadedBy',
  'tags', 'language', 'version', 'placement', 'year', 'shared', 'lifecycle', 'from', 'to',
] as const;
type FilterKey = typeof FILTERS[number];

// Versioned, and the version is bumped whenever a column joins the default set. Without
// that, anybody who has already used this screen keeps the set they were first given and
// never sees the new column at all — which looks exactly like the column not shipping.
// Losing a hand-tuned selection once is the cheaper of the two failures.
const COLUMNS_KEY = 'gcloud.masterlog.columns.v2';
const DENSITY_KEY = 'gcloud.masterlog.density';

/* ── Cell rendering ────────────────────────────────────────────────────────
   A row arrives display-ready — the server has already turned 1503238553 into "1.4 GB" —
   so this decides presentation only: which cells are monospaced, which are timestamps,
   which carry a badge. Nothing here re-derives a value, because the moment it does the
   table and the exported file can disagree. */

const MONO = new Set([
  'assetId', 'versionGroupId', 'supersedes', 'folderId', 'driveFileId', 'driveParentId',
  'revisionId', 'sha256', 'md5', 'sha1', 'artistId', 'songId', 'uploadedById', 'linkedTo', 'isrc',
]);

const TIMESTAMPS = new Set([
  'lastCheckedAt', 'lastVerifiedAt', 'createdAt', 'updatedAt', 'renamedAt', 'deletedAt',
  'driveCreatedAt', 'driveModifiedAt', 'lastSharedAt',
]);

// Long identifiers are elided in the middle, never at the end: the tail of a checksum is
// what distinguishes two files whose first sixteen characters match.
const ELIDE: Record<string, [number, number]> = {
  sha256: [12, 8], sha1: [12, 8], md5: [10, 6],
  assetId: [8, 6], versionGroupId: [8, 6], supersedes: [8, 6], linkedTo: [8, 6],
  driveFileId: [10, 6], driveParentId: [10, 6], folderId: [8, 6], artistId: [8, 6],
  songId: [8, 6], uploadedById: [8, 6], revisionId: [10, 6],
};

function Cell({ column, row }: { column: MasterLogColumn; row: MasterLogRow }) {
  const value = row[column.key];

  if (column.key === 'status') {
    return <AvailabilityBadge status={row._status as Availability} />;
  }

  if (column.key === 'tags') {
    if (!row._tags.length) return <span className="t-small">—</span>;
    return (
      <span className="row-tight" style={{ flexWrap: 'wrap', gap: 4 }}>
        {row._tags.map((t) => <TagChip key={t} name={t} />)}
      </span>
    );
  }

  if (column.key === 'driveLink') {
    if (!row._driveLink) return <span className="t-small">—</span>;
    return (
      <a
        className="btn btn-ghost btn-sm"
        href={row._driveLink}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        title="Open this file in Google Drive"
      >
        <ExternalLink size={13} /> Drive
      </a>
    );
  }

  // Language is the one column whose value means nothing without knowing who stated it.
  // Rather than force a second column into every view to say so, the cell carries its own
  // provenance: an inherited value is marked, and a blank says what blank means.
  if (column.key === 'language') {
    if (!value) {
      return <span className="t-small" title="Nobody has recorded a language for this file, and it belongs to no release that could answer for it.">—</span>;
    }
    const from = row.languageSource;
    return (
      <span title={from === 'The release' ? 'Inherited from the release this file belongs to' : 'Recorded on this file'}>
        {String(value)}
        {from === 'The release' && <span className="mlog-inherited">inherited</span>}
      </span>
    );
  }

  if (value == null || value === '') return <span className="t-small">—</span>;

  if (column.key === 'title') {
    return (
      <span className="mlog-title" title={String(value)}>
        {String(value)}
        {row._deleted && <span className="mlog-flag">in the bin</span>}
      </span>
    );
  }

  if (TIMESTAMPS.has(column.key)) {
    return <span title={String(value)}>{date(String(value), true)}</span>;
  }

  if (column.num) {
    return <span className="mlog-num">{Number(value).toLocaleString()}</span>;
  }

  if (MONO.has(column.key)) {
    const [head, tail] = ELIDE[column.key] ?? [18, 8];
    return <span className="mlog-mono" title={String(value)}>{midTruncate(String(value), head, tail)}</span>;
  }

  return <span title={String(value)}>{String(value)}</span>;
}

/* ── A facet dropdown ────────────────────────────────────────────────────── */

function Facet({
  label, value, options, onChange, allLabel,
}: {
  label: string;
  value: string;
  options: FacetValue[];
  onChange: (v: string) => void;
  allLabel: string;
}) {
  return (
    <label className="mlog-filter">
      <span className="eyebrow">{label}</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">{allLabel}</option>
        {/* A chosen value that no longer counts anything still has to appear, or the
            dropdown silently resets itself and the table stops matching the URL. */}
        {!options.some((o) => o.value === value) && value && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.value} ({o.count.toLocaleString()})</option>
        ))}
      </select>
    </label>
  );
}

/* ── The column picker ───────────────────────────────────────────────────── */

function ColumnPicker({
  all, groups, presets, chosen, everyColumn, onChange, onEveryColumn, onClose,
}: {
  all: MasterLogColumn[];
  groups: string[];
  presets: MasterLogResponse['presets'];
  chosen: string[];
  everyColumn: boolean;
  onChange: (next: string[]) => void;
  onEveryColumn: (v: boolean) => void;
  onClose: () => void;
}) {
  const set = new Set(chosen);
  // Order is the registry's, never the click order: a person who switches a column off and
  // on again expects it back where it was, not appended to the right-hand end.
  const apply = (keys: Set<string>) => onChange(all.filter((c) => keys.has(c.key) || c.always).map((c) => c.key));

  const toggle = (key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    apply(next);
  };

  return (
    <Modal
      title="Columns"
      subtitle={`${chosen.length} of ${all.length} showing. The same set is what leaves in an export.`}
      onClose={onClose}
      width="wide"
      footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}
    >
      <div className="stack-4">
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Start from</div>
          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            {presets.map((p) => (
              <button key={p.id} className="chip" title={p.hint} onClick={() => apply(new Set(p.columns))}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* An export normally carries exactly what is on screen — that is the property
            that makes the file answerable for. The override is here, next to the columns
            it overrides, rather than buried among the filters. */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>An export carries</div>
          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            <button className={`chip ${everyColumn ? '' : 'on'}`} onClick={() => onEveryColumn(false)}>
              The {chosen.length} columns on screen
            </button>
            <button className={`chip ${everyColumn ? 'on' : ''}`} onClick={() => onEveryColumn(true)}>
              Every column ({all.length})
            </button>
          </div>
        </div>

        {groups.map((group) => {
          const inGroup = all.filter((c) => c.group === group);
          const allOn = inGroup.every((c) => set.has(c.key));
          return (
            <div key={group}>
              <div className="spread" style={{ marginBottom: 8 }}>
                <div className="eyebrow">{group}</div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    const next = new Set(set);
                    for (const c of inGroup) {
                      if (allOn) next.delete(c.key);
                      else next.add(c.key);
                    }
                    apply(next);
                  }}
                >
                  {allOn ? 'None' : 'All'}
                </button>
              </div>
              <div className="mlog-column-grid">
                {inGroup.map((c) => {
                  const on = set.has(c.key) || c.always;
                  return (
                    <button
                      key={c.key}
                      className={`mlog-column ${on ? 'on' : ''}`}
                      disabled={c.always}
                      onClick={() => toggle(c.key)}
                      title={c.always ? 'Always shown' : undefined}
                    >
                      <span className="mlog-tick">{on && <Check size={12} />}</span>
                      <span className="grow truncate" style={{ textAlign: 'left' }}>{c.header}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

/* ── The screen ──────────────────────────────────────────────────────────── */

export function MasterLog() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState('createdAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [everyColumn, setEveryColumn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[] | null>(() => {
    try { return JSON.parse(localStorage.getItem(COLUMNS_KEY) || 'null'); } catch { return null; }
  });
  const [dense, setDense] = useState(() => localStorage.getItem(DENSITY_KEY) !== 'comfortable');

  const debounced = useDebounced(text, 300);
  const toast = useToast();
  const qc = useQueryClient();

  const get = (key: FilterKey) => params.get(key) ?? '';
  const tags = get('tags') ? get('tags').split(',') : [];

  // Any change to what is being asked for invalidates the page number and the selection:
  // page 7 of a different filter is a different set of rows, and a tick against a row that
  // is no longer on screen is a row somebody would export without meaning to.
  const narrow = (key: FilterKey, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setPage(1);
    setSelected(new Set());
  };

  useEffect(() => {
    if (debounced.trim() === get('q')) return;
    narrow('q', debounced.trim());
  }, [debounced]);

  // Arriving back here from a link — a browser Back, a bookmark — the box has to agree
  // with what is actually being filtered.
  useEffect(() => {
    const fromUrl = get('q');
    if (fromUrl !== debounced.trim()) setText(fromUrl);
  }, [params.get('q')]);

  useEffect(() => {
    if (chosen) localStorage.setItem(COLUMNS_KEY, JSON.stringify(chosen));
  }, [chosen]);
  useEffect(() => { localStorage.setItem(DENSITY_KEY, dense ? 'compact' : 'comfortable'); }, [dense]);

  const filterQuery = useMemo(
    () => Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? ''])),
    [params.toString()],
  );

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['master-log', filterQuery, sort, dir, page, pageSize],
    queryFn: () => api<MasterLogResponse>(`/master-log${qs({
      ...filterQuery, sort, dir, page, limit: pageSize === ALL_ROWS ? 5000 : pageSize,
    })}`),
    placeholderData: (prev) => prev,
  });

  // Until the registry has arrived there is nothing to choose from, so the default set the
  // server names is what renders — never a hard-coded list that could disagree with it.
  const visible = useMemo(() => {
    if (!data) return [];
    const keys = new Set(chosen ?? data.defaultColumns);
    return data.columns.filter((c) => keys.has(c.key) || c.always);
  }, [data, chosen]);

  const rows = data?.data ?? [];
  const pageIds = rows.map((r) => r._id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const anyFilter = FILTERS.some((k) => params.get(k));

  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const togglePage = () => {
    const next = new Set(selected);
    if (allOnPage) pageIds.forEach((id) => next.delete(id));
    else pageIds.forEach((id) => next.add(id));
    setSelected(next);
  };

  const clearFilters = () => {
    setText('');
    setParams(new URLSearchParams(), { replace: true });
    setPage(1);
    setSelected(new Set());
  };

  // Clicking a column heading sorts by it; clicking the one already sorted reverses it.
  // Text starts A→Z and numbers and dates start at the largest, because "the newest" and
  // "the biggest" are what somebody means by sorting those.
  const sortBy = (column: MasterLogColumn) => {
    if (sort === column.key) { setDir(dir === 'asc' ? 'desc' : 'asc'); return; }
    setSort(column.key);
    setDir(column.num || TIMESTAMPS.has(column.key) ? 'desc' : 'asc');
    setPage(1);
  };

  /* ── Export ──────────────────────────────────────────────────────────────
     Three scopes, and each one says in words what it will contain, because the difference
     between "these 412" and "all 8,900" is the difference between a delivery note and a
     copy of the whole library leaving the building. The chosen columns travel with it, and
     a hand-picked selection is POSTed — six hundred asset ids do not fit in a URL. */
  const runExport = async (scope: 'selected' | 'filtered' | 'all') => {
    const key = `${scope}-${format}`;
    setBusy(key);
    try {
      const columns = everyColumn ? 'all' : visible.map((c) => c.key).join(',');
      const base = { columns, sort, dir };
      if (scope === 'selected') {
        // lifecycle:all so a deleted row somebody deliberately ticked is still in the file.
        await downloadFile(
          `/master-log/export.${format}`,
          `gcloud-master-log.${format}`,
          { method: 'POST', body: { ...base, ids: [...selected], lifecycle: 'all' } },
        );
      } else {
        const query = scope === 'filtered' ? { ...filterQuery, ...base } : base;
        await downloadFile(`/master-log/export.${format}${qs(query)}`, `gcloud-master-log.${format}`);
      }
      toast({
        kind: 'ok',
        title: `Master log exported as ${format === 'xlsx' ? 'Excel' : 'CSV'}`,
        body: scope === 'selected'
          ? `${selected.size} chosen ${selected.size === 1 ? 'row' : 'rows'}, in ${everyColumn ? 'every column' : `the ${visible.length} columns on screen`}.`
          : scope === 'filtered'
            ? 'The rows matching these filters. The workbook records exactly what was filtered — a register with no note of what it left out is not worth much.'
            : 'Every file in the library, deleted ones excluded.',
      });
    } catch (e) {
      toast({ kind: 'danger', title: 'Could not build the export', body: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setBusy(null);
    }
  };

  const facet = (key: string) => data?.facets[key] ?? [];
  const s = data?.summary;

  return (
    <div className="page stack-4">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="page-head">
        <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="eyebrow">Library register</div>
            <h1 className="t-h1">Master log</h1>
            <div className="t-small" style={{ marginTop: 4 }}>
              One row per catalogued file, with every field the catalogue holds.
              {data && <> {' · '}{data.libraryTotal.toLocaleString()} files{s && <> · {s.bytesText}</>}</>}
            </div>
          </div>
          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => setPickerOpen(true)}>
              <Columns3 size={15} /> Columns
              <span className="badge-count">{visible.length}</span>
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setDense((v) => !v)}
              title={dense ? 'Switch to comfortable rows' : 'Switch to compact rows'}
            >
              <Rows3 size={15} /> {dense ? 'Compact' : 'Comfortable'}
            </button>
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => qc.invalidateQueries({ queryKey: ['master-log'] })}
              aria-label="Reload the register"
              title="Reload the register"
            >
              {isFetching ? <Loader2 size={16} className="spin" /> : <RotateCcw size={16} />}
            </button>
          </div>
        </div>
      </div>

      {/* ── The figures, over the filtered set ──────────────────────────────
          They describe what the table under them is showing, not the library — the two
          disagreeing is how a tile ends up quoted in a meeting as a library total. */}
      <div className="tiles">
        <div className="stat plain">
          <div className="stat-k">Files</div>
          <div className="stat-v">{s ? s.files.toLocaleString() : '—'}</div>
          <div className="stat-n">{data?.filtered ? `of ${data.libraryTotal.toLocaleString()} in the library` : 'the whole library'}</div>
        </div>
        <div className="stat plain">
          <div className="stat-k">Total size</div>
          <div className="stat-v">{s ? s.bytesText : '—'}</div>
          <div className="stat-n">{s ? `${s.artists.toLocaleString()} artists · ${s.songs.toLocaleString()} songs` : ' '}</div>
        </div>
        <div className="stat plain">
          <div className="stat-k">Verified</div>
          <div className="stat-v ok">{s ? s.available.toLocaleString() : '—'}</div>
          <div className="stat-n">matched against storage</div>
        </div>
        <div className="stat plain">
          <div className="stat-k">Needs attention</div>
          <div className="stat-v danger">{s ? s.needsAttention.toLocaleString() : '—'}</div>
          <div className="stat-n">missing, mismatched or binned</div>
        </div>
        <div className="stat plain">
          <div className="stat-k">Not checked</div>
          <div className="stat-v warn">{s ? s.unchecked.toLocaleString() : '—'}</div>
          <div className="stat-n">not proven in the last 24 hours</div>
        </div>
        <div className="stat plain">
          <div className="stat-k">Shared out</div>
          <div className="stat-v indigo">{s ? s.shared.toLocaleString() : '—'}</div>
          <div className="stat-n">behind a live external link</div>
        </div>
      </div>

      {/* ── The register ────────────────────────────────────────────────── */}
      <div className="panel">
        <div className="panel-head" style={{ display: 'block' }}>
          <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="eyebrow">Spreadsheet view</div>
              <div className="t-h3" style={{ marginTop: 2 }}>
                {data?.filtered ? 'Matching rows' : 'Every file in the library'}
              </div>
            </div>

            <div className="row-tight" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <span className="chip chip-static">
                {(data?.total ?? 0).toLocaleString()} shown
                {' · '}{(data?.libraryTotal ?? 0).toLocaleString()} total
                {' · '}{selected.size.toLocaleString()} chosen
              </span>

              {/* One format switch rather than six buttons: the scope is the decision
                  worth making twice, and the file type is a preference. */}
              <div className="seg" role="group" aria-label="Export format">
                <button className={format === 'xlsx' ? 'on' : ''} onClick={() => setFormat('xlsx')}>
                  <Sheet size={13} /> Excel
                </button>
                <button className={format === 'csv' ? 'on' : ''} onClick={() => setFormat('csv')}>
                  <FileText size={13} /> CSV
                </button>
              </div>

              <button
                className="btn btn-secondary"
                disabled={selected.size === 0 || busy !== null}
                onClick={() => runExport('selected')}
                title="Only the rows ticked below, whatever page they were on"
              >
                {busy?.startsWith('selected') ? <Loader2 size={14} className="spin" /> : <Sheet size={14} />}
                Export {selected.size || ''} chosen
              </button>
              <button
                className="btn btn-primary"
                disabled={busy !== null}
                onClick={() => runExport('filtered')}
                title={`Everything matching the search and filters below, not just this page — ${everyColumn ? 'every column' : `the ${visible.length} columns on screen`}`}
              >
                {busy?.startsWith('filtered') ? <Loader2 size={14} className="spin" /> : <Sheet size={14} />}
                {data?.filtered ? `Export these ${(data?.total ?? 0).toLocaleString()}` : 'Export the register'}
              </button>
              {data?.filtered && (
                <button
                  className="btn btn-ghost"
                  disabled={busy !== null}
                  onClick={() => runExport('all')}
                  title="Ignores the filters below — every file in the library"
                >
                  {busy?.startsWith('all') ? <Loader2 size={14} className="spin" /> : <Sheet size={14} />} Export everything
                </button>
              )}
            </div>
          </div>

          {/* ── Filters ─────────────────────────────────────────────────── */}
          <div className="mlog-filters" style={{ marginTop: 14 }}>
            <label className="mlog-filter" style={{ flex: '2 1 260px' }}>
              <span className="eyebrow">Search rows</span>
              <div className="searchbar">
                <Search size={16} color="var(--ink-3)" />
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Title, artist, tag, filename, checksum, ID"
                  aria-label="Search the register"
                />
                {text && (
                  <button className="btn btn-ghost btn-icon" onClick={() => setText('')} aria-label="Clear the search">
                    <X size={14} />
                  </button>
                )}
              </div>
            </label>

            <Facet label="Status" allLabel="Any status" value={get('status')} options={facet('status')} onChange={(v) => narrow('status', v)} />
            <Facet label="Family" allLabel="Any family" value={get('family')} options={facet('family')} onChange={(v) => narrow('family', v)} />
            <Facet label="Asset type" allLabel="Any type" value={get('type')} options={facet('type')} onChange={(v) => narrow('type', v)} />
            <Facet label="Artist" allLabel="Any artist" value={get('artist')} options={facet('artist')} onChange={(v) => narrow('artist', v)} />
            <Facet label="Folder" allLabel="Any folder" value={get('folder')} options={facet('folder')} onChange={(v) => narrow('folder', v)} />
            <Facet label="Uploaded by" allLabel="Anybody" value={get('uploadedBy')} options={facet('uploadedBy')} onChange={(v) => narrow('uploadedBy', v)} />

            <div className="mlog-filter" style={{ flex: '0 0 auto', justifyContent: 'flex-end' }}>
              <span className="eyebrow" aria-hidden>&nbsp;</span>
              <div className="row-tight">
                <button className={`btn ${moreOpen ? 'btn-secondary' : 'btn-ghost'}`} onClick={() => setMoreOpen((v) => !v)}>
                  <SlidersHorizontal size={14} /> More
                </button>
                <button className="btn btn-ghost" disabled={!anyFilter} onClick={clearFilters}>
                  <X size={14} /> Clear
                </button>
              </div>
            </div>
          </div>

          {moreOpen && (
            <div className="mlog-filters mlog-more" style={{ marginTop: 12 }}>
              <Facet label="Language" allLabel="Any language" value={get('language')} options={facet('language')} onChange={(v) => narrow('language', v)} />
              <Facet label="Version" allLabel="Any version" value={get('version')} options={facet('version')} onChange={(v) => narrow('version', v)} />
              <Facet label="Filed as" allLabel="Anywhere" value={get('placement')} options={facet('placement')} onChange={(v) => narrow('placement', v)} />
              <Facet label="Release year" allLabel="Any year" value={get('year')} options={facet('year')} onChange={(v) => narrow('year', v)} />

              <label className="mlog-filter">
                <span className="eyebrow">Sharing</span>
                <select className="select" value={get('shared')} onChange={(e) => narrow('shared', e.target.value)} aria-label="Filter by sharing">
                  <option value="">Shared or not</option>
                  <option value="active">Behind a live link</option>
                  <option value="yes">Shared at some point</option>
                  <option value="no">Never shared</option>
                </select>
              </label>

              {/* Deleted rows are still catalogue records and still matter to an audit, so
                  they are one dropdown away rather than gone — but they are off by default,
                  because "how many files do we hold" must not count the recycle bin. */}
              <label className="mlog-filter">
                <span className="eyebrow">Deleted files</span>
                <select className="select" value={get('lifecycle') || 'live'} onChange={(e) => narrow('lifecycle', e.target.value === 'live' ? '' : e.target.value)} aria-label="Include deleted files">
                  <option value="live">Excluded</option>
                  <option value="all">Included</option>
                  <option value="deleted">Only the recycle bin</option>
                </select>
              </label>

              <label className="mlog-filter">
                <span className="eyebrow">Added from</span>
                <input className="input" type="date" value={get('from')} max={get('to') || undefined} onChange={(e) => narrow('from', e.target.value)} aria-label="Added from" />
              </label>
              <label className="mlog-filter">
                <span className="eyebrow">Added to</span>
                <input className="input" type="date" value={get('to')} min={get('from') || undefined} onChange={(e) => narrow('to', e.target.value)} aria-label="Added up to" />
              </label>

              <label className="mlog-filter" style={{ flex: '1 1 100%' }}>
                <span className="eyebrow">Tags — a row must carry all of the ones chosen</span>
                <div className="row-tight" style={{ flexWrap: 'wrap' }}>
                  {facet('tags').slice(0, 24).map((t) => {
                    const on = tags.includes(String(t.value));
                    return (
                      <button
                        key={t.value}
                        className={`chip ${on ? 'on' : ''}`}
                        onClick={() => narrow('tags', (on ? tags.filter((x) => x !== t.value) : [...tags, String(t.value)]).join(','))}
                      >
                        {t.value} <span className="count">{t.count}</span>
                      </button>
                    );
                  })}
                  {facet('tags').length === 0 && <span className="t-small">Nothing here is tagged yet.</span>}
                </div>
              </label>
            </div>
          )}
        </div>

        {/* ── The table ───────────────────────────────────────────────── */}
        {isLoading && !data ? (
          <div style={{ padding: 20 }}><Skeleton h={360} /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Table2 size={25} />}
            title="No rows match"
            body="Nothing in the library falls inside this search and these filters together."
            action={anyFilter ? <button className="btn btn-primary" onClick={clearFilters}>Clear filters</button> : undefined}
          />
        ) : (
          <div className="mlog-scroll">
            <table className={`tbl mlog ${dense ? 'dense' : ''}`}>
              <thead>
                <tr>
                  <th className="mlog-pin mlog-pin-check">
                    <input
                      type="checkbox"
                      checked={allOnPage}
                      onChange={togglePage}
                      aria-label="Choose every row on this page"
                    />
                  </th>
                  {visible.map((c, i) => {
                    const on = sort === c.key;
                    const Arrow = !on ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
                    return (
                      <th
                        key={c.key}
                        className={`mlog-h ${on ? 'on' : ''} ${i === 0 ? 'mlog-pin mlog-pin-no' : ''} ${i === 1 ? 'mlog-pin mlog-pin-title' : ''}`}
                        aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        <button className="mlog-sort" onClick={() => sortBy(c)} title={`Sort by ${c.header}`}>
                          <span className="truncate">{c.header}</span>
                          <Arrow size={11} />
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row._id}
                    className={selected.has(row._id) ? 'selected' : ''}
                    onClick={() => setOpenAsset(row._id)}
                  >
                    <td className="mlog-pin mlog-pin-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(row._id)}
                        onChange={() => toggleRow(row._id)}
                        aria-label={`Choose ${String(row.title)}`}
                      />
                    </td>
                    {visible.map((c, i) => (
                      <td
                        key={c.key}
                        className={`${i === 0 ? 'mlog-pin mlog-pin-no' : ''} ${i === 1 ? 'mlog-pin mlog-pin-title' : ''}`}
                      >
                        <Cell column={c} row={row} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="spread" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="row-tight">
            {selected.size > 0 && (
              <>
                <span className="t-small">{selected.size.toLocaleString()} chosen across every page</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
              </>
            )}
          </div>
          <div className="grow">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={data?.total ?? 0}
              onPage={setPage}
              onPageSize={(n) => { setPageSize(n); setPage(1); }}
              noun="row"
            />
          </div>
        </div>
      )}

      {pickerOpen && data && (
        <ColumnPicker
          all={data.columns}
          groups={data.groups}
          presets={data.presets}
          chosen={visible.map((c) => c.key)}
          everyColumn={everyColumn}
          onChange={setChosen}
          onEveryColumn={setEveryColumn}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
    </div>
  );
}
