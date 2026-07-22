import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollText, Search } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { EmptyState, Skeleton, useDebounced } from '../../components/ui';
import { ACTION_COPY } from '../../lib/assetTypes';
import { date, relative } from '../../lib/format';
import type { ActivityEntry } from '../../lib/types';

export function ActivityLog() {
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const debounced = useDebounced(q);

  const { data, isLoading } = useQuery({
    queryKey: ['activity', debounced, action],
    queryFn: () => api<{ data: ActivityEntry[]; total: number; actions: string[] }>(`/admin/activity${qs({ q: debounced, action, limit: 100 })}`),
  });

  return (
    <div className="page stack-4">
      <div className="page-head">
        <h1 className="t-h1">Activity log</h1>
        <p className="t-body" style={{ maxWidth: '64ch', marginTop: 6 }}>
          Every change anyone has made, with what it looked like before and after. Uploads, renames,
          downloads, shares and deletions all land here — including downloads by outside partners.
        </p>

        <div className="row-tight" style={{ marginTop: 16, flexWrap: 'wrap' }}>
          <div className="searchbar" style={{ maxWidth: 340 }}>
            <Search size={16} color="var(--ink-3)" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by person, file or action" aria-label="Filter activity" />
          </div>
          <select className="select" style={{ width: 'auto' }} value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action">
            <option value="">Every action</option>
            {data?.actions.map((a) => <option key={a} value={a}>{ACTION_COPY[a] ?? a}</option>)}
          </select>
        </div>
      </div>

      {isLoading ? (
        <Skeleton h={340} />
      ) : (data?.data.length ?? 0) === 0 ? (
        <EmptyState icon={<ScrollText size={25} />} title="Nothing matches" body="Try a different search or clear the action filter." />
      ) : (
        <div className="panel" style={{ overflow: 'hidden' }}>
          <table className="tbl">
            <thead>
              <tr><th>When</th><th>Who</th><th>Did what</th><th>Change</th><th>From</th></tr>
            </thead>
            <tbody>
              {data!.data.map((e) => (
                <tr key={e._id} style={{ cursor: 'default' }}>
                  <td className="t-small" title={date(e.timestamp, true)} style={{ whiteSpace: 'nowrap' }}>{relative(e.timestamp)}</td>
                  <td>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{e.userName}</div>
                    <div className="t-small" style={{ fontSize: 11 }}>{e.userRole}</div>
                  </td>
                  <td>
                    <div style={{ fontSize: 13 }}>
                      <span className="muted">{ACTION_COPY[e.action] ?? e.action.toLowerCase()}</span>
                    </div>
                    <div className="t-small">{e.label}</div>
                  </td>
                  <td style={{ maxWidth: 300 }}>
                    {e.before || e.after ? (
                      <div className="t-mono" style={{ fontSize: 11, color: 'var(--ink-3)', wordBreak: 'break-word' }}>
                        {e.before ? `${JSON.stringify(e.before)} → ` : ''}{JSON.stringify(e.after)}
                      </div>
                    ) : (
                      <span className="t-small">—</span>
                    )}
                  </td>
                  <td className="t-small" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{e.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
