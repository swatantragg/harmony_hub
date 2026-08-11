// The audit trail. Long by design and only useful if it can be narrowed, so it carries the
// controls a log actually needs: a date range, an order, a search, and numbered pages
// rather than a single truncated slice of the most recent hundred entries.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollText, Search, X } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { EmptyState, Skeleton, useDebounced } from '../../components/ui';
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
  const debounced = useDebounced(q);

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

  return (
    <div className="page stack-4">
      <div className="page-head">
        <h1 className="t-h1">Activity log</h1>
        <p className="t-body" style={{ maxWidth: '64ch', marginTop: 6 }}>
          Every change anyone has made, with what it looked like before and after. Uploads, renames,
          downloads, shares and deletions all land here — including downloads by outside partners.
        </p>

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
            <select className="select" style={{ width: 'auto' }} value={action} onChange={(e) => narrow(setAction)(e.target.value)} aria-label="Filter by action">
              <option value="">Every action</option>
              {data?.actions.map((a) => <option key={a} value={a}>{ACTION_COPY[a] ?? a}</option>)}
            </select>
            <select className="select" style={{ width: 'auto' }} value={sort} onChange={(e) => narrow(setSort)(e.target.value)} aria-label="Sort entries">
              {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>

          {/* A date range, because "what happened on the day the master went missing?" is
              the question this screen exists to answer. `To` covers the whole of its day. */}
          <div className="toolbar">
            <label className="row-tight">
              <span className="t-small">From</span>
              <input
                className="input"
                type="date"
                style={{ width: 'auto' }}
                value={from}
                max={to || undefined}
                onChange={(e) => narrow(setFrom)(e.target.value)}
                aria-label="Show entries from this date"
              />
            </label>
            <label className="row-tight">
              <span className="t-small">To</span>
              <input
                className="input"
                type="date"
                style={{ width: 'auto' }}
                value={to}
                min={from || undefined}
                onChange={(e) => narrow(setTo)(e.target.value)}
                aria-label="Show entries up to this date"
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
