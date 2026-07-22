// Rename — mandatory capability §10.4, and the clearest place to teach the product's
// central idea: the human name and the stored object are two different things.
//
// The dialog validates as you type, shows exactly what the file will download as, and
// states plainly that no bytes move. Physical re-key is a separate, Admin-only step,
// deliberately behind a disclosure so nobody reaches for it by accident.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Check, ChevronDown, Info, Loader2 } from 'lucide-react';
import { Modal, useDebounced, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import type { Asset } from '../../lib/types';
import { useSession } from '../../app/session';

export function RenameDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [value, setValue] = useState(asset.displayName);
  const [allowExtensionChange, setAllowExt] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [newKey, setNewKey] = useState(asset.s3.key);
  const debounced = useDebounced(value, 220);
  const [check, setCheck] = useState<{ ok: boolean; problems: string[] } | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const can = useSession((s) => s.can);

  // Live preflight against the same validator the server will run.
  useEffect(() => {
    if (debounced === asset.displayName) { setCheck({ ok: true, problems: [] }); return; }
    let alive = true;
    api<{ ok: boolean; problems: string[] }>(`/assets/${asset.assetId}/rename/check`, {
      method: 'POST',
      body: { displayName: debounced, allowExtensionChange },
    })
      .then((r) => alive && setCheck(r))
      .catch(() => {});
    return () => { alive = false; };
  }, [debounced, allowExtensionChange, asset.assetId, asset.displayName]);

  const unchanged = value.trim() === asset.displayName;
  const ready = Boolean(check?.ok) && !unchanged;

  const rename = useMutation({
    mutationFn: () =>
      api<Asset>(`/assets/${asset.assetId}/rename`, {
        method: 'PATCH',
        body: { displayName: value.trim(), allowExtensionChange },
      }),
    onSuccess: (updated) => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: 'Renamed',
        body: `Now called ${updated.displayName}. No file was moved — links and shares still work.`,
      });
      onClose();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Rename failed', body: e.message }),
  });

  const rekey = useMutation({
    mutationFn: () => api(`/assets/${asset.assetId}/rekey`, { method: 'POST', body: { newKey } }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({
        kind: 'info',
        title: 'Re-key queued',
        body: 'The file is being copied and verified before the original is removed. You will be notified.',
      });
      onClose();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Re-key rejected', body: e.message }),
  });

  const ext = useMemo(() => (asset.displayName.match(/\.[^.]+$/) || [''])[0], [asset.displayName]);

  return (
    <Modal
      title="Rename this file"
      subtitle="Changes what people see and download. The stored object stays exactly where it is."
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || rename.isPending} onClick={() => rename.mutate()}>
            {rename.isPending ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            Rename
          </button>
        </>
      }
    >
      <div className="stack-4">
        <div className="field">
          <label className="label" htmlFor="rename-input">New name</label>
          <input
            id="rename-input"
            className={`input mono ${check && !check.ok ? 'invalid' : check?.ok && !unchanged ? 'valid' : ''}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            onFocus={(e) => {
              // Select the stem, not the extension — the common case is editing the name.
              const dot = e.target.value.lastIndexOf('.');
              if (dot > 0) e.target.setSelectionRange(0, dot);
            }}
          />
          {check && check.problems.length > 0 ? (
            <div className="stack-2" style={{ marginTop: 2 }}>
              {check.problems.map((p) => (
                <div key={p} className="row-tight t-small" style={{ color: 'var(--danger-ink)' }}>
                  <AlertTriangle size={13} /> {p}
                </div>
              ))}
            </div>
          ) : (
            <div className="hint">
              Letters, numbers, spaces, dots, dashes and underscores. Keep the <code className="keytext">{ext}</code> extension so the file still opens.
            </div>
          )}
        </div>

        {/* What actually changes — stated as a before/after so there is no ambiguity. */}
        <div className="panel" style={{ background: 'var(--surface-2)', boxShadow: 'none' }}>
          <div className="panel-body stack-3" style={{ padding: 16 }}>
            <div className="row-tight eyebrow"><Info size={12} /> What changes</div>

            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <div className="grow" style={{ minWidth: 150 }}>
                <div className="t-small">Downloads as, before</div>
                <div className="t-mono truncate" title={asset.displayName}>{asset.displayName}</div>
              </div>
              <ArrowRight size={16} color="var(--ink-3)" />
              <div className="grow" style={{ minWidth: 150 }}>
                <div className="t-small">Downloads as, after</div>
                <div className="t-mono truncate" style={{ color: 'var(--indigo-deep)', fontWeight: 600 }} title={value}>
                  {value || '—'}
                </div>
              </div>
            </div>

            <div>
              <div className="t-small">Stored object — unchanged</div>
              <div className="keytext" style={{ marginTop: 3, display: 'inline-block' }}>{asset.s3.key}</div>
            </div>
          </div>
        </div>

        <div className="note indigo">
          <Info size={15} />
          <div>
            <b>Nothing moves.</b> Renaming updates the catalogue and refreshes the object’s stored
            metadata. It finishes in milliseconds whether the file is 2&nbsp;KB or 40&nbsp;GB, and every
            existing share link keeps working.
          </div>
        </div>

        {check && check.problems.some((p) => p.includes('extension')) && (
          <label className="check">
            <input type="checkbox" checked={allowExtensionChange} onChange={(e) => setAllowExt(e.target.checked)} />
            <span>
              <span className="label">Change the extension anyway</span>
              <span className="hint">
                The file’s contents do not change, so an extension that does not match the real format
                will make it open incorrectly. Only do this to fix a wrong extension.
              </span>
            </span>
          </label>
        )}

        {/* Physical re-key — Admin only, and deliberately out of the way. */}
        {can('asset:rekey') && (
          <div>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowAdvanced((v) => !v)} style={{ paddingLeft: 0 }}>
              <ChevronDown size={14} style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
              Also move the stored object (advanced)
            </button>

            {showAdvanced && (
              <div className="stack-3" style={{ marginTop: 12 }}>
                <div className="note">
                  <AlertTriangle size={15} />
                  <div>
                    <b>You almost certainly do not need this.</b> Moving the object copies every byte to a
                    new location, verifies it independently, and only then removes the original. It is for
                    the rare case where an outside system reads the bucket directly and depends on the key.
                  </div>
                </div>
                <div className="field">
                  <label className="label">New object key</label>
                  <input className="input mono" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
                  <div className="hint">Must start with <code className="keytext">assets/</code>. Runs in the background; the file is locked until it finishes.</div>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={newKey === asset.s3.key || rekey.isPending}
                  onClick={() => rekey.mutate()}
                >
                  Queue the move
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
