// Storage health — the drift dashboard (§10.11). Its job is to answer one question
// honestly: does the catalogue still match the bucket? Every finding comes with the
// actions an admin can actually take, described in plain language.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ShieldCheck, RefreshCw, Loader2, AlertTriangle, CheckCircle2, Database,
  HardDrive, FileWarning, Info,
} from 'lucide-react';
import { api } from '../../lib/api';
import { AvailabilityBadge, EmptyState, Modal, Skeleton, useToast } from '../../components/ui';
import { AssetCard } from '../assets/AssetCard';
import { AssetDrawer } from '../assets/AssetDrawer';
import { bytes, date, pluralise, relative } from '../../lib/format';
import { FINDING_COPY, STATUS_COPY } from '../../lib/assetTypes';
import type { Availability, Finding, SongRow, StorageHealth as Health } from '../../lib/types';

const REMEDIES: Record<string, { action: string; label: string; hint: string; danger?: boolean; needsSong?: boolean }[]> = {
  MISSING_IN_S3: [
    { action: 'mark-lost', label: 'Mark permanently lost', hint: 'Flags the record so nobody keeps trying to download it. Re-upload later to replace it.', danger: true },
  ],
  UNTRACKED_IN_S3: [
    { action: 'adopt', label: 'Adopt into the catalogue', hint: 'Creates a record for this object so it becomes searchable.', needsSong: true },
    { action: 'quarantine', label: 'Move to quarantine', hint: 'Sets it aside without deleting anything, pending a decision.' },
    { action: 'delete-orphan', label: 'Delete the object', hint: 'Removes it from storage. Only do this if you are certain it is junk.', danger: true },
  ],
  SIZE_MISMATCH: [
    { action: 'accept-storage-truth', label: 'Accept storage as the truth', hint: 'Updates the catalogue to match what is actually stored.' },
  ],
  ETAG_MISMATCH: [
    { action: 'accept-storage-truth', label: 'Accept storage as the truth', hint: 'Updates the catalogue to match what is actually stored.' },
  ],
  CLASS_DRIFT: [
    { action: 'accept', label: 'Accept', hint: 'Expected after a lifecycle transition. Nothing is wrong.' },
  ],
};

