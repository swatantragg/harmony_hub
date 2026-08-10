// "What kind of file is this?" — the built-in catalogue plus anything the team has
// added, and a way to add one more without leaving the form.
//
// The alternative is worse than an extra dropdown item: when a contract has no matching
// type, someone files it as "Lyrics", and it becomes unfindable for everyone else.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Sparkles, AlertTriangle, X } from 'lucide-react';
import { api } from '../../lib/api';
import { ApiError } from '../../lib/api';
import { useAssetTypes, groupTypes } from '../../lib/vocabulary';
import { useToast } from '../../components/ui';
import type { AssetTypeDef, Family } from '../../lib/types';

const ADD = '__add__';
const FAMILIES: Family[] = ['Audio', 'Video', 'Image', 'Document'];

const FAMILY_HINT: Record<Family, string> = {
  Audio: 'Anything played back — masters, demos, snippets, podcasts.',
  Video: 'Anything with moving picture — reels, music videos, footage.',
  Image: 'Stills — covers, banners, posters, photography.',
  Document: 'Text and paperwork — lyrics, credits, contracts, press kits.',
};

export function TypePicker({
  value, onChange, label = 'What kind of file? *',
}: { value: string; onChange: (type: string) => void; label?: string }) {
  const { data } = useAssetTypes();
  const [adding, setAdding] = useState(false);
  const types = data?.data ?? [];
  const selected = types.find((t) => t.type === value);

  return (
    <>
      <div className="field grow" style={{ minWidth: 190 }}>
        <label className="label">{label}</label>
        <select
          className="select"
          value={value}
          onChange={(e) => {
            if (e.target.value === ADD) { setAdding(true); return; }
            onChange(e.target.value);
          }}
        >
          <option value="">Choose a type…</option>
          {groupTypes(types).map(([family, list]) => (
            <optgroup key={family} label={family}>
              {list.map((t) => (
                <option key={t.type} value={t.type}>{t.type}{t.custom ? ' — added by your team' : ''}</option>
              ))}
            </optgroup>
          ))}
          <option value={ADD}>＋ Add a new type…</option>
        </select>
        <div className="hint">
          {selected
            ? `Filed under ${selected.family}. Drives the icon, the filters it appears under, and its storage tier.`
            : 'Nothing fits? Add your own — it joins the list for everyone.'}
        </div>
      </div>

      {adding && (
        <AddTypeDialog
          onClose={() => setAdding(false)}
          onCreated={(t) => { onChange(t.type); setAdding(false); }}
        />
      )}
    </>
  );
}

function AddTypeDialog({
  onClose, onCreated,
}: { onClose: () => void; onCreated: (t: AssetTypeDef) => void }) {
  const [type, setType] = useState('');
  const [family, setFamily] = useState<Family>('Document');
  const [suggestions, setSuggestions] = useState<AssetTypeDef[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const create = useMutation({
    mutationFn: (force: boolean) =>
      api<AssetTypeDef>('/asset-types', { method: 'POST', body: { type: type.trim(), family, force } }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['asset-types'] });
      toast({
        kind: 'ok',
        title: `“${created.type}” added`,
        body: `It now appears under ${created.family} for everyone on the team.`,
      });
      onCreated(created);
    },
    onError: async (err: unknown) => {
      // The server answers a near-duplicate with 409 and the list it matched against.
      if (err instanceof ApiError && err.status === 409) {
        setConflict(err.message);
        try {
          const r = await api<{ suggestions: AssetTypeDef[] }>(`/asset-types/similar?type=${encodeURIComponent(type.trim())}`);
          setSuggestions(r.suggestions);
        } catch { /* the message alone is enough */ }
        return;
      }
      toast({ kind: 'danger', title: 'Could not add the type', body: err instanceof Error ? err.message : '' });
    },
  });

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal aria-label="Add an asset type">
        <div className="modal-head spread">
          <div>
            <h2 className="t-h2">Add a new type</h2>
            <div className="t-small" style={{ marginTop: 3 }}>
              For files the built-in catalogue does not cover.
            </div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>

        <div className="modal-body stack-4">
          <div className="field">
            <label className="label">What is this kind of file called?</label>
            <input
              className="input"
              value={type}
              autoFocus
              placeholder="e.g. Press Kit, Sync Licence, Tour Poster"
              onChange={(e) => { setType(e.target.value); setConflict(null); setSuggestions([]); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && type.trim()) create.mutate(false); }}
            />
            <div className="hint">Name it the way the team already says it out loud.</div>
          </div>

          <div className="field">
            <label className="label">Which family does it belong to?</label>
            <div className="wrap-gap">
              {FAMILIES.map((f) => (
                <button key={f} type="button" className={`chip ${family === f ? 'on' : ''}`} onClick={() => setFamily(f)}>
                  {f}
                </button>
              ))}
            </div>
            <div className="hint">{FAMILY_HINT[family]}</div>
          </div>

          {conflict && (
            <div className="note">
              <AlertTriangle size={15} />
              <div className="grow">
                <b>That is very close to something already in the list.</b>
                <div style={{ marginTop: 4 }}>{conflict}</div>
                {suggestions.length > 0 && (
                  <div className="wrap-gap" style={{ marginTop: 10 }}>
                    {suggestions.map((s) => (
                      <button key={s.type} className="chip" onClick={() => onCreated(s)}>
                        Use “{s.type}”
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {conflict ? (
            <button className="btn btn-secondary" disabled={create.isPending} onClick={() => create.mutate(true)}>
              Add it anyway
            </button>
          ) : (
            <button className="btn btn-primary" disabled={!type.trim() || create.isPending} onClick={() => create.mutate(false)}>
              <Plus size={14} /> Add type
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export { Sparkles };
