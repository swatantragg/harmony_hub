// Rename — mandatory capability §10.4.
//
// Google Drive addresses a file by an immutable id and treats its name as ordinary
// metadata, so there is exactly one rename here and no fine print. It renames the
// catalogue and the Drive file together, in one request, moves no bytes, and every share
// link keeps resolving — so the dialog's job is only to validate the new name and show
// what will change.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Check, Info, Loader2 } from 'lucide-react';
import { Modal, useDebounced, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import type { Asset } from '../../lib/types';

export function RenameDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [value, setValue] = useState(asset.displayName);
  const [allowExtensionChange, setAllowExt] = useState(false);
  const debounced = useDebounced(value, 220);
  const [check, setCheck] = useState<{ ok: boolean; problems: string[] } | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

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
    onSuccess: (updated: Asset & { renamedInDrive?: boolean }) => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: 'Renamed',
        body: updated.renamedInDrive === false
          ? `Now called ${updated.displayName} here. Google Drive did not accept the rename — the next storage check will retry it.`
          : `Now called ${updated.displayName}, here and in Google Drive. No bytes moved.`,
      });
      onClose();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Rename failed', body: e.message }),
  });

  const ext = useMemo(() => (asset.displayName.match(/\.[^.]+$/) || [''])[0], [asset.displayName]);

  return (
    <Modal
      title="Rename this file"
      subtitle="Renames it here and in Google Drive. The file id never changes, so nothing breaks."
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

            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <div className="grow" style={{ minWidth: 150 }}>
                <div className="t-small">Name in Google Drive</div>
                <div className="t-mono truncate" style={{ color: 'var(--indigo-deep)', fontWeight: 600 }}>
                  {value || '—'}
                </div>
                <div className="hint">Renamed to match, so the Drive folder stays readable.</div>
              </div>
              <div className="grow" style={{ minWidth: 150 }}>
                <div className="t-small">Drive file id — unchanged</div>
                <div className="keytext" style={{ marginTop: 3, display: 'inline-block' }}>{asset.drive.fileId}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="note indigo">
          <Info size={15} />
          <div>
            <b>Nothing moves.</b> Google Drive addresses this file by its id, not its name, so a
            rename is a single metadata update. It finishes in milliseconds whether the file is
            2&nbsp;KB or 40&nbsp;GB, and every existing share link keeps working.
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

      </div>
    </Modal>
  );
}
