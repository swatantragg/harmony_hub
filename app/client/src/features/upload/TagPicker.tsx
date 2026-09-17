import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Tag as TagIcon, Lightbulb, Check, CornerDownLeft, Search } from 'lucide-react';
import { CONTROLLED_TAGS } from '../../lib/assetTypes';
import {
  fetchSimilarTags, registerTag, isNearTag, isSameTag, nearTagConfidence, useTagSections,
} from '../../lib/vocabulary';
import { Select } from '../../components/Select';
import { useDebounced } from '../../components/ui';
import type { TagMatch, TagSection } from '../../lib/vocabulary';

/** Above this many names a section is searched rather than read. Matches the server. */
const SEARCHABLE_AT = 14;

/** How many chips a searched section shows before it asks to be opened out. */
const PREVIEW = 18;

const FALLBACK_SECTIONS: TagSection[] = Object.entries(CONTROLLED_TAGS).map(([group, names]) => ({
  group, names, searchable: names.length > SEARCHABLE_AT,
}));

/**
 * One group of chips. Short groups list every name, the way they always have.
 * Song and Artist run to three figures, so those get a filter box instead — a
 * wall of 139 chips is not a picker, it is a haystack. Whatever is already on
 * the file stays pinned at the front either way, so nothing a person chose can
 * scroll out of sight or be hidden behind a search term.
 */
function Section({
  section, value, onToggle,
}: {
  section: TagSection;
  value: string[];
  onToggle: (tag: string) => void;
}) {
  const [term, setTerm] = useState('');
  const [openedOut, setOpenedOut] = useState(false);
  const searchable = section.searchable || section.names.length > SEARCHABLE_AT;

  const selected = useMemo(
    () => section.names.filter((n) => value.some((v) => isSameTag(v, n))),
    [section.names, value],
  );

  const rest = useMemo(() => {
    const chosen = new Set(selected.map((s) => s.toLowerCase()));
    const q = term.trim().toLowerCase();
    return section.names.filter(
      (n) => !chosen.has(n.toLowerCase()) && (!q || n.toLowerCase().includes(q)),
    );
  }, [section.names, selected, term]);

  const truncated = searchable && !openedOut && !term.trim() && rest.length > PREVIEW;
  const shown = truncated ? rest.slice(0, PREVIEW) : rest;

  const chip = (t: string) => (
    <button
      key={t}
      type="button"
      className={`chip ${value.some((v) => isSameTag(v, t)) ? 'on' : ''}`}
      onClick={() => onToggle(t)}
      aria-pressed={value.some((v) => isSameTag(v, t))}
    >
      {t}
    </button>
  );

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', gap: 10, marginBottom: 7 }}>
        <div className="eyebrow">
          {section.group}
          {searchable && <span style={{ opacity: 0.7 }}> · {section.names.length}</span>}
        </div>
        {searchable && (
          <div className="row-tight">
            <Search size={13} color="var(--ink-3)" />
            <input
              className="input"
              style={{ maxWidth: 190, padding: '6px 9px' }}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder={`Search ${section.group.toLowerCase()}…`}
              aria-label={`Search ${section.group} tags`}
            />
          </div>
        )}
      </div>

      <div className="wrap-gap">
        {selected.map(chip)}
        {shown.map(chip)}
        {truncated && (
          <button type="button" className="chip chip-static" onClick={() => setOpenedOut(true)}>
            Show all {rest.length}
          </button>
        )}
        {openedOut && !term.trim() && (
          <button type="button" className="chip chip-static" onClick={() => setOpenedOut(false)}>
            Show fewer
          </button>
        )}
      </div>

      {searchable && term.trim() && rest.length === 0 && selected.length === 0 && (
        <div className="hint" style={{ marginTop: 7 }}>
          Nothing in {section.group} matches “{term.trim()}”. Add it below and choose
          {' '}{section.group} as its section, and it joins this list for everyone.
        </div>
      )}
    </div>
  );
}

export function TagPicker({
  value, onChange, required = false, label = 'Tags', hint, knownTags = [],
}: {
  value: string[];
  onChange: (next: string[]) => void;
  required?: boolean;
  label?: string;
  hint?: string;
  knownTags?: string[];
}) {
  const [custom, setCustom] = useState('');
  const [section, setSection] = useState('');
  const [libraryExact, setLibraryExact] = useState<string | null>(null);
  const [librarySimilar, setLibrarySimilar] = useState<TagMatch[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const debounced = useDebounced(custom, 240);
  const qc = useQueryClient();

  const { data: served } = useTagSections();
  const sections = served?.length ? served : FALLBACK_SECTIONS;

  const controlled = useMemo(() => sections.flatMap((s) => s.names), [sections]);

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

  const toggle = (t: string) => (
    value.some((v) => isSameTag(v, t))
      ? onChange(value.filter((x) => !isSameTag(x, t)))
      : onChange([...value, t])
  );

  const use = (name: string) => {
    if (!value.some((v) => isSameTag(v, name))) onChange([...value, name]);
    setCustom('');
    setLibraryExact(null);
    setLibrarySimilar([]);
    setAcknowledged(false);
  };

  const addCustom = () => {
    if (!term) return;
    if (exact) { use(exact); return; }
    if (suggestions.length > 0 && !acknowledged) { setAcknowledged(true); return; }
    void registerTag(term, suggestions.length > 0, section).then(() => {
      // A tag filed into a section has to show up as a chip in it, here and for
      // everybody else, so the list it joined is no longer the one we fetched.
      if (section) void qc.invalidateQueries({ queryKey: ['tag-sections'] });
    });
    use(term);
  };

  const customTags = value.filter((t) => !controlled.some((c) => isSameTag(c, t)));

  const sectionOptions = useMemo(
    () => [
      { value: '', label: 'No section', hint: 'Stands on its own, as before' },
      ...sections.map((s) => ({ value: s.group, label: s.group })),
    ],
    [sections],
  );

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

      {sections.map((s) => (
        <Section key={s.group} section={s} value={value} onToggle={toggle} />
      ))}

      <div>
        <div className="eyebrow" style={{ marginBottom: 7 }}>Custom tag</div>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ maxWidth: 260 }}
            value={custom}
            onChange={(e) => { setCustom(e.target.value); setAcknowledged(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
            placeholder="e.g. Launch Week"
            aria-describedby="tag-suggestions"
          />
          <Select
            value={section}
            onChange={setSection}
            options={sectionOptions}
            placeholder="No section"
            ariaLabel="Which section this tag joins"
            style={{ maxWidth: 190 }}
          />
          <button type="button" className="btn btn-secondary btn-sm" onClick={addCustom} disabled={!term}>
            <Plus size={13} /> Add
          </button>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          {section
            ? `Optional. “${term || 'It'}” joins the ${section} list above, for everyone, not just this file.`
            : 'Optional. Pick a section and the tag joins that list for everyone — leave it blank and it stays a one-off.'}
        </div>

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
              meaning the same thing, so GCloud will use the existing one.
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
