import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Share2, Ban, Clock, Download, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { CopyButton, EmptyState, Skeleton, useToast, ConfirmDialog } from '../../components/ui';
import { countdown, date, relative } from '../../lib/format';
import type { Share } from '../../lib/types';
import { useState } from 'react';
import { useSession } from '../../app/session';

export function ShareManager() {
  const [revoking, setRevoking] = useState<Share | null>(null);
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

  const state = (s: Share) =>
    s.revokedAt ? { label: 'Revoked', status: 'MISSING' }
      : s.expired ? { label: 'Expired', status: 'UNVERIFIED' }
      : s.exhausted ? { label: 'Limit reached', status: 'RESTORING' }
      : { label: 'Live', status: 'AVAILABLE' };

  const live = data?.data.filter((s) => !s.revokedAt && !s.expired && !s.exhausted) ?? [];

  return (
    <div className="page stack-4">
      <div className="page-head">
        <h1 className="t-h1">Share links</h1>
        <p className="t-body" style={{ maxWidth: '64ch', marginTop: 6 }}>
          Links you have sent outside the company. Each one expires on its own, can be capped by
          download count, and can be switched off instantly. Create one from any file’s Share button.
        </p>
      </div>

      {!isLoading && (data?.data.length ?? 0) > 0 && (
        <div className="tiles">
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

      {isLoading ? (
        <Skeleton h={260} />
      ) : (data?.data.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Share2 size={26} />}
          title="No links yet"
          body="Open any file and press Share to create a link a partner can open without an account. You stay in control of how long it lasts and how many times it can be used."
        />
      ) : (
        <div className="panel" style={{ overflow: 'hidden' }}>
          <table className="tbl">
            <thead>
              <tr><th>File</th><th>Status</th><th>Expires</th><th>Downloads</th><th>Created by</th><th /></tr>
            </thead>
            <tbody>
              {data!.data.map((s) => {
                const st = state(s);
                return (
                  <tr key={s._id} style={{ cursor: 'default' }}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{s.assetName}</div>
                      <div className="t-small">
                        {s.songTitle ? `${s.songTitle} · ` : ''}
                        {s.canDownload ? 'download allowed' : 'preview only'}
                        {s.note ? ` · ${s.note}` : ''}
                      </div>
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
      )}

      <div className="note indigo">
        <ShieldCheck size={15} />
        <div>
          <b>How these stay safe.</b> A link never exposes a permanent address. When someone opens it,
          Maestro checks the file is still really in storage, then issues a signed address that
          works for an hour at most. Every open is recorded with time and IP.
        </div>
      </div>

      {revoking && (
        <ConfirmDialog
          title="Revoke this link?"
          danger
          body={
            <>
              <b>{revoking.assetName}</b> becomes unreachable through this link immediately, even for
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
