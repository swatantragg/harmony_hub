import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Share2, Ban, Clock, Download, Globe, PenLine, UserCheck, Folder as FolderIcon,
  FileIcon, Search,
} from 'lucide-react';
import { api } from '../../lib/api';
import { CopyButton, EmptyState, Skeleton, useToast, useDebounced, ConfirmDialog } from '../../components/ui';
import { countdown, date, pluralise, relative } from '../../lib/format';
import type { Share } from '../../lib/types';
import { useMemo, useState } from 'react';
import { useSession } from '../../app/session';

// What a link points at, as a person would group them. A folder link is its own category
// because it behaves differently from every file link — it carries many files at once.
const CATEGORIES = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'folders', label: 'Folders', match: (s: Share) => s.target === 'FOLDER' },
  { id: 'songs', label: 'Songs', match: (s: Share) => s.target !== 'FOLDER' && s.family === 'Audio' },
  { id: 'images', label: 'Images', match: (s: Share) => s.target !== 'FOLDER' && s.family === 'Image' },
  { id: 'videos', label: 'Videos', match: (s: Share) => s.target !== 'FOLDER' && s.family === 'Video' },
  { id: 'documents', label: 'Documents', match: (s: Share) => s.target !== 'FOLDER' && s.family === 'Document' },
] as const;

const SHARE_SORTS = [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['name', 'Name — A to Z'],
  ['nameDesc', 'Name — Z to A'],
  ['expiring', 'Expiring soonest'],
  ['downloads', 'Most downloaded'],
] as const;
type ShareSort = typeof SHARE_SORTS[number][0];

const STATES = [
  ['', 'Every state'], ['live', 'Live only'], ['expired', 'Expired'], ['revoked', 'Revoked'],
] as const;

