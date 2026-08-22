// The audit trail. Long by design and only useful if it can be narrowed, so it carries the
// controls a log actually needs: a date range, an order, a search, and numbered pages
// rather than a single truncated slice of the most recent hundred entries.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, ScrollText, Search, Sheet, X } from 'lucide-react';
import { api, downloadFile, qs } from '../../lib/api';
import { EmptyState, Skeleton, useDebounced, useToast } from '../../components/ui';
import { Select, pairs } from '../../components/Select';
import { DateField } from '../../components/DateField';
import { Pagination } from '../../components/Pagination';
import { ACTION_COPY } from '../../lib/assetTypes';
import { date, relative } from '../../lib/format';
import type { ActivityEntry } from '../../lib/types';

const SORTS = [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['person', 'Person — A to Z'],
  ['personDesc', 'Person — Z to A'],
  ['label', 'What changed — A to Z'],
  ['labelDesc', 'What changed — Z to A'],
] as const;

interface LogResponse {
  data: ActivityEntry[];
  total: number;
  page: number;
  limit: number;
  sort: string;
  actions: string[];
  earliest: string | null;
}

export function ActivityLog() {
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [sort, setSort] = useState('newest');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [exporting, setExporting] = useState<'filtered' | 'all' | null>(null);
  const debounced = useDebounced(q);
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['activity', debounced, action, sort, from, to, page, pageSize],
    queryFn: () => api<LogResponse>(`/admin/activity${qs({
      q: debounced, action, sort, from, to,
      page, limit: pageSize === 0 ? 5000 : pageSize,
    })}`),
    placeholderData: (prev) => prev,
  });

  const filtered = Boolean(debounced || action || from || to);

  // Any change to what is being asked for invalidates the page number: page 7 of a
  // different filter is a different set of rows, and landing there is disorienting.
  const narrow = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  const clear = () => { setQ(''); setAction(''); setFrom(''); setTo(''); setPage(1); };

  // The export takes the filters, never the page. A page is a scrolling position — nobody
  // wants rows 51 to 100 of an audit trail in a spreadsheet — whereas the filters are the
  // question being asked, and they are exactly what should survive into the file.
  //
  // It also reaches past what this screen can see: the table is served from the most
  // recent entries held in memory, and the export reads the full archive, so a date range
  // months back returns rows that were never on screen.
  const exportXlsx = async (scope: 'filtered' | 'all') => {
    setExporting(scope);
    try {
      const query = scope === 'filtered' ? qs({ q: debounced, action, sort, from, to }) : qs({ sort });
      await downloadFile(`/admin/activity/export.xlsx${query}`, 'gcloud-activity.xlsx');
      toast({
        kind: 'ok',
        title: 'Export ready',
        body: scope === 'filtered'
          ? 'The rows matching these filters, as an .xlsx. A second sheet records exactly what was filtered — an audit extract with no note of what it left out is not worth much.'
          : 'The whole retention window, as an .xlsx — not just the entries this screen holds.',
      });
    } catch (e) {
      toast({ kind: 'danger', title: 'Could not build the export', body: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="page stack-4">
      <div className="page-head">
        <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <h1 className="t-h1">Activity log</h1>
          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              disabled={exporting !== null}
              onClick={() => exportXlsx('filtered')}
              title="Everything matching the search, action and date range below"
            >
              {exporting === 'filtered' ? <Loader2 size={15} /> : <Sheet size={15} />}
              {filtered ? `Export these ${data?.total ?? 0} to Excel` : 'Export to Excel'}
            </button>
            {filtered && (
              <button
                className="btn btn-secondary"
                disabled={exporting !== null}
                onClick={() => exportXlsx('all')}
                title="Ignores the filters below — the whole retention window"
              >
                {exporting === 'all' ? <Loader2 size={15} /> : <Sheet size={15} />} Export everything
              </button>
            )}
          </div>
        </div>

        <div className="stack-3" style={{ marginTop: 16 }}>
          <div className="toolbar">
            <div className="searchbar" style={{ maxWidth: 340, flex: '1 1 240px' }}>
              <Search size={16} color="var(--ink-3)" />
              <input
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(1); }}
                placeholder="Filter by person, file or action"
                aria-label="Filter activity"
              />
            </div>
            <Select
              style={{ width: 'auto' }}
              value={action}
              onChange={narrow(setAction)}
              options={[
                { value: '', label: 'Every action' },
                ...(data?.actions ?? []).map((a) => ({ value: a, label: ACTION_COPY[a] ?? a })),
              ]}
              ariaLabel="Filter by action"
            />
            <Select
              style={{ width: 'auto' }}
              value={sort}
              onChange={narrow(setSort)}
              options={pairs(SORTS)}
              ariaLabel="Sort entries"
            />
          </div>

          {/* A date range, because "what happened on the day the master went missing?" is
              the question this screen exists to answer. `To` covers the whole of its day. */}
          <div className="toolbar">
            <label className="row-tight">
              <span className="t-small">From</span>
              <DateField
                style={{ width: 'auto' }}
                value={from}
                max={to || undefined}
                onChange={narrow(setFrom)}
                ariaLabel="Show entries from this date"
              />
            </label>
            <label className="row-tight">
              <span className="t-small">To</span>
              <DateField
                style={{ width: 'auto' }}
                value={to}
                min={from || undefined}
                onChange={narrow(setTo)}
                ariaLabel="Show entries up to this date"
              />
            </label>
            {filtered && (
              <button className="btn btn-ghost btn-sm" onClick={clear}><X size={13} /> Clear filters</button>
            )}
          </div>
        </div>
      </div>

      {isLoading && !data ? (
        <Skeleton h={340} />
      ) : (data?.data.length ?? 0) === 0 ? (
        <EmptyState
          icon={<ScrollText size={25} />}
          title="Nothing matches"
          body="No entry falls inside this search, action and date range together."
          action={filtered ? <button className="btn btn-primary" onClick={clear}>Clear filters</button> : undefined}
        />
      ) : (
        <>
          <div className="panel" style={{ overflow: 'hidden' }}>
            <div className="table-scroll">
              <table className="tbl">
                <thead>
                  <tr><th>When</th><th>Who</th><th>Did what</th><th>Change</th><th>From</th></tr>
                </thead>
                <tbody>
                  {data!.data.map((e) => (
                    <tr key={e._id} style={{ cursor: 'default' }}>
                      <td className="t-small" title={date(e.timestamp, true)} style={{ whiteSpace: 'nowrap' }}>
                        <div>{relative(e.timestamp)}</div>
                        <div className="t-small" style={{ fontSize: 13.5 }}>{date(e.timestamp)}</div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 15 }}>{e.userName}</div>
                        <div className="t-small" style={{ fontSize: 13.5 }}>{e.userRole}</div>
                      </td>
                      <td>
                        <div style={{ fontSize: 15 }}>
                          <span className="muted">{ACTION_COPY[e.action] ?? e.action.toLowerCase()}</span>
                        </div>
                        <div className="t-small">{e.label}</div>
                      </td>
                      <td style={{ maxWidth: 300 }}>
                        {e.before || e.after ? (
                          <div className="t-mono" style={{ fontSize: 13.5, color: 'var(--ink-3)', wordBreak: 'break-word' }}>
                            {e.before ? `${JSON.stringify(e.before)} → ` : ''}{JSON.stringify(e.after)}
                          </div>
                        ) : (
                          <span className="t-small">—</span>
                        )}
                      </td>
                      <td className="t-small" style={{ fontFamily: 'var(--mono)', fontSize: 13.5 }}>{e.ip}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <Pagination
            page={page}
            pageSize={pageSize}
            total={data?.total ?? 0}
            onPage={setPage}
            onPageSize={(n) => { setPageSize(n); setPage(1); }}
            noun="entry"
            nounPlural="entries"
          />
        </>
      )}
    </div>
  );
}
