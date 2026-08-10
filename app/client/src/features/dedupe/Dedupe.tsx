// De-duplication (§10.12).
//
// The screen exists for one complaint: "the same video is in four folders and I daren't
// delete any of them because I can't tell if they're actually the same." So the page is
// built around removing that doubt, not around a number.
//
// Two design decisions do most of the work:
//
//   Certainty is visible, and it comes first. A checksum match is a fact — Google computed
//   it, we did not, and it cannot be a coincidence. A name match is a hunch. Those two
//   things are labelled completely differently, coloured differently, and the destructive
//   action is only offered by default on the first. A tool that presents a guess with the
//   same confidence as a fact gets used once and then distrusted forever.
//
//   Deleting is not the only answer, or even the first one. "Link" keeps every catalogue
//   entry exactly where it is — the video still appears in all four folders, because it
//   genuinely belongs in all four — and points them at one Drive file so the bytes exist
//   once. That is usually what somebody actually wants, and no filesystem-shaped tool
//   offers it.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy, Loader2, Trash2, Link2, Layers, EyeOff, RefreshCw, AlertTriangle,
  CheckCircle2, Info, ExternalLink, Sparkles, HardDrive, ChevronDown,
} from 'lucide-react';
import { api, qs } from '../../lib/api';
import { EmptyState, Modal, Skeleton, useToast } from '../../components/ui';
import { bytes, date, pluralise, relative } from '../../lib/format';
import { useSession } from '../../app/session';
import { AssetDrawer } from '../assets/AssetDrawer';
import type { DuplicateGroup, DuplicateMember, DuplicateReport } from '../../lib/types';

// The language each tier is allowed to use. Getting this right is most of the feature:
// "identical" is a statement of fact, "worth a look" is an invitation to check.
const KIND: Record<string, {
  label: string;
  certainty: string;
  colour: string;
  icon: typeof Copy;
  canLink: boolean;
  defaultAction: 'trash' | 'version' | null;
}> = {
  IDENTICAL: {
    label: 'The same file, stored more than once',
    certainty: 'Certain',
    colour: 'var(--danger)',
    icon: Copy,
    canLink: true,
    defaultAction: 'trash',
  },
  PERCEPTUAL: {
    label: 'The same footage, encoded differently',
    certainty: 'Very likely',
    colour: 'var(--mismatch)',
    icon: Sparkles,
    canLink: false,
    defaultAction: null,
  },
  SAME_MEDIA: {
    label: 'Probably one video, exported twice',
    certainty: 'Likely',
    colour: 'var(--mismatch)',
    icon: Layers,
    canLink: false,
    defaultAction: null,
  },
  SAME_NAME: {
    label: 'Named alike — worth a look',
    certainty: 'Unconfirmed',
    colour: 'var(--info)',
    icon: EyeOff,
    canLink: false,
    defaultAction: null,
  },
};

