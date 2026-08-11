// Storage health — the drift dashboard (§10.11). Its job is to answer two questions
// honestly: does the catalogue still match the Google Drive, and is there room left?
//
// A Drive fills up, and when it does every upload stops. So quota is the first thing on
// this page rather than a footnote.
//
// The first question got harder, and more interesting. A Drive is a place people can open
// and rearrange by hand — files get renamed, dragged between folders and dropped in the
// bin without the app ever hearing about it. None of that is corruption, so most findings
// here are a disagreement to settle rather than damage to repair, and each one offers both
// answers: believe Drive, or push the catalogue's version back onto it.
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ShieldCheck, RefreshCw, Loader2, AlertTriangle, CheckCircle2, Database,
  HardDrive, FileWarning, Info, ExternalLink, Folder as FolderIcon, Trash2,
} from 'lucide-react';
import { api } from '../../lib/api';
import { AvailabilityBadge, EmptyState, Modal, Skeleton, useToast } from '../../components/ui';
import { AssetList } from '../assets/AssetCard';
import { Pagination } from '../../components/Pagination';
import { AssetDrawer } from '../assets/AssetDrawer';
import { bytes, pluralise, relative } from '../../lib/format';
import { FINDING_COPY, STATUS_COPY } from '../../lib/assetTypes';
import type { Availability, Finding, Quota, SongRow, StorageHealth as Health } from '../../lib/types';

interface Remedy { action: string; label: string; hint: string; danger?: boolean; needsSong?: boolean }

// Where a finding has two defensible answers, both are offered and neither is preselected.
// Guessing which side an admin wants — Drive's version or the catalogue's — is exactly the
// decision a tool should not make on their behalf.
const REMEDIES: Record<string, Remedy[]> = {
  MISSING_IN_DRIVE: [
    { action: 'mark-lost', label: 'Mark permanently lost', hint: 'Flags the record so nobody keeps trying to download it. Re-upload later to replace it.', danger: true },
    { action: 'adopt', label: 'Re-scan and adopt', hint: 'If the file turned up somewhere else in the Drive, this brings it back under management.' },
  ],
  TRASHED_IN_DRIVE: [
    { action: 'untrash', label: 'Restore it from the bin', hint: 'Instant and free. Do this before Google empties the trash — after that, nothing can bring it back.' },
    { action: 'mark-lost', label: 'It was meant to go', hint: 'Accepts the deletion and flags the record as lost.', danger: true },
  ],
  UNTRACKED_IN_DRIVE: [
    { action: 'adopt', label: 'Adopt into the catalogue', hint: 'Creates a record so the file becomes searchable, taggable and shareable here.', needsSong: true },
    { action: 'quarantine', label: 'Move to Quarantine', hint: 'Sets it aside in the Quarantine folder without deleting anything, pending a decision.' },
    { action: 'delete-orphan', label: 'Move it to the bin', hint: 'Trashes the file in Google Drive. Recoverable for 30 days if you change your mind.', danger: true },
  ],
  UNTRACKED_FOLDER: [
    { action: 'adopt-folder', label: 'Adopt the folder', hint: 'Creates a GCloud folder for it. Run the check again afterwards to adopt what is inside.' },
    { action: 'accept', label: 'Leave it alone', hint: 'Not everything in the Drive has to be part of the library.' },
  ],
  SIZE_MISMATCH: [
    { action: 'accept-storage-truth', label: 'Accept Google Drive as the truth', hint: 'Updates the catalogue to match the file that is actually there.' },
  ],
  CHECKSUM_MISMATCH: [
    { action: 'accept-storage-truth', label: 'Accept Google Drive as the truth', hint: 'Updates the catalogue to match the file that is actually there.' },
  ],
  PARENT_DRIFT: [
    { action: 'follow-drive-folder', label: 'Follow the move', hint: 'Files it under wherever it now sits in Drive, creating the folder here if it is new.' },
    { action: 'move-back', label: 'Put it back', hint: 'Moves the Drive file back into the folder the catalogue says it belongs to.' },
  ],
  NAME_DRIFT: [
    { action: 'accept-drive-name', label: 'Use the name from Drive', hint: 'Somebody renamed it there on purpose. Adopt that name here.' },
    { action: 'restore-catalogue-name', label: 'Restore the catalogue name', hint: 'Renames the Drive file back to what GCloud calls it.' },
  ],
};