export function StorageHealth() {
  const [remedy, setRemedy] = useState<Finding | null>(null);
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['storage-health'],
    queryFn: () => api<Health>('/admin/storage/health'),
  });

  const reconcile = useMutation({
    mutationFn: () => api<{ counts: Record<string, number>; objectsScanned: number }>('/admin/storage/reconcile', { method: 'POST' }),
    onSuccess: (run) => {
      qc.invalidateQueries();
      const issues = Object.entries(run.counts).filter(([k]) => k !== 'CLASS_DRIFT').reduce((n, [, v]) => n + v, 0);
      toast({
        kind: issues ? 'warn' : 'ok',
        title: issues ? `${pluralise(issues, 'issue')} found` : 'Everything matches',
        body: `Compared ${run.objectsScanned} stored objects against the catalogue.`,
      });
    },
  });

  if (isLoading || !data) {
    return <div className="page stack-3"><Skeleton h={32} w="34%" /><Skeleton h={130} /><Skeleton h={280} /></div>;
  }

  const run = data.lastRunFull;
  // Most urgent first — a missing file must never sit below a routine lifecycle note.
  const RANK: Record<string, number> = { critical: 0, integrity: 1, orphan: 2, informational: 3 };
  const open = (run?.findings ?? [])
    .filter((f) => !f.resolvedAt)
    .sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));
  const critical = open.filter((f) => f.severity === 'critical');

  return (
    <div className="page stack-5">
      <div className="spread page-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <h1 className="t-h1">Storage health</h1>
          <p className="t-body" style={{ maxWidth: '64ch', marginTop: 6 }}>
            Storage holds the files; the catalogue describes them. This page compares the two and
            reports every disagreement. When they differ, storage is treated as the truth.
          </p>
        </div>
        <button className="btn btn-spark" disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>
          {reconcile.isPending ? <Loader2 size={16} /> : <RefreshCw size={16} />}
          {reconcile.isPending ? 'Comparing…' : 'Run the check now'}
        </button>
      </div>

      {/* Headline verdict */}
      <div className={`note ${critical.length ? 'danger' : 'ok'}`}>
        {critical.length ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
        <div>
          {critical.length ? (
            <>
              <b>{pluralise(critical.length, 'file is', 'files are')} catalogued but not in storage.</b> Nothing
              can be downloaded or shared until each one is resolved below.
            </>
          ) : (
            <>
              <b>Every catalogued file is present in storage.</b>{' '}
              {open.length > 0 && `${pluralise(open.length, 'lower-priority note')} below.`}
            </>
          )}
          {run && <> Last compared {relative(run.finishedAt)} — {run.objectsScanned} objects, took {(run.durationMs / 1000).toFixed(1)}s.</>}
        </div>
      </div>

      {/* Status split */}
      <section>
        <h2 className="t-h2" style={{ marginBottom: 13 }}>Every file, by state</h2>
        <div className="tiles">
          {(Object.entries(data.byStatus) as [Availability, number][]).map(([status, n]) => (
            <div key={status} className="stat plain" data-status={status} style={{ borderColor: n > 0 && ['MISSING', 'MISMATCH'].includes(status) ? 'var(--st)' : undefined }}>
              <div style={{ marginBottom: 8 }}><AvailabilityBadge status={status} /></div>
              <div className="stat-v" style={{ fontSize: 26, color: n > 0 ? 'var(--st-ink)' : 'var(--ink-3)' }}>{n}</div>
              <div className="stat-n" style={{ whiteSpace: 'normal' }}>{STATUS_COPY[status].short}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Findings */}
      <section>
        <div className="spread" style={{ marginBottom: 13 }}>
          <h2 className="t-h2 row-tight"><FileWarning size={16} color="var(--ink-3)" /> What the comparison found</h2>
          <span className="t-small">{open.length} open · {(run?.findings.length ?? 0) - open.length} resolved</span>
        </div>

        {open.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck size={26} />}
            title="No disagreements"
            body="The catalogue and storage agree on every file — same objects, same sizes, same checksums."
          />
        ) : (
          <div className="stack-3">
            {open.map((f) => {
              const copy = FINDING_COPY[f.kind];
              const severity = f.severity === 'critical' ? 'danger' : f.severity === 'informational' ? 'neutral' : '';
              return (
                <div key={f._id} className="panel" style={{ borderLeft: `3px solid ${f.severity === 'critical' ? 'var(--danger)' : f.severity === 'informational' ? 'var(--info)' : 'var(--mismatch)'}` }}>
                  <div className="panel-body">
                    <div className="spread" style={{ alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
                      <div className="grow" style={{ minWidth: 240 }}>
                        <div className="row-tight" style={{ marginBottom: 5 }}>
                          <span className="eyebrow" style={{ color: f.severity === 'critical' ? 'var(--danger-ink)' : 'var(--ink-3)' }}>
                            {copy.label}
                          </span>
                        </div>
                        <div style={{ fontWeight: 700, fontSize: 14, wordBreak: 'break-word' }}>{f.displayName}</div>
                        {f.songTitle && <div className="t-small">{f.songTitle}</div>}
                        <p className="t-body" style={{ fontSize: 13, margin: '7px 0 0', maxWidth: '64ch' }}>{copy.meaning}</p>
                        <div className="keytext" style={{ display: 'inline-block', marginTop: 8, fontSize: 11 }}>{f.key}</div>
                        <div className="t-small" style={{ marginTop: 6 }}>{f.detail}</div>
                      </div>

                      <div className="row-tight" style={{ flexWrap: 'wrap' }}>
                        {f.assetId && (
                          <button className="btn btn-ghost btn-sm" onClick={() => setOpenAsset(f.assetId!)}>Open file</button>
                        )}
                        <button className="btn btn-secondary btn-sm" onClick={() => setRemedy(f)}>Decide what to do</button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Files needing a check */}
      {data.attention.length > 0 && (
        <section>
          <h2 className="t-h2" style={{ marginBottom: 13 }}>Files worth a look</h2>
          <div className="cards">
            {data.attention.slice(0, 12).map((a) => (
              <AssetCard key={a.assetId} asset={a} onOpen={(x) => setOpenAsset(x.assetId)} />
            ))}
          </div>
        </section>
      )}

      {/* Distribution */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px,1fr))', gap: 18 }}>
        <div className="panel">
          <div className="panel-head"><span className="t-h3 row-tight"><HardDrive size={15} color="var(--ink-3)" /> By storage tier</span></div>
          <div className="panel-body stack-2">
            {Object.entries(data.byClass).map(([cls, v]) => (
              <div key={cls} className="spread">
                <span className="t-mono t-small">{cls}</span>
                <span className="t-small">{pluralise(v.count, 'file')} · {bytes(v.bytes)}</span>
              </div>
            ))}
            <div className="hint" style={{ marginTop: 6 }}>
              Rarely-opened footage moves to cheaper, slower tiers automatically. Those files show as
              “Archived” and need a restore before download.
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><span className="t-h3 row-tight"><Database size={15} color="var(--ink-3)" /> By kind of file</span></div>
          <div className="panel-body stack-2">
            {Object.entries(data.byFamily).map(([fam, v]) => (
              <div key={fam} className="spread">
                <span className="t-small" style={{ fontWeight: 600 }}>{fam}</span>
                <span className="t-small">{pluralise(v.count, 'file')} · {bytes(v.bytes)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><span className="t-h3">Buckets</span></div>
          <div className="panel-body stack-2">
            {Object.entries(data.buckets).map(([role, name]) => (
              <div key={role}>
                <div className="t-small" style={{ textTransform: 'capitalize' }}>{role}</div>
                <div className="keytext" style={{ fontSize: 11 }}>{name}</div>
              </div>
            ))}
            <div className="hint" style={{ marginTop: 6 }}>
              None of these is publicly readable. Every read and write is signed and short-lived.
            </div>
          </div>
        </div>
      </section>

      {remedy && <RemedyDialog finding={remedy} onClose={() => setRemedy(null)} />}
      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
    </div>
  );
}

function RemedyDialog({ finding, onClose }: { finding: Finding; onClose: () => void }) {
  const [songId, setSongId] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const { data: songs } = useQuery({
    queryKey: ['songs', ''],
    queryFn: () => api<{ data: SongRow[] }>('/songs'),
    enabled: finding.kind === 'UNTRACKED_IN_S3',
  });

  const apply = useMutation({
    mutationFn: (action: string) =>
      api<{ note: string }>(`/admin/storage/findings/${finding._id}/resolve`, {
        method: 'POST',
        body: { action, songId },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast({ kind: 'ok', title: 'Resolved', body: r.note });
      onClose();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not resolve', body: e.message }),
  });

  const options = REMEDIES[finding.kind] ?? [];

  return (
    <Modal
      title="Decide what to do"
      subtitle={finding.displayName}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!chosen || apply.isPending || (options.find((o) => o.action === chosen)?.needsSong && !songId)}
            onClick={() => chosen && apply.mutate(chosen)}
          >
            Apply
          </button>
        </>
      }
    >
      <div className="stack-3">
        <div className="note neutral">
          <Info size={15} />
          <div>{FINDING_COPY[finding.kind].meaning}<br /><span className="t-mono" style={{ fontSize: 11.5 }}>{finding.key}</span></div>
        </div>

        {options.map((o) => (
          <label
            key={o.action}
            className="panel"
            style={{
              display: 'block', cursor: 'pointer', padding: 14, boxShadow: 'none',
              borderColor: chosen === o.action ? 'var(--indigo)' : 'var(--line)',
              background: chosen === o.action ? 'var(--indigo-soft)' : 'var(--surface)',
            }}
          >
            <div className="check">
              <input type="radio" name="remedy" checked={chosen === o.action} onChange={() => setChosen(o.action)} style={{ accentColor: 'var(--indigo)' }} />
              <span>
                <span className="label" style={{ color: o.danger ? 'var(--danger-ink)' : undefined }}>{o.label}</span>
                <span className="hint">{o.hint}</span>
              </span>
            </div>

            {o.needsSong && chosen === o.action && (
              <div className="field" style={{ marginTop: 12 }}>
                <label className="label">Attach it to which song?</label>
                <select className="select" value={songId} onChange={(e) => setSongId(e.target.value)}>
                  <option value="">Choose a song…</option>
                  {songs?.data.map((s) => <option key={s._id} value={s._id}>{s.title} — {s.artistName}</option>)}
                </select>
              </div>
            )}
          </label>
        ))}
      </div>
    </Modal>
  );
}
