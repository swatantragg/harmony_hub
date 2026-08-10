import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Link2, ShieldCheck, Globe, PenLine, UserCheck, X, Eye } from 'lucide-react';
import { Modal, CopyButton, useToast } from '../../components/ui';
import { FilePreview } from '../preview/FilePreview';
import { api } from '../../lib/api';
import { bytes } from '../../lib/format';
import type { Asset, Folder, Share, ShareAudience } from '../../lib/types';

const DURATIONS = [
  ['1h', '1 hour'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'],
] as const;

// The three link types. Each one answers a different question — who may open this, and
// what may they do once it is open — and the server enforces both on every request.
const AUDIENCES: { value: ShareAudience; label: string; icon: typeof Globe; blurb: string }[] = [
  {
    value: 'PUBLIC',
    label: 'Open to all',
    icon: Globe,
    blurb: 'No account, no sign-in.',
  },
  {
    value: 'EDITOR',
    label: 'Editor',
    icon: PenLine,
    blurb: 'Signs in first, then gets edit rights — not just a download.',
  },
  {
    value: 'RESTRICTED',
    label: 'Specific allocation',
    icon: UserCheck,
    blurb: 'Only the people named below, after signing in.',
  },
];

type Target =
  | { kind: 'asset'; asset: Asset }
  | { kind: 'folder'; folder: Folder };

export function ShareDialog({
  asset, folder, onClose,
}: { asset?: Asset; folder?: Folder; onClose: () => void }) {
  const target: Target | null = asset ? { kind: 'asset', asset } : folder ? { kind: 'folder', folder } : null;

  const [audience, setAudience] = useState<ShareAudience>('PUBLIC');
  const [emails, setEmails] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [expiresIn, setExpiresIn] = useState<string>('7d');
  const [canDownload, setCanDownload] = useState(true);
  const [capped, setCapped] = useState(true);
  const [maxDownloads, setMax] = useState(10);
  const [note, setNote] = useState('');
  const [created, setCreated] = useState<Share | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const create = useMutation({
    mutationFn: () =>
      api<Share>('/shares', {
        method: 'POST',
        body: {
          target: target?.kind === 'folder' ? 'FOLDER' : 'ASSET',
          targetId: target?.kind === 'folder' ? target.folder._id : target?.asset.assetId,
          audience,
          allowedEmails: audience === 'RESTRICTED' ? emails : [],
          expiresIn,
          canDownload,
          maxDownloads: capped ? maxDownloads : null,
          note,
        },
      }),
    onSuccess: (s) => {
      setCreated(s);
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: 'Link created',
        body: s.audience === 'PUBLIC'
          ? 'Anyone with the link can open it — no account needed.'
          : 'The recipient must sign in before the link resolves.',
      });
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not create the link', body: e.message }),
  });

  // Preview before sending. The same signed-URL path the recipient will travel, so what is
  // checked here is the actual file, not a thumbnail of it.
  const openPreview = async () => {
    setPreviewing(true);
    if (previewUrl || target?.kind !== 'asset') return;
    try {
      const r = await api<{ url: string }>(`/assets/${target.asset.assetId}/preview`, { method: 'POST' });
      setPreviewUrl(r.url);
    } catch {
      /* the preview panel states its own failure */
    }
  };

  const addEmail = () => {
    const value = emailDraft.trim().toLowerCase();
    if (!value) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      toast({ kind: 'warn', title: 'That does not look like an email address', body: value });
      return;
    }
    if (!emails.includes(value)) setEmails([...emails, value]);
    setEmailDraft('');
  };

  if (!target) return null;
  const name = target.kind === 'folder' ? target.folder.name : target.asset.displayName;
  const subtitle = target.kind === 'folder'
    ? `${target.folder.assetCount} files · ${bytes(target.folder.totalBytes)}`
    : name;

  /* ── Preview step ─────────────────────────────────────────────────────── */
  if (previewing && target.kind === 'asset') {
    return (
      <Modal
        title="Check before you send"
        subtitle={name}
        width="wide"
        onClose={() => setPreviewing(false)}
        footer={<button className="btn btn-primary" onClick={() => setPreviewing(false)}>Back to the link options</button>}
      >
        <FilePreview
          url={previewUrl}
          file={{
            displayName: target.asset.displayName,
            mimeType: target.asset.mimeType,
            sizeBytes: target.asset.drive.sizeBytes,
            durationSec: target.asset.durationSec,
            dimensions: target.asset.dimensions,
            seed: target.asset.assetId,
          }}
          height={380}
        />
      </Modal>
    );
  }

  /* ── Result step ──────────────────────────────────────────────────────── */
  if (created) {
    return (
      <Modal
        title="Link ready"
        subtitle="Send this to your recipient. You can revoke it at any moment."
        onClose={onClose}
        footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}
      >
        <div className="stack-3">
          <div className="note ok">
            <Check size={15} />
            <div>
              <b>{created.audienceLabel}</b> · expires {new Date(created.expiresAt).toLocaleString()}
              {created.maxDownloads ? ` · capped at ${created.maxDownloads} downloads` : ' · unlimited downloads'}
              {created.canDownload ? '' : ' · preview only'}
              {created.target === 'FOLDER' ? ` · ${created.fileCount} files` : ''}
            </div>
          </div>
          <div className="field">
            <label className="label">Share link</label>
            <div className="row-tight">
              <input className="input mono" readOnly value={created.url} onFocus={(e) => e.target.select()} />
              <CopyButton value={created.url} label="Copy" />
            </div>
            <div className="hint">A Harmony Hub address, not a storage address. Revocable at any time.</div>
          </div>
          {created.audience === 'RESTRICTED' && (
            <div className="note neutral">
              <UserCheck size={15} />
              <div>Only {emails.join(', ')} can open this, and only after signing in.</div>
            </div>
          )}
          <div className="note indigo">
            <ShieldCheck size={15} />
            <div>
              Every open is recorded with time and IP address, and the link checks that the file is
              still really in storage before handing anything over.
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  /* ── Compose step ─────────────────────────────────────────────────────── */
  return (
    <Modal
      title={target.kind === 'folder' ? 'Share this folder outside Harmony Hub' : 'Share outside Harmony Hub'}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {target.kind === 'asset' && (
            <button className="btn btn-secondary" onClick={openPreview}><Eye size={14} /> Preview first</button>
          )}
          <button
            className="btn btn-primary"
            disabled={create.isPending || (audience === 'RESTRICTED' && emails.length === 0)}
            onClick={() => create.mutate()}
          >
            <Link2 size={14} /> Create link
          </button>
        </>
      }
    >
      <div className="stack-4">
        <div className="field">
          <label className="label">Who is this link for?</label>
          <div className="stack-2">
            {AUDIENCES.map(({ value, label, icon: Icon, blurb }) => (
              <button
                key={value}
                className={`choice ${audience === value ? 'on' : ''}`}
                onClick={() => setAudience(value)}
                type="button"
              >
                <span className="choice-mark"><Icon size={15} /></span>
                <span>
                  <span className="label">{label}</span>
                  <span className="hint">{blurb}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {audience === 'RESTRICTED' && (
          <div className="field">
            <label className="label">Who exactly?</label>
            <div className="row-tight">
              <input
                className="input"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addEmail(); } }}
                placeholder="name@label.com"
                aria-label="Recipient email"
              />
              <button className="btn btn-secondary" type="button" onClick={addEmail}>Add</button>
            </div>
            {emails.length > 0 && (
              <div className="wrap-gap" style={{ marginTop: 8 }}>
                {emails.map((e) => (
                  <span key={e} className="tag">
                    {e}
                    <button
                      className="btn btn-ghost btn-icon"
                      style={{ width: 16, height: 16, marginLeft: 4 }}
                      onClick={() => setEmails(emails.filter((x) => x !== e))}
                      aria-label={`Remove ${e}`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="hint">Each opens with their own account, so the log names them.</div>
          </div>
        )}

        {target.kind === 'folder' && (
          <div className="note indigo">
            <ShieldCheck size={15} />
            <div>
              <b>{target.folder.assetCount} files, each preview-able and downloadable on its own.</b> Nothing
              is zipped or copied — the link always shows what is in the folder right now.
            </div>
          </div>
        )}

        <div className="field">
          <label className="label">How long should it work?</label>
          <div className="wrap-gap">
            {DURATIONS.map(([v, l]) => (
              <button key={v} className={`chip ${expiresIn === v ? 'on' : ''}`} onClick={() => setExpiresIn(v)}>{l}</button>
            ))}
          </div>
          <div className="hint">The link stops working on its own.</div>
        </div>

        <label className="check">
          <input type="checkbox" checked={canDownload} onChange={(e) => setCanDownload(e.target.checked)} />
          <span>
            <span className="label">Allow downloading</span>
            <span className="hint">Off = preview only, no copy kept.</span>
          </span>
        </label>

        <label className="check">
          <input type="checkbox" checked={capped} onChange={(e) => setCapped(e.target.checked)} />
          <span>
            <span className="label">Limit the number of downloads</span>
            <span className="hint">
              {target.kind === 'folder' ? 'Counts files, not clicks.' : 'Stops working once the cap is reached.'}
            </span>
          </span>
        </label>

        {capped && (
          <div className="field" style={{ maxWidth: 160 }}>
            <label className="label">Maximum downloads</label>
            <input
              className="input"
              type="number"
              min={1}
              max={999}
              value={maxDownloads}
              onChange={(e) => setMax(Number(e.target.value))}
            />
          </div>
        )}

        <div className="field">
          <label className="label">Note to yourself (optional)</label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Sent to Spotify editorial" />
          <div className="hint">Only you see this.</div>
        </div>
      </div>
    </Modal>
  );
}