// Sizing a bar against a limit that may not exist. A Shared Drive on a pooled Workspace
// plan reports no limit at all, and "unlimited" is a real answer rather than a missing one.
function QuotaPanel({ quota, trashDays }: { quota: Quota; trashDays: number }) {
  const critical = !quota.unlimited && quota.percentUsed >= 90;
  const warn = !quota.unlimited && quota.percentUsed >= 75;

  const segments = quota.unlimited ? [] : [
    { label: 'This library', value: quota.libraryBytes ?? 0, colour: 'var(--indigo)' },
    { label: 'Other files in the Drive', value: quota.otherDriveBytes ?? 0, colour: 'var(--indigo-soft)' },
    { label: 'In the bin', value: quota.usageInTrash, colour: 'var(--mismatch)' },
    { label: 'Gmail and Photos', value: quota.usageElsewhere, colour: 'var(--ink-3)' },
  ].filter((seg) => seg.value > 0);

  return (
    <div className={`panel ${critical ? 'danger' : ''}`} style={critical ? { borderColor: 'var(--danger)' } : undefined}>
      <div className="panel-head spread">
        <span className="t-h3 row-tight"><HardDrive size={15} color="var(--ink-3)" /> Space in Google Drive</span>
        {quota.account && <span className="t-small">{quota.account.email}</span>}
      </div>
      <div className="panel-body stack-3">
        {quota.unlimited ? (
          <div className="note ok">
            <CheckCircle2 size={15} />
            <div>
              <b>No storage limit.</b> This is a Shared Drive on a pooled Workspace plan, so the
              library is not competing with anybody&rsquo;s inbox for room.
            </div>
          </div>
        ) : (
          <>
            <div className="spread" style={{ alignItems: 'baseline' }}>
              <span style={{ fontSize: 30, fontWeight: 700, color: critical ? 'var(--danger-ink)' : 'var(--ink)' }}>
                {bytes(quota.available ?? 0)}
              </span>
              <span className="t-small">free of {bytes(quota.limit ?? 0)}</span>
            </div>

            {/* One bar, segmented by what is actually consuming the space — because
                "you are 94% full" is far less useful than "38% of that is your bin". */}
            <div style={{ display: 'flex', height: 10, borderRadius: 6, overflow: 'hidden', background: 'var(--surface-2)' }}>
              {segments.map((seg) => (
                <div
                  key={seg.label}
                  title={`${seg.label} — ${bytes(seg.value)}`}
                  style={{ width: `${(seg.value / (quota.limit || 1)) * 100}%`, background: seg.colour }}
                />
              ))}
            </div>

            <div className="stack-2">
              {segments.map((seg) => (
                <div key={seg.label} className="spread">
                  <span className="row-tight t-small">
                    <span style={{ width: 9, height: 9, borderRadius: 3, background: seg.colour, display: 'inline-block' }} />
                    {seg.label}
                  </span>
                  <span className="t-small t-mono">{bytes(seg.value)}</span>
                </div>
              ))}
            </div>

            {quota.usageInTrash > 0 && (
              <div className="note">
                <Trash2 size={15} />
                <div>
                  <b>{bytes(quota.usageInTrash)} is sitting in the bin and still counts against the
                  limit.</b> Google frees it {trashDays} days after each file was trashed, or
                  immediately if the bin is emptied by hand — which is on the De-duplication page,
                  because that is where it is usually wanted.
                </div>
              </div>
            )}

            {critical && (
              <div className="note danger">
                <AlertTriangle size={15} />
                <div>
                  <b>Uploads stop working when this reaches zero.</b> Free space by emptying the bin
                  and removing duplicates, or move the library to a Shared Drive with a pooled
                  Workspace allowance.
                </div>
              </div>
            )}
            {!critical && warn && (
              <div className="hint">
                Past three quarters full. Worth clearing duplicates before it becomes urgent.
              </div>
            )}
          </>
        )}

        {quota.maxUploadSize && (
          <div className="hint">Largest single file Google will accept: {bytes(quota.maxUploadSize)}.</div>
        )}
      </div>
    </div>
  );
}