export function Dedupe() {
  const [level, setLevel] = useState<'exact' | 'near' | 'all'>('all');
  const [family, setFamily] = useState('');
  const [resolving, setResolving] = useState<DuplicateGroup | null>(null);
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const can = useSession((s) => s.can);
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['dedupe', level, family],
    queryFn: () => api<DuplicateReport>(`/dedupe/scan${qs({ level, family })}`),
  });

  const buildHashes = useMutation({
    mutationFn: () => api<{ total: number }>('/dedupe/perceptual/build', { method: 'POST' }),
    onSuccess: (r) => toast({
      kind: 'info',
      title: 'Reading files back from Drive',
      body: `Hashing ${pluralise(r.total, 'file')}. This reads every one of them out of Google Drive, so it takes a while — the results appear as they land.`,
    }),
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not start', body: e.message }),
  });

  if (isLoading || !data) {
    return <div className="page stack-3"><Skeleton h={32} w="34%" /><Skeleton h={120} /><Skeleton h={300} /></div>;
  }

  const certain = data.groups.filter((g) => g.kind === 'IDENTICAL');
  const uncertain = data.groups.filter((g) => g.kind !== 'IDENTICAL');

  return (
    <div className="page stack-5">
      <div className="spread page-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <h1 className="t-h1">Duplicates</h1>
          <p className="t-body" style={{ maxWidth: '66ch', marginTop: 6 }}>
            The same file filed in two places is not a mistake — it is how people work. It only
            becomes a problem when nobody can tell which copies are genuinely the same. This page
            answers that, and separates what it knows from what it merely suspects.
          </p>
        </div>
        <button className="btn btn-secondary" disabled={isFetching} onClick={() => qc.invalidateQueries({ queryKey: ['dedupe'] })}>
          {isFetching ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
          Scan again
        </button>
      </div>

      {/* Headline. Only the certain tier is counted, because an overstated number that
          under-delivers is how a cleanup tool loses its user's trust permanently. */}
      <div className={`note ${certain.length ? 'warn' : 'ok'}`}>
        {certain.length ? <Copy size={16} /> : <CheckCircle2 size={16} />}
        <div>
          {certain.length ? (
            <>
              <b>
                {bytes(data.totals.certainReclaimableBytes)} of Google Drive is holding files it
                already has.
              </b>{' '}
              {pluralise(certain.length, 'group')} of byte-identical copies, confirmed by the
              checksum Google itself computed on upload.
              {data.totals.crossFolderGroups > 0 && (
                <> {pluralise(data.totals.crossFolderGroups, 'group spans', 'groups span')} more than one folder.</>
              )}
            </>
          ) : (
            <>
              <b>No file is stored twice.</b> Every file in the library has a distinct checksum.
              {uncertain.length > 0 && <> {pluralise(uncertain.length, 'set')} below look similar and are worth a glance.</>}
            </>
          )}
          <div className="t-small" style={{ marginTop: 4 }}>
            Scanned {data.assetsScanned} files in {data.durationMs}ms — no Drive calls needed, the
            checksums are already on every record.
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="segmented">
          {([['all', 'Everything'], ['exact', 'Identical only'], ['near', 'Identical + same media']] as const).map(([v, label]) => (
            <button key={v} className={level === v ? 'active' : ''} onClick={() => setLevel(v)}>{label}</button>
          ))}
        </div>
        <select className="select" style={{ maxWidth: 190 }} value={family} onChange={(e) => setFamily(e.target.value)}>
          <option value="">Every kind of file</option>
          {['Video', 'Audio', 'Image', 'Document'].map((f) => <option key={f} value={f}>{f} only</option>)}
        </select>
      </div>

      {/* Summary tiles */}
      {data.groups.length > 0 && (
        <div className="tiles">
          {Object.entries(data.byKind).map(([kind, v]) => {
            const meta = KIND[kind];
            return (
              <div key={kind} className="stat plain" style={{ borderLeft: `3px solid ${meta?.colour ?? 'var(--line)'}` }}>
                <div className="eyebrow" style={{ marginBottom: 6, color: meta?.colour }}>{meta?.certainty ?? kind}</div>
                <div className="stat-v" style={{ fontSize: 24 }}>{v.groups}</div>
                <div className="stat-n" style={{ whiteSpace: 'normal' }}>
                  {meta?.label ?? kind} · {pluralise(v.files, 'file')}
                  {v.reclaimableBytes > 0 && <> · {bytes(v.reclaimableBytes)}</>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {data.groups.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 size={26} />}
          title="Nothing is duplicated"
          body="Every file in the library is distinct. Upload a copy of something and it will show up here immediately — the check runs on Google's own checksums, so it does not need to read a single byte."
        />
      ) : (
        <div className="stack-4">
          {data.groups.map((group) => (
            <GroupCard
              key={group._id}
              group={group}
              canResolve={can('asset:delete')}
              onResolve={() => setResolving(group)}
              onOpenAsset={setOpenAsset}
            />
          ))}
        </div>
      )}

      {/* Perceptual tier — opt-in, and honest about what it costs. */}
      <section className="panel">
        <div className="panel-head"><span className="t-h3 row-tight"><Sparkles size={15} color="var(--ink-3)" /> Find the same footage at different resolutions</span></div>
        <div className="panel-body stack-3">
          <p className="t-body" style={{ fontSize: 13.5, margin: 0, maxWidth: '70ch' }}>
            Everything above compares checksums, sizes and names. None of that can tell you a 1080p
            master and its 720p re-encode are the same video — every byte differs. Perceptual
            hashing can: it samples frames from each file, reduces them to their broad light-and-dark
            structure, and compares those. Resolution, bitrate and compression artefacts live in the
            detail it throws away, which is exactly why it survives a re-encode.
          </p>
          <div className="hint">
            It has to read every video back out of Google Drive and decode it, so it is slow and
            costs bandwidth. It also needs <span className="keytext">ffmpeg</span> installed on the
            server. Run it once and the results are cached against each file until that file changes.
          </div>
          {data.perceptualEnabled ? (
            <div>
              <button className="btn btn-secondary" disabled={buildHashes.isPending} onClick={() => buildHashes.mutate()}>
                {buildHashes.isPending ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
                Build the hashes
              </button>
            </div>
          ) : (
            <div className="note neutral">
              <Info size={15} />
              <div>
                Turned off. Set <span className="keytext">DEDUPE_PERCEPTUAL=true</span> in
                <span className="keytext"> app/.env</span> and install ffmpeg to enable it. The other
                three tiers work without it.
              </div>
            </div>
          )}
        </div>
      </section>

      {can('asset:purge') && <EmptyTrashPanel />}

      {resolving && <ResolveDialog group={resolving} onClose={() => setResolving(null)} />}
      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
    </div>
  );
}

// ── One group ───────────────────────────────────────────────────────────────

function GroupCard({
  group, canResolve, onResolve, onOpenAsset,
}: {
  group: DuplicateGroup;
  canResolve: boolean;
  onResolve: () => void;
  onOpenAsset: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(group.kind === 'IDENTICAL');
  const meta = KIND[group.kind] ?? KIND.SAME_NAME;
  const Icon = meta.icon;

  return (
    <div className="panel" style={{ borderLeft: `3px solid ${meta.colour}` }}>
      <div className="panel-body stack-3">
        <div className="spread" style={{ alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
          <div className="grow" style={{ minWidth: 260 }}>
            <div className="row-tight" style={{ marginBottom: 4 }}>
              <Icon size={14} color={meta.colour} />
              <span className="eyebrow" style={{ color: meta.colour }}>{meta.certainty}</span>
              {group.spansFolders && (
                <span className="tag">across {pluralise(group.folders.length, 'folder')}</span>
              )}
            </div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{meta.label}</div>
            {/* The reason, in full. Never a score, never a percentage — a sentence saying
                what was compared and what it found. */}
            <p className="t-body" style={{ fontSize: 13, margin: '6px 0 0', maxWidth: '72ch' }}>{group.reason}</p>
          </div>

          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{bytes(group.reclaimableBytes)}</div>
            <div className="t-small">
              {group.reclaimableBytes > 0 ? 'recoverable' : 'already shared'} · {pluralise(group.count, 'file')}
            </div>
          </div>
        </div>

        <button className="btn btn-ghost btn-sm" style={{ paddingLeft: 0 }} onClick={() => setExpanded((v) => !v)}>
          <ChevronDown size={14} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
          {expanded ? 'Hide the files' : `Show all ${group.count} files`}
        </button>

        {expanded && (
          <div className="stack-2">
            {group.members.map((m) => (
              <MemberRow
                key={m.assetId}
                member={m}
                isKeeper={m.assetId === group.suggestedKeepId}
                onOpen={() => onOpenAsset(m.assetId)}
              />
            ))}
          </div>
        )}

        {canResolve && (
          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" onClick={onResolve}>Decide what to do</button>
            {group.kind !== 'IDENTICAL' && (
              <span className="t-small" style={{ maxWidth: '52ch' }}>
                These are not confirmed duplicates. Open a couple and compare them before removing
                anything.
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MemberRow({ member, isKeeper, onOpen }: { member: DuplicateMember; isKeeper: boolean; onOpen: () => void }) {
  return (
    <div
      className="panel"
      style={{
        boxShadow: 'none',
        background: isKeeper ? 'var(--ok-soft, var(--surface-2))' : 'var(--surface-2)',
        borderColor: isKeeper ? 'var(--ok)' : 'var(--line)',
      }}
    >
      <div className="panel-body spread" style={{ padding: 12, gap: 12, flexWrap: 'wrap' }}>
        <div className="grow" style={{ minWidth: 220 }}>
          <div className="row-tight">
            {isKeeper && <span className="tag ok">suggested keep</span>}
            {member.isLinkedCopy && <span className="tag">shares its file</span>}
            <button className="btn btn-ghost btn-sm" style={{ padding: 0, fontWeight: 700 }} onClick={onOpen}>
              {member.displayName}
            </button>
          </div>
          <div className="t-small" style={{ marginTop: 3 }}>
            {member.folderName ?? 'Library root'}
            {member.songTitle && <> · {member.songTitle}</>}
            {member.artistName && <> · {member.artistName}</>}
          </div>
          <div className="t-small">
            {bytes(member.sizeBytes)}
            {member.durationSec != null && <> · {Math.round(member.durationSec)}s</>}
            {member.dimensions && <> · {member.dimensions}</>}
            {' · '}uploaded {relative(member.createdAt)} by {member.uploadedByName}
          </div>
        </div>
        {member.webViewLink && (
          <a className="btn btn-ghost btn-sm" href={member.webViewLink} target="_blank" rel="noreferrer">
            <ExternalLink size={13} /> Drive
          </a>
        )}
      </div>
    </div>
  );
}

// ── Resolution ──────────────────────────────────────────────────────────────

function ResolveDialog({ group, onClose }: { group: DuplicateGroup; onClose: () => void }) {
  const meta = KIND[group.kind] ?? KIND.SAME_NAME;
  const [keepId, setKeepId] = useState(group.suggestedKeepId);
  const [action, setAction] = useState<string | null>(meta.defaultAction);
  const qc = useQueryClient();
  const toast = useToast();

  const resolve = useMutation({
    mutationFn: () => api<{ note: string; bytesReclaimed: number }>('/dedupe/resolve', {
      method: 'POST',
      body: { groupId: group._id, action, keepId },
    }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast({ kind: 'ok', title: 'Done', body: r.note });
      onClose();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not resolve', body: e.message }),
  });

  const options = [
    meta.canLink && {
      action: 'link',
      icon: Link2,
      label: 'Keep every entry, store the file once',
      hint: `All ${group.count} entries stay exactly where they are — the file keeps appearing in every folder it was filed under, and every share link keeps working. They are pointed at one Drive file and the redundant copies go to the bin. This is usually the right answer.`,
      recommended: true,
    },
    {
      action: 'trash',
      icon: Trash2,
      label: 'Keep one, bin the rest',
      hint: `Removes the other ${group.count - 1} from the library and moves them to the Google Drive bin — recoverable for 30 days if this turns out to be wrong.`,
      danger: true,
    },
    {
      action: 'version',
      icon: Layers,
      label: 'They are takes of one thing',
      hint: 'Not duplicates at all — different cuts or revisions. Groups them into one version history so they read as a lineage instead of clutter. Nothing is deleted.',
    },
    {
      action: 'ignore',
      icon: EyeOff,
      label: 'These are meant to be separate',
      hint: 'Dismisses this group so it stops appearing. The decision survives future scans.',
    },
  ].filter(Boolean) as { action: string; icon: typeof Copy; label: string; hint: string; danger?: boolean; recommended?: boolean }[];

  const needsKeeper = action === 'link' || action === 'trash' || action === 'version';

  return (
    <Modal
      title="Resolve these duplicates"
      subtitle={`${group.count} files · ${meta.certainty.toLowerCase()}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className={`btn ${action === 'trash' ? 'btn-danger' : 'btn-primary'}`}
            disabled={!action || resolve.isPending}
            onClick={() => resolve.mutate()}
          >
            {resolve.isPending ? <Loader2 size={14} className="spin" /> : null}
            {action === 'trash' ? 'Move them to the bin' : 'Apply'}
          </button>
        </>
      }
    >
      <div className="stack-4">
        <div className={`note ${group.kind === 'IDENTICAL' ? 'neutral' : 'warn'}`}>
          {group.kind === 'IDENTICAL' ? <Info size={15} /> : <AlertTriangle size={15} />}
          <div>{group.reason}</div>
        </div>

        {needsKeeper && (
          <div className="field">
            <label className="label">Which one is the keeper?</label>
            <div className="stack-2">
              {group.members.map((m) => (
                <label
                  key={m.assetId}
                  className="panel"
                  style={{
                    display: 'block', cursor: 'pointer', padding: 12, boxShadow: 'none',
                    borderColor: keepId === m.assetId ? 'var(--indigo)' : 'var(--line)',
                    background: keepId === m.assetId ? 'var(--indigo-soft)' : 'var(--surface)',
                  }}
                >
                  <div className="check">
                    <input
                      type="radio"
                      name="keeper"
                      checked={keepId === m.assetId}
                      onChange={() => setKeepId(m.assetId)}
                      style={{ accentColor: 'var(--indigo)' }}
                    />
                    <span>
                      <span className="label">{m.displayName}</span>
                      <span className="hint">
                        {m.folderName ?? 'Library root'}
                        {m.songTitle && <> · filed under {m.songTitle}</>}
                        {' · '}{bytes(m.sizeBytes)} · added {date(m.createdAt)}
                        {m.assetId === group.suggestedKeepId && ' · best filed, and the oldest'}
                      </span>
                    </span>
                  </div>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <label className="label">What should happen?</label>
          <div className="stack-2">
            {options.map((o) => {
              const Icon = o.icon;
              return (
                <label
                  key={o.action}
                  className="panel"
                  style={{
                    display: 'block', cursor: 'pointer', padding: 14, boxShadow: 'none',
                    borderColor: action === o.action ? 'var(--indigo)' : 'var(--line)',
                    background: action === o.action ? 'var(--indigo-soft)' : 'var(--surface)',
                  }}
                >
                  <div className="check">
                    <input
                      type="radio"
                      name="dedupe-action"
                      checked={action === o.action}
                      onChange={() => setAction(o.action)}
                      style={{ accentColor: 'var(--indigo)' }}
                    />
                    <span>
                      <span className="label row-tight" style={{ color: o.danger ? 'var(--danger-ink)' : undefined }}>
                        <Icon size={14} /> {o.label}
                        {o.recommended && <span className="tag ok">recommended</span>}
                      </span>
                      <span className="hint">{o.hint}</span>
                    </span>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {action === 'trash' && group.kind !== 'IDENTICAL' && (
          <div className="note danger">
            <AlertTriangle size={15} />
            <div>
              <b>These files are not confirmed to be the same.</b> They were grouped because they
              look alike, not because their contents match. Open them side by side before doing this.
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// Emptying the bin is the only way to actually get the space back before Google's own
// 30-day sweep — and the only place in the product that touches files Harmony Hub never
// uploaded, which is why it says so and asks for a typed confirmation.
function EmptyTrashPanel() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const qc = useQueryClient();
  const toast = useToast();

  const empty = useMutation({
    mutationFn: () => api<{ bytesFreed: number | null }>('/dedupe/empty-trash', {
      method: 'POST',
      body: { confirm: 'EMPTY TRASH' },
    }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: 'Bin emptied',
        body: r.bytesFreed ? `${bytes(r.bytesFreed)} freed in Google Drive.` : 'Google Drive has released the space.',
      });
      setOpen(false);
      setTyped('');
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not empty the bin', body: e.message }),
  });

  return (
    <>
      <section className="panel">
        <div className="panel-head"><span className="t-h3 row-tight"><HardDrive size={15} color="var(--ink-3)" /> Get the space back now</span></div>
        <div className="panel-body stack-3">
          <p className="t-body" style={{ fontSize: 13.5, margin: 0, maxWidth: '70ch' }}>
            Removing a duplicate moves it to the Google Drive bin, where it still counts against the
            quota until Google clears it 30 days later. That delay is a safety net worth having — but
            if the Drive is full today, emptying the bin is the only thing that helps today.
          </p>
          <div className="note">
            <AlertTriangle size={15} />
            <div>
              This empties the connected account&rsquo;s <b>entire</b> Drive bin, including files
              Harmony Hub never touched. Nothing in it can be recovered afterwards.
            </div>
          </div>
          <div><button className="btn btn-secondary" onClick={() => setOpen(true)}>Empty the Drive bin…</button></div>
        </div>
      </section>

      {open && (
        <Modal
          title="Empty the Google Drive bin?"
          subtitle="This cannot be undone"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button
                className="btn btn-danger"
                disabled={typed !== 'EMPTY TRASH' || empty.isPending}
                onClick={() => empty.mutate()}
              >
                {empty.isPending ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                Empty it permanently
              </button>
            </>
          }
        >
          <div className="stack-3">
            <div className="note danger">
              <AlertTriangle size={15} />
              <div>
                Everything in the bin is destroyed, including anything binned outside Harmony Hub.
                Files deleted here today would otherwise have stayed recoverable for 30 days.
              </div>
            </div>
            <div className="field">
              <label className="label">Type <span className="keytext">EMPTY TRASH</span> to confirm</label>
              <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
