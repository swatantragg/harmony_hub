// Tagging is a required, friendly step — good search depends on good tags, so the
// controlled vocabulary is presented as one-click chips rather than a text field.
//
// The custom-tag field checks two vocabularies as you type:
//   · the library — every tag already attached to a file, fetched from the server;
//   · this session — tags typed on the other files in front of you but not yet uploaded.
// The second half matters more than it sounds. Without it, a tag added to one file is
// invisible to the check on the next, and "aloo wada" plus "Aloo Wada" both get created
// inside a single upload batch.
import { useEffect, useMemo, useState } from 'react';
import { Plus, Tag as TagIcon, Lightbulb, Check, CornerDownLeft } from 'lucide-react';
import { CONTROLLED_TAGS } from '../../lib/assetTypes';
import {
  fetchSimilarTags, registerTag, isNearTag, isSameTag, nearTagConfidence,
} from '../../lib/vocabulary';
import { useDebounced } from '../../components/ui';
import type { TagMatch } from '../../lib/vocabulary';

export function TagPicker({
  value, onChange, required = false, label = 'Tags', hint, knownTags = [],
}: {
  value: string[];
  onChange: (next: string[]) => void;
  required?: boolean;
  label?: string;
  hint?: string;
  // Tags in play elsewhere in this session — other files in the upload queue, the folder
  // being edited, and so on. Checked alongside the persisted library.
  knownTags?: string[];
}) {
  const [custom, setCustom] = useState('');
  const [libraryExact, setLibraryExact] = useState<string | null>(null);
  const [librarySimilar, setLibrarySimilar] = useState<TagMatch[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const debounced = useDebounced(custom, 240);

  const controlled = useMemo(() => Object.values(CONTROLLED_TAGS).flat(), []);

  // Everything this browser already knows about, without a round trip.
  const sessionPool = useMemo(
    () => [...new Set([...knownTags, ...value, ...controlled])],
    [knownTags, value, controlled],
  );

  useEffect(() => {
    const term = debounced.trim();
    if (term.length < 2) { setLibraryExact(null); setLibrarySimilar([]); return; }
    let alive = true;
    fetchSimilarTags(term)
      .then((r) => {
        if (!alive) return;
        setLibraryExact(r.exact?.name ?? null);
        setLibrarySimilar(
          r.suggestions.map((s) => ({
            name: s.name,
            usageCount: s.usageCount,
            source: 'library' as const,
            applied: value.some((v) => isSameTag(v, s.name)),
            confidence: s.confidence,
          })),
        );
        setAcknowledged(false);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [debounced]);

  const term = custom.trim();

  // An exact match — same tag, different spelling — from either vocabulary.
  const exact = useMemo(() => {
    if (term.length < 1) return null;
    return sessionPool.find((t) => isSameTag(t, term)) ?? libraryExact;
  }, [term, sessionPool, libraryExact]);

  const suggestions = useMemo(() => {
    if (term.length < 2 || exact) return [];
    const byKey = new Map<string, TagMatch>();
    for (const m of librarySimilar) byKey.set(m.name.toLowerCase(), m);
    for (const name of sessionPool) {
      if (!isNearTag(term, name)) continue;
      const key = name.toLowerCase();
      if (byKey.has(key)) continue;
      byKey.set(key, {
        name,
        usageCount: null,
        source: 'session',
        applied: value.some((v) => isSameTag(v, name)),
        confidence: nearTagConfidence(term, name),
      });
    }
    return [...byKey.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 6);
  }, [term, exact, librarySimilar, sessionPool, value]);

  const exactApplied = Boolean(exact && value.some((v) => isSameTag(v, exact)));

  const toggle = (t: string) => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t]);

  const use = (name: string) => {
    if (!value.some((v) => isSameTag(v, name))) onChange([...value, name]);
    setCustom('');
    setLibraryExact(null);
    setLibrarySimilar([]);
    setAcknowledged(false);
  };

  const addCustom = () => {
    if (!term) return;
    // A different spelling of a tag that already exists always resolves to that tag.
    if (exact) { use(exact); return; }
    // Close matches are surfaced once; a second press means the author meant it.
    if (suggestions.length > 0 && !acknowledged) { setAcknowledged(true); return; }
    // Register it straight away so the very next file sees it in the duplicate check.
    void registerTag(term, suggestions.length > 0);
    use(term);
  };

  const customTags = value.filter((t) => !controlled.includes(t));

  return (
    <div className="stack-3">
      <div>
        <div className="row-tight">
          <TagIcon size={13} color="var(--ink-3)" />
          <span className="label">{label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}</span>
        </div>
        <div className="hint">
          {hint ?? (
            <>
              {required ? 'Pick at least one. ' : 'Optional, but worth it. '}
              Tags are how everyone else will find this later —
              {' '}{value.length === 0 ? 'nothing selected yet' : `${value.length} selected`}.
            </>
          )}
        </div>
      </div>

      {Object.entries(CONTROLLED_TAGS).map(([group, names]) => (
        <div key={group}>
          <div className="eyebrow" style={{ marginBottom: 7 }}>{group}</div>
          <div className="wrap-gap">
            {names.map((t) => (
              <button
                key={t}
                type="button"
                className={`chip ${value.includes(t) ? 'on' : ''}`}
                onClick={() => toggle(t)}
                aria-pressed={value.includes(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div>
        <div className="eyebrow" style={{ marginBottom: 7 }}>Custom tag</div>
        <div className="row-tight">
          <input
            className="input"
            style={{ maxWidth: 260 }}
            value={custom}
            onChange={(e) => { setCustom(e.target.value); setAcknowledged(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
            placeholder="e.g. Launch Week"
            aria-describedby="tag-suggestions"
          />
          <button type="button" className="btn btn-secondary btn-sm" onClick={addCustom} disabled={!term}>
            <Plus size={13} /> Add
          </button>
        </div>

        {/* Same tag, different spelling. Two cases: already on this file, or in the
            vocabulary but not yet applied here. */}
        {exact && exactApplied && (
          <div className="note ok" id="tag-suggestions" style={{ marginTop: 10 }}>
            <Check size={15} />
            <div className="grow">
              <b>“{exact}” is already on this file.</b> Nothing more to do — a second spelling
              of it would split every future search for this tag in two.
            </div>
          </div>
        )}

        {exact && !exactApplied && (
          <div className="note indigo" id="tag-suggestions" style={{ marginTop: 10 }}>
            <Check size={15} />
            <div className="grow">
              <b>“{exact}” already exists.</b> Adding it as written would create a second tag
              meaning the same thing, so Harmony Hub will use the existing one.
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => use(exact)}>
              Use “{exact}”
            </button>
          </div>
        )}

        {!exact && suggestions.length > 0 && (
          <div className="note" id="tag-suggestions" style={{ marginTop: 10 }}>
            <Lightbulb size={15} />
            <div className="grow">
              <b>Did you mean one of these?</b> Reusing an existing tag keeps searches
              consistent for everyone.
              <div className="wrap-gap" style={{ marginTop: 9 }}>
                {suggestions.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    className={`chip ${s.applied ? 'on' : ''}`}
                    onClick={() => use(s.name)}
                    title={s.applied ? 'Already on this file' : undefined}
                  >
                    {s.name}
                    <span className="count">
                      {s.applied
                        ? 'on this file'
                        : s.usageCount
                          ? `${s.usageCount} ${s.usageCount === 1 ? 'use' : 'uses'}`
                          : 'new this session'}
                    </span>
                  </button>
                ))}
              </div>
              {acknowledged && (
                <div className="t-small row-tight" style={{ marginTop: 9 }}>
                  <CornerDownLeft size={12} />
                  Still want a separate tag? Press <b>Add</b> once more to create “{term}”.
                </div>
              )}
            </div>
          </div>
        )}

        {customTags.length > 0 && (
          <div className="wrap-gap" style={{ marginTop: 10 }}>
            {customTags.map((t) => (
              <button key={t} type="button" className="chip on" onClick={() => toggle(t)}>{t} ✕</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