export function ShareManager() {
  const [revoking, setRevoking] = useState<Share | null>(null);
  const [category, setCategory] = useState<string>('all');
  const [sort, setSort] = useState<ShareSort>('newest');
  const [stateFilter, setStateFilter] = useState('');
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const qc = useQueryClient();
  const toast = useToast();
  const can = useSession((s) => s.can);

  const { data, isLoading } = useQuery({
    queryKey: ['shares'],
    queryFn: () => api<{ data: Share[] }>('/shares'),
    refetchInterval: 30_000,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/shares/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({ kind: 'ok', title: 'Link revoked', body: 'It stopped working immediately, everywhere.' });
    },
  });

  const AUDIENCE_ICON = { PUBLIC: Globe, EDITOR: PenLine, RESTRICTED: UserCheck } as const;

  const state = (s: Share) =>
    s.revokedAt ? { label: 'Revoked', status: 'MISSING' }
      : s.expired ? { label: 'Expired', status: 'UNVERIFIED' }
      : s.exhausted ? { label: 'Limit reached', status: 'RESTORING' }
      : { label: 'Live', status: 'AVAILABLE' };

  const live = data?.data.filter((s) => !s.revokedAt && !s.expired && !s.exhausted) ?? [];

  const isLive = (s: Share) => !s.revokedAt && !s.expired && !s.exhausted;

  // Counts sit on the tabs themselves, so an empty category is visible before it is opened
  // rather than after — the same reason the artist page counts its tabs.
  const countFor = (id: string) =>
    (data?.data ?? []).filter(CATEGORIES.find((c) => c.id === id)!.match).length;

  const rows = useMemo(() => {
    const match = CATEGORIES.find((c) => c.id === category)?.match ?? (() => true);
    const term = debounced.trim().toLowerCase();
    const filtered = (data?.data ?? []).filter((s) => {
      if (!match(s)) return false;
      if (stateFilter === 'live' && !isLive(s)) return false;
      if (stateFilter === 'expired' && !s.expired) return false;
      if (stateFilter === 'revoked' && !s.revokedAt) return false;
      if (term) {
        const hay = `${s.targetName ?? ''} ${s.assetName ?? ''} ${s.songTitle ?? ''} ${s.artistName ?? ''} ${s.createdByName ?? ''} ${s.note ?? ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });

    const name = (s: Share) => (s.targetName ?? s.assetName ?? '').toLowerCase();
    const by: Record<ShareSort, (a: Share, b: Share) => number> = {
      newest: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      oldest: (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
      name: (a, b) => name(a).localeCompare(name(b)),
      nameDesc: (a, b) => name(b).localeCompare(name(a)),
      expiring: (a, b) => a.remainingMs - b.remainingMs,
      downloads: (a, b) => b.downloadCount - a.downloadCount,
    };
    return [...filtered].sort(by[sort]);
  }, [data, category, sort, stateFilter, debounced]);

  return (
    <div className="page stack-4">
      <div className="page-head">
        <h1 className="t-h1">Share links</h1>
      </div>

      {!isLoading && (data?.data.length ?? 0) > 0 && (
        <div className="tiles as-list">
          <div className="stat plain">
            <div className="stat-k">Live right now</div>
            <div className="stat-v indigo">{live.length}</div>
            <div className="stat-n">reachable by anyone with the link</div>
          </div>
          <div className="stat plain">
            <div className="stat-k">Downloads so far</div>
            <div className="stat-v">{data!.data.reduce((n, s) => n + s.downloadCount, 0)}</div>
            <div className="stat-n">across every link ever created</div>
          </div>
          <div className="stat plain">
            <div className="stat-k">Expiring within a day</div>
            <div className="stat-v warn">{live.filter((s) => s.remainingMs < 86_400_000).length}</div>
            <div className="stat-n">no action needed — they lapse on their own</div>
          </div>
        </div>
      )}

      {!isLoading && (data?.data.length ?? 0) > 0 && (
        <div className="stack-3">
          <div className="tabs" style={{ overflowX: 'auto' }}>
            {CATEGORIES.map((c) => {
              const n = countFor(c.id);
              return (
                <button
                  key={c.id}
                  className={`tab ${category === c.id ? 'on' : ''}`}
                  onClick={() => setCategory(c.id)}
                >
                  {c.label}
                  <span className="badge-count" style={{ marginLeft: 7 }}>{n}</span>
                </button>
              );
            })}
          </div>

          <div className="toolbar">
            <div className="searchbar" style={{ maxWidth: 320, flex: '1 1 240px' }}>
              <Search size={16} color="var(--ink-3)" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by file, folder, song or person"
                aria-label="Filter share links"
              />
            </div>
            <select className="select" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value as ShareSort)} aria-label="Sort links">
              {SHARE_SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select className="select" style={{ width: 'auto' }} value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} aria-label="Filter by state">
              {STATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <span className="t-small">{rows.length} of {data!.data.length}</span>
          </div>
        </div>
      )}

      {isLoading ? (
        <Skeleton h={260} />
      ) : (data?.data.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Share2 size={26} />}
          title="No links yet"
          body="Open any file and press Share to create a link a partner can open without an account. You stay in control of how long it lasts and how many times it can be used."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Share2 size={26} />}
          title="Nothing in this view"
          body="No link matches the current tab, search and state filter together. Try the All tab, or clear the search box."
        />
      ) : (
        <div className="panel" style={{ overflow: 'hidden' }}>
          <div className="table-scroll">
            <table className="tbl">
              <thead>
                <tr><th>Shared</th><th>Link type</th><th>Status</th><th>Expires</th><th>Downloads</th><th>Created by</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const st = state(s);
                  const Audience = AUDIENCE_ICON[s.audience ?? 'PUBLIC'] ?? Globe;
                  const isFolder = s.target === 'FOLDER';
                  return (
                    <tr key={s._id} style={{ cursor: 'default' }}>
                      <td>
                        <div className="row-tight" style={{ fontWeight: 600 }}>
                          {isFolder ? <FolderIcon size={13} color="var(--info)" /> : <FileIcon size={13} color="var(--ink-3)" />}
                          {s.targetName ?? s.assetName}
                        </div>
                        <div className="t-small">
                          {isFolder ? `${pluralise(s.fileCount, 'file')} · ` : s.songTitle ? `${s.songTitle} · ` : ''}
                          {s.canDownload ? 'download allowed' : 'preview only'}
                          {s.note ? ` · ${s.note}` : ''}
                        </div>
                      </td>
                      <td className="t-small">
                        <span className="row-tight"><Audience size={12} /> {s.audienceLabel ?? 'Open to all'}</span>
                        {s.allowedEmails?.length > 0 && (
                          <div className="t-small" style={{ fontSize: 13.5 }}>{s.allowedEmails.join(', ')}</div>
                        )}
                      </td>
                      <td><span className="badge" data-status={st.status}><span className="dot" />{st.label}</span></td>
                      <td className="t-small">
                        {s.revokedAt ? `revoked ${relative(s.revokedAt)}`
                          : s.expired ? date(s.expiresAt)
                          : <span className="row-tight"><Clock size={12} /> {countdown(s.remainingMs)}</span>}
                      </td>
                      <td className="t-small" style={{ fontFamily: 'var(--mono)' }}>
                        <span className="row-tight"><Download size={12} /> {s.downloadCount}{s.maxDownloads ? ` / ${s.maxDownloads}` : ''}</span>
                      </td>
                      <td className="t-small">{s.createdByName}</td>
                      <td>
                        <div className="row-tight" style={{ justifyContent: 'flex-end' }}>
                          {st.label === 'Live' && <CopyButton value={s.url} label="Copy" />}
                          {can('share:revoke') && !s.revokedAt && (
                            <button className="btn btn-danger btn-sm" onClick={() => setRevoking(s)}>
                              <Ban size={12} /> Revoke
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {revoking && (
        <ConfirmDialog
          title="Revoke this link?"
          danger
          body={
            <>
              <b>{revoking.targetName ?? revoking.assetName}</b> becomes unreachable through this link immediately, even for
              someone who already has it open. You can always create a new one.
            </>
          }
          confirmLabel="Revoke now"
          onConfirm={() => revoke.mutate(revoking._id)}
          onClose={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
