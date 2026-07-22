import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Link2, ShieldCheck } from 'lucide-react';
import { Modal, CopyButton, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import type { Asset, Share } from '../../lib/types';

const DURATIONS = [
  ['1h', '1 hour'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'],
] as const;

export function ShareDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [expiresIn, setExpiresIn] = useState<string>('7d');
  const [canDownload, setCanDownload] = useState(true);
  const [capped, setCapped] = useState(true);
  const [maxDownloads, setMax] = useState(10);
  const [note, setNote] = useState('');
  const [created, setCreated] = useState<Share | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const create = useMutation({
    mutationFn: () =>
      api<Share>('/shares', {
        method: 'POST',
        body: { assetId: asset.assetId, expiresIn, canDownload, maxDownloads: capped ? maxDownloads : null, note },
      }),
    onSuccess: (s) => {
      setCreated(s);
      qc.invalidateQueries();
      toast({ kind: 'ok', title: 'Link created', body: 'Anyone with the link can open it — no account needed.' });
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not create the link', body: e.message }),
  });

  if (created) {
    return (
      <Modal
        title="Link ready"
        subtitle="Send this to your partner. You can revoke it at any moment."
        onClose={onClose}
        footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}
      >
        <div className="stack-3">
          <div className="note ok">
            <Check size={15} />
            <div>
              Expires {new Date(created.expiresAt).toLocaleString()}
              {created.maxDownloads ? ` · capped at ${created.maxDownloads} downloads` : ' · unlimited downloads'}
              {created.canDownload ? '' : ' · preview only'}
            </div>
          </div>
          <div className="field">
            <label className="label">Share link</label>
            <div className="row-tight">
              <input className="input mono" readOnly value={created.url} onFocus={(e) => e.target.select()} />
              <CopyButton value={created.url} label="Copy" />
            </div>
          </div>
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

  return (
    <Modal
      title="Share outside Maestro"
      subtitle={asset.displayName}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
            <Link2 size={14} /> Create link
          </button>
        </>
      }
    >
      <div className="stack-4">
        <div className="field">
          <label className="label">How long should it work?</label>
          <div className="wrap-gap">
            {DURATIONS.map(([v, l]) => (
              <button key={v} className={`chip ${expiresIn === v ? 'on' : ''}`} onClick={() => setExpiresIn(v)}>{l}</button>
            ))}
          </div>
          <div className="hint">After this, the link stops working on its own. No cleanup needed.</div>
        </div>

        <label className="check">
          <input type="checkbox" checked={canDownload} onChange={(e) => setCanDownload(e.target.checked)} />
          <span>
            <span className="label">Allow downloading</span>
            <span className="hint">Leave this off to let a partner preview the file without keeping a copy.</span>
          </span>
        </label>

        <label className="check">
          <input type="checkbox" checked={capped} onChange={(e) => setCapped(e.target.checked)} />
          <span>
            <span className="label">Limit the number of downloads</span>
            <span className="hint">The link stops working once the cap is reached.</span>
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
          <div className="hint">Only you see this — it appears in your list of links.</div>
        </div>
      </div>
    </Modal>
  );
}