export function StorageHealth() {
  const [remedy, setRemedy] = useState<Finding | null>(null);
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const [params] = useSearchParams();
  const [reviewPageNo, setReviewPageNo] = useState(1);
  const [reviewSize, setReviewSize] = useState(50);
  const reviewRef = useRef<HTMLElement>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['storage-health'],
    queryFn: () => api<Health>('/admin/storage/health'),
  });

  // Home's Review button arrives with ?focus=review. Landing at the top of a long page
  // and leaving somebody to hunt for what they were sent to look at is not an answer, so
  // the section is scrolled to as soon as there is something to scroll to.
  const focused = params.get('focus') === 'review';
  useEffect(() => {
    if (!focused || !data) return;
    // Guarded rather than called straight: scrolling is a nicety, and a page that throws
    // because the environment has no scrollIntoView would fail at showing the very thing
    // the reader was sent here to see.
    const target = reviewRef.current;
    if (typeof target?.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [focused, data]);

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
  // The same number Home shows on its Review button, computed from the same two states.
  const needingDecision = (data.byStatus.MISSING ?? 0) + (data.byStatus.MISMATCH ?? 0);

  // The API already ranks and caps this list, so paging is a slice of what arrived rather
  // than another round trip.
  const reviewPage = reviewSize === 0
    ? data.attention
    : data.attention.slice((reviewPageNo - 1) * reviewSize, reviewPageNo * reviewSize);

  return (
    <div className="page stack-5">
      <div className="spread page-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <h1 className="t-h1">Storage health</h1>
          <p className="t-body" style={{ maxWidth: '66ch', marginTop: 6 }}>
            Google Drive holds the files; the catalogue describes them. This page compares the two
            and reports every disagreement — including the ones somebody caused by working in Drive
            directly, which is normal and not a fault. Where they differ, Drive is the truth.
          </p>
        </div>
        <button className="btn btn-spark" disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>
          {reconcile.isPending ? <Loader2 size={16} /> : <RefreshCw size={16} />}
          {reconcile.isPending ? 'Comparing…' : 'Run the check now'}
        </button>
      </div>

      {/* Space first. Everything else on this page is moot if there is no room left. */}
      {data.quota && (
        <QuotaPanel quota={data.quota} trashDays={data.storage?.trashRecoverableForDays ?? 30} />
      )}

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
          {run && (
            <> Last compared {relative(run.finishedAt)} — {run.objectsScanned} Drive files across{' '}
              {run.foldersScanned ?? 0} folders, took {(run.durationMs / 1000).toFixed(1)}s.
            </>
          )}
        </div>
      </div>

      {/* Status split.
          The tiles are the whole section. A summary panel above them restated the same six
          numbers in smaller type next to a percentage, so the screen said everything twice
          and neither copy was the obvious one to read. */}
      <section>
        <h2 className="t-h2" style={{ marginBottom: 13 }}>Where every file stands</h2>

        <div className="tiles">
          {(Object.entries(data.byStatus) as [Availability, number][]).map(([status, n]) => (
            <Link
              key={status}
              to={`/?availability=${status}`}
              className="stat"
              data-status={status}
              style={{
                textDecoration: 'none',
                borderColor: n > 0 && ['MISSING', 'MISMATCH'].includes(status) ? 'var(--st)' : undefined,
              }}
            >
              <div style={{ marginBottom: 8 }}><AvailabilityBadge status={status} /></div>
              <div className="stat-v" style={{ fontSize: 28, color: n > 0 ? 'var(--st-ink)' : 'var(--ink-3)' }}>{n}</div>
              <div className="stat-n" style={{ whiteSpace: 'normal' }}>{STATUS_COPY[status].short}</div>
            </Link>
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
            body="The catalogue and Google Drive agree on every file — same files, same sizes, same checksums, same folders."
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
                        <div style={{ fontWeight: 700, fontSize: 16, wordBreak: 'break-word' }}>{f.displayName}</div>
                        {f.songTitle && <div className="t-small">{f.songTitle}</div>}
                        <p className="t-body" style={{ fontSize: 15, margin: '7px 0 0', maxWidth: '64ch' }}>{copy.meaning}</p>
                        <div className="keytext" style={{ display: 'inline-block', marginTop: 8, fontSize: 13.5 }}>
                          {f.fileId ?? f.key}
                        </div>
                        <div className="t-small" style={{ marginTop: 6 }}>{f.detail}</div>
                      </div>

                      <div className="row-tight" style={{ flexWrap: 'wrap' }}>
                        {/* Seeing the file in Drive is very often the whole investigation, so it
                            is one click rather than a copy-the-id-and-go-hunting exercise. */}
                        {f.webViewLink && (
                          <a className="btn btn-ghost btn-sm" href={f.webViewLink} target="_blank" rel="noreferrer">
                            <ExternalLink size={13} /> View in Drive
                          </a>
                        )}
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

      {/* Files needing a check.
          Home states how many of these there are and sends the reader here; this is where
          the files themselves live, alongside everything that can be done about them. */}
      {data.attention.length > 0 && (
        <section id="review" ref={reviewRef} style={focused ? { scrollMarginTop: 84 } : undefined}>
          <div className="spread" style={{ marginBottom: 13, flexWrap: 'wrap', gap: 10 }}>
            <h2 className="t-h2 row-tight">
              <FileWarning size={16} color="var(--ink-3)" /> Files needing review
            </h2>
            <span className="t-small">
              {pluralise(needingDecision, 'file')} missing or mismatched
            </span>
          </div>
          {focused && (
            <div className="note" style={{ marginBottom: 13 }}>
              <Info size={15} />
              <div>
                Each of these is catalogued but its stored object is missing or does not match.
                Open one to see the full record, or use <b>What the comparison found</b> above to
                settle it — nothing else in the library is affected.
              </div>
            </div>
          )}

          <AssetList
            assets={reviewPage}
            selectedId={openAsset}
            onOpen={(a) => setOpenAsset(a.assetId)}
          />

          <Pagination
            page={reviewPageNo}
            pageSize={reviewSize}
            total={data.attention.length}
            onPage={setReviewPageNo}
            onPageSize={(n) => { setReviewSize(n); setReviewPageNo(1); }}
            noun="file"
          />
        </section>
      )}

      {/* Distribution */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px,1fr))', gap: 18 }}>
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
          <div className="panel-head"><span className="t-h3 row-tight"><FolderIcon size={15} color="var(--ink-3)" /> By folder</span></div>
          <div className="panel-body stack-2">
            {Object.entries(data.byFolder)
              .sort((a, b) => b[1].bytes - a[1].bytes)
              .slice(0, 8)
              .map(([name, v]) => (
                <div key={name} className="spread">
                  <span className="t-small truncate" style={{ fontWeight: 600 }}>{name}</span>
                  <span className="t-small">{pluralise(v.count, 'file')} · {bytes(v.bytes)}</span>
                </div>
              ))}
            <div className="hint" style={{ marginTop: 6 }}>
              These are real Google Drive folders, laid out exactly as they appear at
              drive.google.com.
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><span className="t-h3">The connected Drive</span></div>
          <div className="panel-body stack-2">
            <div>
              <div className="t-small">Account</div>
              <div className="t-mono" style={{ fontSize: 14.5 }}>{data.storage?.account?.email ?? '—'}</div>
            </div>
            <div>
              <div className="t-small">Sign-in method</div>
              <div className="t-mono" style={{ fontSize: 14.5 }}>
                {data.storage?.mode === 'oauth' ? 'OAuth user account' : 'Service account'}
              </div>
            </div>
            <div>
              <div className="t-small">Location</div>
              <div className="t-mono" style={{ fontSize: 14.5 }}>
                {data.storage?.sharedDriveId ? `Shared Drive ${data.storage.sharedDriveId}` : 'My Drive'}
              </div>
            </div>
            <div>
              <div className="t-small">Library root folder</div>
              <div className="keytext" style={{ fontSize: 13.5 }}>{data.storage?.rootFolderId ?? '—'}</div>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              Nothing in this folder is shared publicly. Every download here is a short-lived signed
              link that GCloud issues and can revoke, never a Google sharing permission.
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
    enabled: finding.kind === 'UNTRACKED_IN_DRIVE',
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
            disabled={!chosen || apply.isPending}
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
          <div>
            {FINDING_COPY[finding.kind]?.meaning}
            <br />
            <span className="t-mono" style={{ fontSize: 14 }}>{finding.fileId ?? finding.key}</span>
            {finding.webViewLink && (
              <>
                {' · '}
                <a href={finding.webViewLink} target="_blank" rel="noreferrer">open it in Google Drive</a>
              </>
            )}
          </div>
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
                  <option value="">No song — file it loose</option>
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
